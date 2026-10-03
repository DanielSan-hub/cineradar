// Daily EU connector: open Creative Europe MEDIA topics from the EU Funding &
// Tenders Portal's public search API (free, no key of ours, robots.txt
// allows it). Each open topic in scope becomes a grant record with its next
// cut-off; its portal page is fetched once so the official link is verified
// by a real request. About 2-20 requests a day, one per second; no LLM.
//
//   node scripts/cineradar/harvest-eu-funding.mjs           # dry run
//   node scripts/cineradar/harvest-eu-funding.mjs --apply   # write

import { euRawItem, euSearchQuery, euSearchUrl, euTopicInScope, euTopicText, parseEuSearchResults } from "./eu-funding-connector.mjs";
import { dedupeOpportunitiesDetailed } from "./normalization.mjs";
import { persistProvenance, withProvenance } from "./operations.mjs";
import { processFetchedPage } from "./process-page.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { finishRun, ingest, startRun, supabase } from "./supabase.mjs";
import { createRunMetrics, incrementMetric, metricsRunPatch, recordRejection, summarizeMetrics } from "./telemetry.mjs";
import { validateUrl } from "./web-validation.mjs";

const apply = process.argv.includes("--apply");
const includeIndustry = /^(?:1|true|yes)$/i.test(process.env.EU_FT_INCLUDE_INDUSTRY ?? "");
const TOPIC_LIMIT = Math.max(1, Math.min(60, Number(process.env.EU_FT_TOPIC_LIMIT ?? 30) || 30));
const UA = "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)";
const robots = createRobotsChecker({ userAgent: UA });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metrics = createRunMetrics("discovery");
const now = Date.now();
const summary = { mode: apply ? "apply" : "dry-run", searchPages: 0, topics: 0, inScope: 0, records: 0, inserted: 0, updated: 0, skipped: [] };

async function search(pageNumber) {
  const url = euSearchUrl(pageNumber);
  if (!(await robots(url)).allowed) throw new Error("robots.txt disallows the EU search API");
  const parts = euSearchQuery();
  const form = new FormData();
  for (const [name, value] of Object.entries(parts)) form.append(name, new Blob([JSON.stringify(value)], { type: "application/json" }));
  const response = await fetch(url, { method: "POST", body: form, headers: { "user-agent": UA } });
  if (!response.ok) throw new Error(`EU search ${response.status}`);
  return response.json();
}

const topics = [];
for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
  const json = await search(pageNumber);
  summary.searchPages += 1;
  topics.push(...parseEuSearchResults(json));
  if (pageNumber * 100 >= Number(json.totalResults ?? 0)) break;
  await sleep(1000);
}
summary.topics = topics.length;
const inScope = topics.filter((topic) => euTopicInScope(topic, { now, includeIndustry })).slice(0, TOPIC_LIMIT);
summary.inScope = inScope.length;
for (const topic of topics) if (!inScope.includes(topic)) summary.skipped.push(`${topic.identifier} (${topic.status ?? "no action"})`);

// The connector's registry row ("Creative Europe MEDIA") credits the source.
const [registry] = await supabase("sources?select=id&name=ilike.*Creative%20Europe%20MEDIA*&limit=1").catch(() => []);
const run = apply ? await startRun("discovery") : { id: null };
const records = [];
for (const topic of inScope) {
  await sleep(1000);
  if (!(await robots(topic.url)).allowed) continue;
  // The portal page is a JavaScript application with no text of its own: it
  // is requested to verify the link, and the facts come from the API values
  // rendered as text.
  const check = await validateUrl(topic.url).catch(() => null);
  if (!check || !["verified", "redirected"].includes(check.status)) {
    recordRejection(metrics, check?.reason ?? "EU_PORTAL_UNREACHABLE");
    continue;
  }
  incrementMetric(metrics, "fetched");
  const raw = euRawItem(topic, { now });
  if (!raw) continue;
  const shell = { inputUrl: check.input_url, finalUrl: check.final_url, status: check.status, httpStatus: check.http_status, checkedAt: check.checked_at };
  const page = {
    ...shell,
    redirectChain: check.redirect_chain ?? [],
    contentType: "text/html",
    html: "",
    title: topic.title,
    text: euTopicText(topic),
    links: [topic.url],
    linkRecords: [{ url: topic.url, text: topic.title }],
    notModified: false,
  };
  try {
    const produced = await processFetchedPage({ page, title: raw.title, sourceType: "official", metrics, runId: run.id, operation: "platform_extract", presetItems: [raw] });
    for (const record of produced) {
      records.push(withProvenance(record, [{
        provider: "eu-ft-portal",
        queryId: null,
        queryText: null,
        sourceId: registry?.id ?? null,
        sourceUrl: topic.url,
        resultRank: null,
        observedAt: shell.checkedAt,
        metadata: { topic: topic.identifier },
      }]));
    }
  } catch (error) {
    recordRejection(metrics, error.code ?? "EU_EXTRACTION_FAILED");
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
if (apply) await finishRun(run.id, { ...metricsRunPatch(metrics), status: "succeeded" });
console.log(JSON.stringify({ ...summary, sample: deduped.records.slice(0, 8).map((record) => `${record.title} — ${String(record.deadline).slice(0, 10)}`), metrics: summarizeMetrics(metrics) }, null, 2));
