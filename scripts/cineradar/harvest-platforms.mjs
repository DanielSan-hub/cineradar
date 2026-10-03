// Daily platform connectors: Festhome and FestAgent (robots.txt allows both;
// FilmFreeway is never used). Each lists open festivals sorted by their next
// deadline, so the listing is read until the cards stop showing a future date.
// Only new or changed cards are opened; each festival page yields a record
// (final submission deadline, the festival's own website) through the usual
// normalization, and the festival's own website joins the registry as a
// monitored series source. One request per 1-1.5 s; no LLM, no paid service.
//
// FestAgent asks for a link to the source wherever its information is used:
// its records keep the FestAgent page as source and deadline source, and
// never use it as an application link.
//
//   node scripts/cineradar/harvest-platforms.mjs           # dry run
//   node scripts/cineradar/harvest-platforms.mjs --apply   # write
//   PLATFORMS=festagent node scripts/cineradar/harvest-platforms.mjs

import { createHash } from "node:crypto";

import { dedupeOpportunitiesDetailed } from "./normalization.mjs";
import { persistProvenance, withProvenance } from "./operations.mjs";
import {
  FESTAGENT_LISTING,
  festagentDetailUrl,
  festagentListingPage,
  festagentRawItem,
  FESTHOME_LISTING,
  festhomeDetailUrl,
  festhomeListingPage,
  festhomeRawItem,
  parseFestagentListing,
  parseFesthomeListing,
} from "./platform-connectors.mjs";
import { processFetchedPage } from "./process-page.mjs";
import { hostOf, isPlatformHost } from "./registry-seeds.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { finishRun, ingest, startRun, supabase } from "./supabase.mjs";
import { createRunMetrics, incrementMetric, metricsRunPatch, recordRejection, summarizeMetrics } from "./telemetry.mjs";
import { fetchPage } from "./web-validation.mjs";

const apply = process.argv.includes("--apply");
const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};
const deadlineAt = Date.now() + number("PLATFORM_TIME_BUDGET_SECONDS", 600) * 1000;
const UA = "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)";
const robots = createRobotsChecker({ userAgent: UA });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metrics = createRunMetrics("discovery");
const now = Date.now();
const isFuture = (date) => Date.parse(`${date}T23:59:59Z`) >= now;

const PLATFORMS = {
  festhome: {
    name: "Festhome",
    sourceUrl: "https://festhome.com/festivals",
    sourceName: "Festhome Festivals",
    listing: FESTHOME_LISTING,
    maxPages: number("FESTHOME_LISTING_PAGES", 150),
    detailLimit: number("FESTHOME_DETAIL_LIMIT", 300),
    pauseMs: 1000,
    // Later pages are the listing's own AJAX fragments (12 cards each).
    listingRequest: (page) => ({ url: page === 1 ? FESTHOME_LISTING : festhomeListingPage(page), headers: page > 1 ? { "X-Requested-With": "XMLHttpRequest" } : {} }),
    parseListing: (html) => ({ cards: parseFesthomeListing(html), total: NaN }),
    detailUrl: (card) => festhomeDetailUrl(card.id),
    rawItem: festhomeRawItem,
    // Only the websites of festivals opened in detail are known.
    websitesFromListing: false,
  },
  festagent: {
    name: "FestAgent",
    sourceUrl: FESTAGENT_LISTING,
    sourceName: "FestAgent Festivals",
    listing: FESTAGENT_LISTING,
    maxPages: number("FESTAGENT_LISTING_PAGES", 60),
    detailLimit: number("FESTAGENT_DETAIL_LIMIT", 150),
    pauseMs: 1500,
    // The free default listing only (no cookies, no subscription filters).
    listingRequest: (page) => ({ url: festagentListingPage(page), headers: {} }),
    parseListing: parseFestagentListing,
    detailUrl: (card) => festagentDetailUrl(card.slug),
    rawItem: festagentRawItem,
    // Every card names the festival's own website: registered for free,
    // including closed festivals (their next edition is announced there).
    websitesFromListing: true,
  },
};
// Festhome data is team-only (owner decision 2026-10-03): its records are
// never published (isTeamOnlyRecord), as its terms forbid republication.
const selected = String(process.env.PLATFORMS ?? "festhome,festagent").split(",").map((value) => value.trim()).filter((key) => PLATFORMS[key]);

