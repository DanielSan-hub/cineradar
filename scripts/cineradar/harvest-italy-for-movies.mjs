// Daily Italy for Movies connector (national portal of Italian film funds,
// Cinecittà / Ministry of Culture; robots.txt sets no rule). Reads the grant
// pages listed in the sitemap (one request per 1.2 s, each page again only
// after IFM_RECHECK_DAYS), turns open grants with a future closing date into
// records whose official page is the funder's own page, and registers the
// funders' sites as monitored sources. No LLM, no paid service.
//
//   node scripts/cineradar/harvest-italy-for-movies.mjs           # dry run
//   node scripts/cineradar/harvest-italy-for-movies.mjs --apply   # write

import { IFM_SITEMAP, ifmGrantUrls, ifmRawItem, parseIfmGrant } from "./italy-for-movies.mjs";
import { dedupeOpportunitiesDetailed } from "./normalization.mjs";
import { persistProvenance, withProvenance } from "./operations.mjs";
import { processFetchedPage } from "./process-page.mjs";
import { hostOf, isPlatformHost } from "./registry-seeds.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { finishRun, ingest, startRun, supabase } from "./supabase.mjs";
import { createRunMetrics, incrementMetric, metricsRunPatch, recordRejection, summarizeMetrics } from "./telemetry.mjs";
import { fetchPage } from "./web-validation.mjs";

const apply = process.argv.includes("--apply");
const RECHECK_DAYS = Math.max(1, Number(process.env.IFM_RECHECK_DAYS ?? 3) || 3);
const PAGE_LIMIT = Math.max(1, Math.min(200, Number(process.env.IFM_PAGE_LIMIT ?? 60) || 60));
const UA = "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)";
const robots = createRobotsChecker({ userAgent: UA });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metrics = createRunMetrics("discovery");
const now = Date.now();
const SOURCE_URL = "https://www.italyformovies.it/bandi";

let [source] = await supabase(`sources?select=id,adapter_config&url=eq.${encodeURIComponent(SOURCE_URL)}&limit=1`);
if (!source && apply) {
  [source] = await supabase("sources?on_conflict=url", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify([{
      name: "Italy for Movies – Bandi", url: SOURCE_URL, enabled: false, tier: 1, priority: 1, source_type: "official",
      source_family: "film-funding", country: "IT", language: "it", opportunity_categories: ["grant"],
      adapter: "platform-connector", adapter_config: { checkpoint_key: "default", platform_state: {} },
    }]),
  });
}
const state = { ...(source?.adapter_config?.platform_state ?? {}) };
const summary = { mode: apply ? "apply" : "dry-run", grantPages: 0, read: 0, open: 0, records: 0, inserted: 0, updated: 0, newSources: 0 };

if (!(await robots(IFM_SITEMAP)).allowed) throw new Error("robots.txt disallows the Italy for Movies sitemap");
const sitemap = await (await fetch(IFM_SITEMAP, { headers: { "user-agent": UA } })).text();
const urls = ifmGrantUrls(sitemap);
summary.grantPages = urls.length;
const due = urls.filter((url) => !state[url] || Date.parse(state[url]) < now - RECHECK_DAYS * 86_400_000).slice(0, PAGE_LIMIT);

const run = apply ? await startRun("discovery") : { id: null };
const records = [];
const funders = new Map();
for (const url of due) {
  if (!(await robots(url)).allowed) continue;
  await sleep(1200);
  let page;
  try {
    page = await fetchPage(url);
  } catch (error) {
    recordRejection(metrics, error.code ?? "IFM_FETCH_FAILED");
    continue;
  }
  summary.read += 1;
  incrementMetric(metrics, "fetched");
  state[url] = new Date().toISOString();
  const grant = parseIfmGrant(page);
  if (grant.link && !isPlatformHost(hostOf(grant.link) ?? "")) {
    const host = hostOf(grant.link);
    if (host && !funders.has(host)) funders.set(host, { url: grant.link, name: grant.funder ?? grant.title ?? host });
  }
  const raw = ifmRawItem(page, { now });
  if (!raw) continue;
  summary.open += 1;
  try {
    const produced = await processFetchedPage({ page, title: raw.title, sourceType: "community", metrics, runId: run.id, operation: "platform_extract", presetItems: [raw] });
    for (const record of produced) {
      records.push(withProvenance(record, [{ provider: "italyformovies", queryId: null, queryText: null, sourceId: source?.id ?? null, sourceUrl: url, resultRank: null, observedAt: page.checkedAt, metadata: {} }]));
    }
  } catch (error) {
    recordRejection(metrics, error.code ?? "IFM_EXTRACTION_FAILED");
  }
}

const deduped = dedupeOpportunitiesDetailed(records);
summary.records = deduped.records.length;
if (apply && deduped.records.length) {
  const result = await ingest(deduped.records, { temporalProjection: false });
  summary.inserted = result.inserted;
  summary.updated = result.updated;
  incrementMetric(metrics, "stored", result.stored);
  await persistProvenance(deduped.records, result.records, run.id);
}
if (apply && funders.size) {
  const known = new Set();
  for (let offset = 0; ; offset += 1000) {
    const batch = await supabase(`sources?select=url&order=id.asc&limit=1000&offset=${offset}`);
    for (const row of batch) known.add(hostOf(row.url));
    if (batch.length < 1000) break;
  }
  const fresh = [...funders.entries()].filter(([host]) => !known.has(host)).map(([, funder]) => ({
    name: funder.name.slice(0, 200), url: funder.url, tier: 2, priority: 1, source_type: "official", source_family: "film-funding",
    country: "IT", language: "it", opportunity_categories: ["grant"], adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 6, seed: "platform:italyformovies" },
    min_poll_interval_minutes: 720, poll_interval_minutes: 2880, max_poll_interval_minutes: 10080, next_check_at: new Date().toISOString(),
  }));
  if (fresh.length) await supabase("sources?on_conflict=url", { method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: JSON.stringify(fresh) });
  summary.newSources = fresh.length;
}
if (apply && source?.id) {
  await supabase(`sources?id=eq.${source.id}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ adapter_config: { ...(source.adapter_config ?? {}), platform_state: state }, last_checked_at: new Date().toISOString() }) });
  await finishRun(run.id, { ...metricsRunPatch(metrics), status: "succeeded" });
}
console.log(JSON.stringify({ ...summary, sample: deduped.records.slice(0, 10).map((record) => `${record.title} — ${String(record.deadline).slice(0, 10)} — ${hostOf(record.official_url)}`), metrics: summarizeMetrics(metrics) }, null, 2));
