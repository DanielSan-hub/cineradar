// Find the own website of dataset series that were recorded only as platform
// pages (mostly FilmFreeway), using ledgered Exa searches, and register those
// sites as sources. Held-out series are never resolved.
//
//   node scripts/cineradar/resolve-sites.mjs            # dry run: candidates + cost
//   node scripts/cineradar/resolve-sites.mjs --apply    # search and register

import { basename } from "node:path";

import { usageIdempotencyKey } from "./cost-control.mjs";
import { ledgeredExaSearch } from "./exa.mjs";
import { mapPool } from "./http.mjs";
import {
  hostOf,
  isHeldOut,
  isPlatformHost,
  pickOfficialSite,
  seriesKey,
  sourceFromDatasetRow,
} from "./registry-seeds.mjs";
import { assertSourceRegistrySchema, supabase } from "./supabase.mjs";
import { readXlsx, sheetToObjects } from "./xlsx-reader.mjs";

const apply = process.argv.includes("--apply");
const limit = Math.max(1, Math.min(400, Number(process.env.RESOLVE_LIMIT ?? 50) || 50));
const ACTIONABLE = /^(?:open|upcoming|rolling|announced|in_progress)/i;
const RECURRING = /closed[-_ ]?(?:recent|recurring)|completed|closed_event_upcoming/i;
const EXCLUDE = ["filmfreeway.com", "festhome.com", "imdb.com", "facebook.com", "instagram.com", "wikipedia.org"];

function categoryHint(row) {
  const text = `${row.category_primary ?? ""} ${row.category_secondary ?? ""}`;
  if (/grant|fund/i.test(text)) return "film grant";
  if (/residen/i.test(text)) return "artist residency";
  if (/lab|fellowship/i.test(text)) return "film lab";
  return "film festival";
}

async function registeredKeys() {
  const keys = new Set();
  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase(`sources?select=name&order=id.asc&limit=1000&offset=${offset}`);
    for (const row of rows) keys.add(seriesKey(row.name));
    if (rows.length < 1000) return keys;
  }
}

await assertSourceRegistrySchema();
const paths = String(process.env.CINERADAR_SEED_DATASETS ?? "").split(";").map((value) => value.trim()).filter(Boolean);
if (!paths.length) throw new Error("Set CINERADAR_SEED_DATASETS to the owner dataset XLSX paths");

const series = new Map();
for (const path of paths) {
  const workbook = await readXlsx(path);
  if (/Film_Opportunities_DeepResearch/i.test(basename(path)) || workbook.sheetNames.includes("Benchmark_Items")) {
    throw new Error(`Refusing to use the benchmark workbook: ${basename(path)}`);
  }
  for (const sheet of workbook.sheets.filter((item) => item.name === "Dataset" || item.name === "Editions")) {
    for (const row of sheetToObjects(sheet)) {
      const name = String(row.event_series ?? row.opportunity_name ?? "").trim();
      const key = seriesKey(name);
      if (!key || isHeldOut(key)) continue;
      const status = String(row.status_at_2026_09_25 ?? "");
      const rank = ACTIONABLE.test(status) ? 0 : RECURRING.test(status) ? 1 : 2;
      const entry = series.get(key) ?? { key, name, row, rank, ownSite: false };
      if ([row.official_url, row.source_url].some((url) => hostOf(url) && !isPlatformHost(hostOf(url)))) entry.ownSite = true;
      if (rank < entry.rank) Object.assign(entry, { rank, row, name });
      series.set(key, entry);
    }
  }
}

const registered = await registeredKeys();
const candidates = [...series.values()]
  .filter((entry) => !entry.ownSite && entry.rank < 2 && !registered.has(entry.key))
  .sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
const batch = candidates.slice(0, limit);
const summary = {
  mode: apply ? "apply" : "dry-run",
  platform_only_seeded_series: candidates.length,
  actionable: candidates.filter((entry) => entry.rank === 0).length,
  recurring_closed: candidates.filter((entry) => entry.rank === 1).length,
  this_run: batch.length,
  max_cost_this_run_eur: Number((batch.length * 0.01).toFixed(2)),
};

if (apply) {
  const month = new Date().toISOString().slice(0, 7);
  const outcomes = await mapPool(batch, 3, async (entry) => {
    const result = await ledgeredExaSearch({
      idempotencyKey: usageIdempotencyKey(["site-resolution", entry.key, month]),
      operation: "site-resolution",
      text: `${entry.name} ${categoryHint(entry.row)} official website`,
      numResults: 5,
      excludeDomains: EXCLUDE,
      metadata: { query_family: "site-resolution" },
    }).catch((error) => ({ error: error.message }));
    if (result.error) return { status: "error" };
    if (result.blocked) return { status: "blocked", reason: result.reason };
    const url = pickOfficialSite(entry.name, result.results);
    if (!url) return { status: "unresolved", costEur: result.costEur };
    const source = sourceFromDatasetRow({ ...entry.row, official_url: url, source_url: null }, { dataset: "exa-site-resolution" });
    source.adapter_config = { ...source.adapter_config, seed: "exa-site-resolution" };
    return { status: "resolved", source, costEur: result.costEur };
  });
  const resolved = outcomes.filter((outcome) => outcome.status === "resolved").map((outcome) => outcome.source);
  const unique = [...new Map(resolved.map((source) => [source.url, source])).values()];
  if (unique.length) {
    await supabase("sources?on_conflict=url", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: JSON.stringify(unique),
    });
  }
  summary.resolved = resolved.length;
  summary.registered_sources = unique.length;
  summary.unresolved = outcomes.filter((outcome) => outcome.status === "unresolved").length;
  summary.blocked = outcomes.filter((outcome) => outcome.status === "blocked").length;
  summary.errors = outcomes.filter((outcome) => outcome.status === "error").length;
  summary.cost_eur = Number(outcomes.reduce((sum, outcome) => sum + (outcome.costEur ?? 0), 0).toFixed(4));
  summary.sample = unique.slice(0, 8).map((source) => `${source.name} -> ${source.url}`);
}
console.log(JSON.stringify(summary, null, 2));