async function platformSource(platform) {
  const [row] = await supabase(`sources?select=id,url,adapter_config&url=eq.${encodeURIComponent(platform.sourceUrl)}&limit=1`);
  if (row || !apply) return row ?? { id: null, url: platform.sourceUrl, adapter_config: {} };
  // The connector's own registry row (holds its listing state). Disabled: the
  // monitor never reads it, only this connector does.
  const [created] = await supabase("sources?on_conflict=url", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify([{
      name: platform.sourceName,
      url: platform.sourceUrl,
      enabled: false,
      tier: 1,
      priority: 2,
      source_type: "community",
      source_family: "structured-festival",
      opportunity_categories: ["film-festival"],
      adapter: "platform-connector",
      adapter_config: { checkpoint_key: "default", platform_state: {} },
    }]),
  });
  return created;
}

async function knownHosts(hosts) {
  const known = new Set();
  for (let index = 0; index < hosts.length; index += 100) {
    const batch = hosts.slice(index, index + 100);
    const rows = await supabase(`sources?select=url&or=(${batch.map((host) => `url.ilike.*${encodeURIComponent(host)}*`).join(",")})`).catch(() => []);
    for (const row of rows) known.add(hostOf(row.url));
  }
  return known;
}

function websiteSource(site, platform) {
  return {
    name: site.name.slice(0, 200),
    url: site.url,
    tier: 2,
    priority: site.ai ? 1 : 2,
    source_type: "official",
    source_family: site.ai ? "ai-creative-tech" : "official-site",
    opportunity_categories: site.ai ? ["ai-film"] : ["film-festival"],
    adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 6, seed: `platform:${platform}` },
    min_poll_interval_minutes: 360,
    poll_interval_minutes: 1_440,
    max_poll_interval_minutes: 10_080,
    next_check_at: new Date().toISOString(),
  };
}

const run = apply ? await startRun("discovery") : { id: null };
const report = { mode: apply ? "apply" : "dry-run", platforms: {} };
const records = [];

