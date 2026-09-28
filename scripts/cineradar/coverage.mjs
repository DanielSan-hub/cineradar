// Evaluation-only coverage report. Reads the owner's datasets from
// CINERADAR_SEED_DATASETS and the live registry/opportunities; writes nothing.
//
// The held-out slice is the honest number: those series were never seeded, so
// anything found there was found by the pipeline itself (Wikidata, link
// expansion, portals, gap search).

import { basename } from "node:path";

import { supabase } from "./supabase.mjs";
import { chapman, hostOf, isHeldOut, isPlatformHost, seriesKey } from "./registry-seeds.mjs";
import { readXlsx, sheetToObjects } from "./xlsx-reader.mjs";

const ACTIONABLE = /^(?:open|upcoming|rolling|announced|in_progress)/i;

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

const paths = String(process.env.CINERADAR_SEED_DATASETS ?? "").split(";").map((value) => value.trim()).filter(Boolean);
if (!paths.length) throw new Error("Set CINERADAR_SEED_DATASETS to the owner dataset XLSX paths");

const truth = new Map();
const allDatasetFestivalHosts = new Set();
for (const path of paths) {
  const workbook = await readXlsx(path);
  for (const sheet of workbook.sheets.filter((item) => item.name === "Dataset" || item.name === "Editions")) {
    for (const row of sheetToObjects(sheet)) {
      const key = seriesKey(row.event_series ?? row.opportunity_name);
      if (!key) continue;
      const hosts = [row.official_url, row.source_url].map(hostOf).filter((host) => host && !isPlatformHost(host));
      if (/festival|short|animation|screening/i.test(String(row.category_primary ?? ""))) {
        for (const host of hosts) allDatasetFestivalHosts.add(host);
      }
      if (!ACTIONABLE.test(String(row.status_at_2026_09_25 ?? ""))) continue;
      const entry = truth.get(key) ?? { key, hosts: new Set(), names: new Set(), dataset: basename(path) };
      for (const host of hosts) entry.hosts.add(host);
      entry.names.add(String(row.event_series ?? row.opportunity_name));
      truth.set(key, entry);
    }
  }
}

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

console.log(JSON.stringify({
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
}, null, 2));
