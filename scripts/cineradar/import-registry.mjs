// Build the source registry from free structured registries.
//
//   node scripts/cineradar/import-registry.mjs            # dry run (default)
//   node scripts/cineradar/import-registry.mjs --apply    # write sources
//   node scripts/cineradar/import-registry.mjs --only-wikidata --apply
//
// Owner datasets are read from CINERADAR_SEED_DATASETS (";"-separated XLSX
// paths). They seed *sources only*; held-out series and the benchmark workbook
// are never seeded, so coverage can be measured honestly.

import { basename } from "node:path";

import { assertSourceRegistrySchema, supabase } from "./supabase.mjs";
import {
  channelHosts,
  channelSource,
  hostOf,
  isHeldOut,
  isPlatformHost,
  mergeSeedSources,
  seriesKey,
  sourceFromDatasetRow,
  sourceFromPortalRow,
  sourceFromWikidata,
} from "./registry-seeds.mjs";
import { readXlsx, sheetToObjects } from "./xlsx-reader.mjs";

const USER_AGENT = "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)";
const apply = process.argv.includes("--apply");
const onlyWikidata = process.argv.includes("--only-wikidata");
const skipWikidata = process.argv.includes("--skip-wikidata");
const now = Date.now();

const SERIES_SHEETS = new Set(["Dataset", "Editions"]);
const PORTAL_SHEETS = new Set(["Monitor list", "Local channels", "Sources"]);

async function loadWikidata() {
  const query = `SELECT ?f ?site ?label ?cc ?dissolved ?series WHERE {
    ?f wdt:P31/wdt:P279* wd:Q220505 ; wdt:P856 ?site .
    OPTIONAL { ?f wdt:P576 ?dissolved }
    OPTIONAL { ?f wdt:P179 ?series }
    OPTIONAL { ?f rdfs:label ?label FILTER(lang(?label) = "en") }
    OPTIONAL { ?f wdt:P17/wdt:P297 ?cc }
  }`;
  const response = await fetch(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`,
    {
      headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!response.ok) throw new Error(`Wikidata SPARQL ${response.status}`);
  const bindings = (await response.json()).results.bindings;
  const items = new Map();
  for (const binding of bindings) {
    const id = binding.f.value.split("/").pop();
    const item = items.get(id) ?? { id, sites: new Set(), label: null, country: null, dissolved: false, edition: false };
    item.sites.add(binding.site.value);
    item.label ??= binding.label?.value ?? null;
    item.country ??= binding.cc?.value ?? null;
    if (binding.dissolved) item.dissolved = true;
    if (binding.series) item.edition = true;
    items.set(id, item);
  }
  const active = [...items.values()].filter((item) => !item.dissolved && !item.edition);
  return {
    items: items.size,
    active: active.length,
    rows: active.flatMap((item) => [...item.sites].map((site) => sourceFromWikidata({ ...item, site }, { now }))),
  };
}

async function loadDatasets(paths) {
  const seriesRows = [];
  const portalRows = [];
  for (const path of paths) {
    const workbook = await readXlsx(path);
    // The benchmark must stay a held-out measurement, never a seed.
    if (/Film_Opportunities_DeepResearch/i.test(basename(path)) || workbook.sheetNames.includes("Benchmark_Items")) {
      throw new Error(`Refusing to seed from the benchmark workbook: ${basename(path)}`);
    }
    for (const sheet of workbook.sheets) {
      if (!SERIES_SHEETS.has(sheet.name) && !PORTAL_SHEETS.has(sheet.name)) continue;
      const rows = sheetToObjects(sheet);
      const target = SERIES_SHEETS.has(sheet.name) ? seriesRows : portalRows;
      for (const row of rows) target.push({ row, dataset: `${basename(path)}#${sheet.name}` });
    }
  }
  return { seriesRows, portalRows };
}

function heldOutHosts(seriesRows, channels) {
  const hosts = new Set();
  let heldOutSeries = 0;
  const seen = new Set();
  for (const { row } of seriesRows) {
    const key = seriesKey(row.event_series ?? row.opportunity_name);
    if (!key || !isHeldOut(key)) continue;
    if (!seen.has(key)) {
      seen.add(key);
      heldOutSeries += 1;
    }
    for (const url of [row.official_url, row.source_url]) {
      const host = hostOf(url);
      // Channels (aggregators, portals) are never excluded: they list many
      // series and are a general discovery path, not a held-out series' site.
      if (host && !isPlatformHost(host) && !channels.has(host)) hosts.add(host);
    }
  }
  return { hosts, heldOutSeries };
}