for (const key of selected) {
  const platform = PLATFORMS[key];
  const summary = { listingPages: 0, listedCards: 0, openCards: 0, changedCards: 0, detailsFetched: 0, records: 0, websitesListed: 0, newSources: 0, stoppedByTimeBudget: false };
  report.platforms[key] = summary;
  if (!(await robots(platform.listing)).allowed) {
    summary.error = "robots.txt disallows the listing";
    continue;
  }
  const source = await platformSource(platform);
  const state = { ...(source?.adapter_config?.platform_state ?? {}) };

  // 1. Listing: open festivals first, sorted by the next deadline.
  const cards = [];
  const websites = new Map();
  const seen = new Set();
  let pagesWithoutFuture = 0;
  let lastPage = platform.maxPages;
  for (let page = 1; page <= Math.min(platform.maxPages, lastPage) && Date.now() < deadlineAt; page += 1) {
    const request = platform.listingRequest(page);
    let parsed = { cards: [], total: NaN };
    try {
      const response = await fetch(request.url, { headers: { "user-agent": UA, ...request.headers } });
      if (response.ok) parsed = platform.parseListing(await response.text());
    } catch {
      recordRejection(metrics, "PLATFORM_LISTING_FAILED");
    }
    summary.listingPages += 1;
    if (page === 1 && !parsed.cards.length) {
      summary.error = "the first listing page gave no cards (markup changed?)";
      break;
    }
    if (page === 1 && Number.isFinite(parsed.total) && parsed.total > 0) lastPage = Math.ceil(parsed.total / Math.max(1, parsed.cards.length));
    const unseen = parsed.cards.filter((card) => !seen.has(card.id));
    for (const card of unseen) {
      seen.add(card.id);
      summary.listedCards += 1;
      if (platform.websitesFromListing && card.website && !isPlatformHost(hostOf(card.website) ?? "")) {
        const host = hostOf(card.website);
        if (host && !websites.has(host)) websites.set(host, { url: card.website, name: card.name, ai: false });
      }
    }
    const future = unseen.filter((card) => card.dates.some(isFuture));
    cards.push(...future);
    // A featured card may repeat on every page: only unseen cards count. The
    // FestAgent listing goes on past the open calls only to list websites.
    pagesWithoutFuture = future.length ? 0 : pagesWithoutFuture + 1;
    if (pagesWithoutFuture >= 2 && !platform.websitesFromListing) break;
    await sleep(platform.pauseMs);
  }
  summary.openCards = cards.length;
  summary.websitesListed = websites.size;
  const cardHash = (card) => createHash("sha256").update(`${card.name}|${card.dates.join(",")}`).digest("hex").slice(0, 12);
  const changed = cards.filter((card) => state[card.id] !== cardHash(card)).slice(0, platform.detailLimit);
  summary.changedCards = changed.length;

  // 2. Festival pages: one record each, plus the festival's own website.
  for (const card of changed) {
    if (Date.now() > deadlineAt) {
      summary.stoppedByTimeBudget = true;
      break;
    }
    const url = platform.detailUrl(card);
    if (!(await robots(url)).allowed) continue;
    await sleep(platform.pauseMs);
    let page;
    try {
      page = await fetchPage(url);
    } catch (error) {
      recordRejection(metrics, error.code ?? "PLATFORM_FETCH_FAILED");
      continue;
    }
    summary.detailsFetched += 1;
    incrementMetric(metrics, "fetched");
    const raw = platform.rawItem({ page, card, now });
    // Only open calls become records; the card is remembered either way.
    if (!raw || raw.observed_status === "closed") {
      recordRejection(metrics, raw ? "PLATFORM_DEADLINE_PASSED" : "PLATFORM_NO_DEADLINE");
      state[card.id] = cardHash(card);
      continue;
    }
    try {
      const produced = await processFetchedPage({
        page,
        title: card.name,
        sourceType: "community",
        metrics,
        runId: run.id,
        operation: "platform_extract",
        presetItems: [raw],
      });
      for (const record of produced) {
        records.push(withProvenance(record, [{
          provider: key,
          queryId: null,
          queryText: null,
          sourceId: source?.id ?? null,
          sourceUrl: url,
          resultRank: null,
          observedAt: page.checkedAt,
          metadata: { [`${key}_id`]: card.id },
        }]));
        summary.records += 1;
        const website = record.official_url;
        const host = hostOf(website);
        if (website && host && !websites.has(host)) websites.set(host, { url: website, name: raw.organizer, ai: record.category === "AI film festival" });
        else if (host && record.category === "AI film festival") websites.get(host).ai = true;
      }
      state[card.id] = cardHash(card);
    } catch (error) {
      recordRejection(metrics, error.code ?? "PLATFORM_EXTRACTION_FAILED");
    }
  }

  // 3. New festival websites join the registry; the listing state is saved.
  if (apply && websites.size) {
    const known = await knownHosts([...websites.keys()]);
    const fresh = [...websites.entries()].filter(([host]) => !known.has(host)).map(([, site]) => websiteSource(site, key));
    for (let index = 0; index < fresh.length; index += 200) {
      await supabase("sources?on_conflict=url", { method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: JSON.stringify(fresh.slice(index, index + 200)) });
    }
    summary.newSources = fresh.length;
  }
  if (apply && source?.id) {
    await supabase(`sources?id=eq.${source.id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ adapter_config: { ...(source.adapter_config ?? {}), platform_state: state }, last_checked_at: new Date().toISOString() }),
    });
  }
}

const deduped = dedupeOpportunitiesDetailed(records);
report.records = deduped.records.length;
if (apply && deduped.records.length) {
  const result = await ingest(deduped.records, { temporalProjection: false });
  report.inserted = result.inserted;
  report.updated = result.updated;
  incrementMetric(metrics, "stored", result.stored);
  await persistProvenance(deduped.records, result.records, run.id);
}
if (apply) await finishRun(run.id, { ...metricsRunPatch(metrics), status: "succeeded" });
console.log(JSON.stringify({ ...report, metrics: summarizeMetrics(metrics) }, null, 2));
