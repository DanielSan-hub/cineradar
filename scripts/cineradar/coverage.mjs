// Evaluation-only coverage report. Reads the owner's datasets (local XLSX or
// the private truth file) and the live registry/opportunities; with --store
// it saves the report in the private bucket, nothing else is written.
//
// The held-out slice is the honest number: those series were never seeded, so
// anything found there was found by the pipeline itself (Wikidata, link
// expansion, portals, gap search).

import { supabase } from "./supabase.mjs";
import { chapman, hostOf, isHeldOut, seriesKey } from "./registry-seeds.mjs";
import { buildTruthFromDatasets, COVERAGE_LATEST, getPrivateJson, putPrivateJson, TRUTH_OBJECT, truthEntries } from "./coverage-truth.mjs";


async function pages(path, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const batch = await supabase(`${path}&limit=${pageSize}&offset=${offset}`);
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

function tokens(value) {
  return new Set(seriesKey(value).split(" ").filter((token) => token.length > 2));
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

// Truth: the owner's local XLSX datasets when given, otherwise the truth file
// in the private Supabase bucket (the weekly CI run). Only aggregates are
// printed: Actions logs are public.
const paths = String(process.env.CINERADAR_SEED_DATASETS ?? "").split(";").map((value) => value.trim()).filter(Boolean);
const truthFile = paths.length ? await buildTruthFromDatasets(paths) : await getPrivateJson(TRUTH_OBJECT);
if (!truthFile) throw new Error("No truth: set CINERADAR_SEED_DATASETS or run upload-coverage-truth.mjs once");
const truth = new Map(truthEntries(truthFile).map((entry) => [entry.key, entry]));
const allDatasetFestivalHosts = new Set(truthFile.festival_hosts ?? []);

const sources = await pages("sources?select=name,url,enabled,last_checked_at,health_status,adapter_config&order=url.asc");
const sourceHosts = new Map();
for (const source of sources) {
  const host = hostOf(source.url);
  if (!host) continue;
  const current = sourceHosts.get(host) ?? { enabled: false, checked: false };
  current.enabled ||= source.enabled;
  current.checked ||= Boolean(source.last_checked_at);
  sourceHosts.set(host, current);
}
// Series whose own site arrived through another channel (e.g. Wikidata) are
// registered even when the dataset only recorded a platform URL for them.
const sourcesByKey = new Map();
for (const source of sources) {
  const key = seriesKey(source.name);
  if (!key) continue;
  const current = sourcesByKey.get(key) ?? { enabled: false, checked: false };
  current.enabled ||= source.enabled;
  current.checked ||= Boolean(source.last_checked_at);
  sourcesByKey.set(key, current);
}
const wikidataHosts = new Set(sources.filter((source) => source.adapter_config?.seed === "wikidata").map((source) => hostOf(source.url)).filter(Boolean));

const opportunities = await pages("opportunities?select=title,official_url,source_url,application_url,review_decision&order=id.asc");
const byKey = new Map();
const byHost = new Map();
for (const opportunity of opportunities) {
  const record = { ...opportunity, tokens: tokens(opportunity.title) };
  byKey.set(seriesKey(opportunity.title), record);
  for (const host of [opportunity.official_url, opportunity.source_url, opportunity.application_url].map(hostOf).filter(Boolean)) {
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(record);
  }
}

function matchOpportunity(entry) {
  const direct = byKey.get(entry.key);
  if (direct) return direct;
  const nameTokens = new Set([...entry.names].flatMap((name) => [...tokens(name)]));
  for (const host of entry.hosts) {
    for (const record of byHost.get(host) ?? []) {
      if (overlap(nameTokens, record.tokens) >= 0.5) return record;
    }
  }
  return null;
}

function report(entries) {
  const total = entries.length;
  let registered = 0;
  let monitored = 0;
  let found = 0;
  let published = 0;
  let platformOnly = 0;
  for (const entry of entries) {
    if (!entry.hosts.size) platformOnly += 1;
    const hosts = [...[...entry.hosts].map((host) => sourceHosts.get(host)), sourcesByKey.get(entry.key)].filter(Boolean);
    if (hosts.some((host) => host.enabled)) registered += 1;
    if (hosts.some((host) => host.checked)) monitored += 1;
    const match = matchOpportunity(entry);
    if (match && match.review_decision !== "rejected") found += 1;
    if (match?.review_decision === "approved") published += 1;
  }
  const pct = (value) => (total ? Number((100 * value / total).toFixed(1)) : null);
  return {
    actionable_series: total,
    registered, registered_pct: pct(registered),
    monitored, monitored_pct: pct(monitored),
    found, found_pct: pct(found),
    published, published_pct: pct(published),
    platform_only_in_dataset: platformOnly,
  };
}

const entries = [...truth.values()];
const heldOut = entries.filter((entry) => isHeldOut(entry.key));
const seeded = entries.filter((entry) => !isHeldOut(entry.key));
const shared = [...allDatasetFestivalHosts].filter((host) => wikidataHosts.has(host)).length;

const coverageReport = {
  measured_at: new Date().toISOString(),
  truth: "owner datasets, series actionable at 2026-09-25 (open/upcoming/rolling)",
  held_out_20pct: report(heldOut),
  seeded_80pct: report(seeded),
  all: report(entries),
  registry: {
    sources: sources.length,
    enabled: sources.filter((source) => source.enabled).length,
    checked: sources.filter((source) => source.last_checked_at).length,
    blocked: sources.filter((source) => source.health_status === "blocked").length,
  },
  festival_market_estimate: {
    method: "Chapman capture-recapture on festival hosts: Wikidata vs owner datasets",
    wikidata_hosts: wikidataHosts.size,
    dataset_festival_hosts: allDatasetFestivalHosts.size,
    overlap: shared,
    estimated_festival_hosts: wikidataHosts.size ? chapman(wikidataHosts.size, allDatasetFestivalHosts.size, shared) : null,
  },
};
console.log(JSON.stringify(coverageReport, null, 2));
// --store: keep the report in the private bucket (latest + one per day).
if (process.argv.includes("--store")) {
  await putPrivateJson(COVERAGE_LATEST, coverageReport);
  await putPrivateJson(`evaluation/coverage-${coverageReport.measured_at.slice(0, 10)}.json`, coverageReport);
}
