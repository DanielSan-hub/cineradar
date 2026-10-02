// Daily platform connector (Festhome). Festhome lists open festivals sorted by
// their next deadline, so the listing is read until the cards stop showing a
// future date (~60 pages). Only new or changed cards are opened; each festival
// page yields a record (final submission deadline, the festival's own website,
// rules for the decision fields) through the usual normalization, and the
// festival's own website joins the registry as a monitored series source.
// One request per second; robots.txt is checked; FilmFreeway is never used.
//
//   node scripts/cineradar/harvest-platforms.mjs           # dry run
//   node scripts/cineradar/harvest-platforms.mjs --apply   # write

import { createHash } from "node:crypto";

import { dedupeOpportunitiesDetailed } from "./normalization.mjs";
import { persistProvenance, withProvenance } from "./operations.mjs";
import {
  FESTHOME_LISTING,
  festhomeListingPage,
  festhomeDetailUrl,
  festhomeRawItem,
  parseFesthomeListing,
} from "./platform-connectors.mjs";
import { processFetchedPage } from "./process-page.mjs";
import { hostOf } from "./registry-seeds.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { finishRun, ingest, startRun, supabase } from "./supabase.mjs";
import { createRunMetrics, incrementMetric, metricsRunPatch, recordRejection, summarizeMetrics } from "./telemetry.mjs";
import { fetchPage } from "./web-validation.mjs";

const apply = process.argv.includes("--apply");
const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};
const MAX_LISTING_PAGES = number("FESTHOME_LISTING_PAGES", 150);
const DETAIL_LIMIT = number("FESTHOME_DETAIL_LIMIT", 300);
const deadlineAt = Date.now() + number("PLATFORM_TIME_BUDGET_SECONDS", 600) * 1000;
const UA = "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)";
const robots = createRobotsChecker({ userAgent: UA });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metrics = createRunMetrics("discovery");
const now = Date.now();

const [platformSource] = await supabase("sources?select=id,url,adapter_config&url=eq.https://festhome.com/festivals&limit=1");
if (!platformSource) throw new Error("The Festhome Festivals source is not registered");
const state = { ...(platformSource.adapter_config?.platform_state ?? {}) };
const summary = { mode: apply ? "apply" : "dry-run", listingPages: 0, openCards: 0, changedCards: 0, detailsFetched: 0, records: 0, inserted: 0, updated: 0, newSources: 0, stoppedByTimeBudget: false };

if (!(await robots(FESTHOME_LISTING)).allowed) throw new Error("robots.txt disallows the Festhome listing");

// 1. Listing: open festivals first, sorted by the next deadline.
const cards = [];
let pagesWithoutFuture = 0;
const seenCards = new Set();
for (let page = 1; page <= MAX_LISTING_PAGES && Date.now() < deadlineAt; page += 1) {
  // Later pages are the listing's own AJAX fragments (12 cards each).
  const url = page === 1 ? FESTHOME_LISTING : festhomeListingPage(page);
  let pageCards = [];
  try {
    const response = await fetch(url, { headers: { "user-agent": UA, ...(page > 1 ? { "X-Requested-With": "XMLHttpRequest" } : {}) } });
    if (response.ok) pageCards = parseFesthomeListing(await response.text());
  } catch {
    recordRejection(metrics, "PLATFORM_LISTING_FAILED");
  }
  summary.listingPages += 1;
  const future = pageCards.filter((card) => !seenCards.has(card.id) && card.dates.some((date) => Date.parse(`${date}T23:59:59Z`) >= now));
  for (const card of future) seenCards.add(card.id);
  cards.push(...future);
  // A featured card repeats on every page: only cards not seen yet count.
  pagesWithoutFuture = future.length ? 0 : pagesWithoutFuture + 1;
  if (pagesWithoutFuture >= 2) break;
  await sleep(1000);
}
summary.openCards = cards.length;
const cardHash = (card) => createHash("sha256").update(`${card.name}|${card.dates.join(",")}`).digest("hex").slice(0, 12);
const changed = cards.filter((card) => state[card.id] !== cardHash(card)).slice(0, DETAIL_LIMIT);
summary.changedCards = changed.length;

// 2. Festival pages: one record each, plus the festival's own website.
const run = apply ? await startRun("discovery") : { id: null };
const records = [];
const websites = new Map();
for (const card of changed) {
  if (Date.now() > deadlineAt) {
    summary.stoppedByTimeBudget = true;
    break;
  }
  const url = festhomeDetailUrl(card.id);
  if (!(await robots(url)).allowed) continue;
  await sleep(1000);
  let page;
  try {
    page = await fetchPage(url);
  } catch (error) {
    recordRejection(metrics, error.code ?? "PLATFORM_FETCH_FAILED");
    continue;
  }
  summary.detailsFetched += 1;
  incrementMetric(metrics, "fetched");
  const raw = festhomeRawItem({ page, card, now });
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
        provider: "festhome",
        queryId: null,
        queryText: null,
        sourceId: platformSource.id,
        sourceUrl: url,
        resultRank: null,
        observedAt: page.checkedAt,
        metadata: { festhome_id: card.id },
      }]));
      const website = record.official_url;
      if (website && !websites.has(hostOf(website))) websites.set(hostOf(website), { url: website, name: raw.organizer, ai: record.category === "AI film festival" });
    }
    state[card.id] = cardHash(card);
  } catch (error) {
    recordRejection(metrics, error.code ?? "PLATFORM_EXTRACTION_FAILED");
  }
}

// 3. Store records, provenance, new registry sources and the listing state.
const deduped = dedupeOpportunitiesDetailed(records);
summary.records = deduped.records.length;
if (apply && deduped.records.length) {
  const result = await ingest(deduped.records, { temporalProjection: false });
  summary.inserted = result.inserted;
  summary.updated = result.updated;
  incrementMetric(metrics, "stored", result.stored);
  await persistProvenance(deduped.records, result.records, run.id);
}
if (apply && websites.size) {
  const known = new Set();
  for (const hosts of [[...websites.keys()]]) {
    for (let index = 0; index < hosts.length; index += 100) {
      const batch = hosts.slice(index, index + 100);
      const rows = await supabase(`sources?select=url&or=(${batch.map((host) => `url.ilike.*${encodeURIComponent(host)}*`).join(",")})`).catch(() => []);
      for (const row of rows) known.add(hostOf(row.url));
    }
  }
  const fresh = [...websites.entries()].filter(([host]) => !known.has(host)).map(([, site]) => ({
    name: site.name.slice(0, 200),
    url: site.url,
    tier: 2,
    priority: site.ai ? 1 : 2,
    source_type: "official",
    source_family: site.ai ? "ai-creative-tech" : "official-site",
    opportunity_categories: site.ai ? ["ai-film"] : ["film-festival"],
    adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 6, seed: "platform:festhome" },
    min_poll_interval_minutes: 360,
    poll_interval_minutes: 1_440,
    max_poll_interval_minutes: 10_080,
    next_check_at: new Date().toISOString(),
  }));
  for (let index = 0; index < fresh.length; index += 200) {
    await supabase("sources?on_conflict=url", { method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: JSON.stringify(fresh.slice(index, index + 200)) });
  }
  summary.newSources = fresh.length;
}
if (apply) {
  await supabase(`sources?id=eq.${platformSource.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ adapter_config: { ...(platformSource.adapter_config ?? {}), platform_state: state }, last_checked_at: new Date().toISOString() }),
  });
  await finishRun(run.id, { ...metricsRunPatch(metrics), status: "succeeded" });
}
console.log(JSON.stringify({ ...summary, metrics: summarizeMetrics(metrics) }, null, 2));