async function existingSourceUrls() {
  const urls = new Set();
  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase(`sources?select=url&order=url.asc&limit=1000&offset=${offset}`);
    for (const row of rows) urls.add(row.url);
    if (rows.length < 1000) break;
  }
  return urls;
}

async function upsertSources(rows) {
  let written = 0;
  for (let index = 0; index < rows.length; index += 500) {
    const batch = rows.slice(index, index + 500);
    // ignore-duplicates keeps existing sources' curated settings and statistics.
    await supabase("sources?on_conflict=url", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: JSON.stringify(batch),
    });
    written += batch.length;
  }
  return written;
}

await assertSourceRegistrySchema();
const summary = { mode: apply ? "apply" : "dry-run" };
const collected = [];
let channelRows = [];

if (!skipWikidata) {
  const wikidata = await loadWikidata();
  summary.wikidata = { items: wikidata.items, active_series: wikidata.active, source_rows: wikidata.rows.filter(Boolean).length };
  collected.push(...wikidata.rows);
}

if (!onlyWikidata) {
  const paths = String(process.env.CINERADAR_SEED_DATASETS ?? "").split(";").map((value) => value.trim()).filter(Boolean);
  if (!paths.length) throw new Error("Set CINERADAR_SEED_DATASETS or pass --only-wikidata");
  const { seriesRows, portalRows } = await loadDatasets(paths);
  const channels = channelHosts(seriesRows.map(({ row }) => row));
  const { hosts: excludedHosts, heldOutSeries } = heldOutHosts(seriesRows, channels);
  channelRows = [...channels].map(([host, count]) => channelSource(host, count, { now }));
  const seeded = [];
  let excluded = 0;
  for (const { row, dataset } of seriesRows) {
    const key = seriesKey(row.event_series ?? row.opportunity_name);
    const source = sourceFromDatasetRow(row, { dataset, now });
    if (!source) continue;
    if (isHeldOut(key) || excludedHosts.has(hostOf(source.url))) {
      excluded += 1;
      continue;
    }
    seeded.push(source);
  }
  for (const { row, dataset } of portalRows) {
    const source = sourceFromPortalRow(row, { dataset, now });
    if (!source) continue;
    if (excludedHosts.has(hostOf(source.url))) {
      excluded += 1;
      continue;
    }
    seeded.push(source);
  }
  summary.datasets = {
    files: paths.map((path) => basename(path)),
    series_rows: seriesRows.length,
    portal_rows: portalRows.length,
    held_out_series: heldOutSeries,
    held_out_hosts: excludedHosts.size,
    rows_excluded_by_holdout: excluded,
    source_rows: seeded.length,
    channel_hosts: channels.size,
  };
  collected.push(...seeded);
}

const merged = mergeSeedSources(collected);
const existing = await existingSourceUrls();
const fresh = merged.filter((row) => !existing.has(row.url));
summary.merged_sources = merged.length;
summary.already_registered = merged.length - fresh.length;
summary.new_sources = fresh.length;
summary.new_by_family = fresh.reduce((counts, row) => {
  counts[row.source_family] = (counts[row.source_family] ?? 0) + 1;
  return counts;
}, {});
summary.new_by_priority = fresh.reduce((counts, row) => {
  counts[row.priority] = (counts[row.priority] ?? 0) + 1;
  return counts;
}, {});
if (apply) summary.written = await upsertSources(fresh);
if (channelRows.length) {
  summary.channel_sources = channelRows.length;
  summary.channel_sample = channelRows.slice(0, 12).map((row) => `${row.name} (${row.adapter_config.series_count} series)`);
  if (apply) {
    // Merge so channels registered earlier as ordinary sites get directory
    // settings; statistics columns are not in the payload and are preserved.
    for (let index = 0; index < channelRows.length; index += 500) {
      await supabase("sources?on_conflict=url", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: JSON.stringify(channelRows.slice(index, index + 500)),
      });
    }
  }
}
console.log(JSON.stringify(summary, null, 2));
