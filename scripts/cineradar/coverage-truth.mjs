// The owner's evaluation datasets, kept in a PRIVATE Supabase Storage bucket
// so the weekly coverage report runs in CI without the owner's PC. Only a
// compact truth file is stored (series key, names, own-site hosts, held-out
// flag) - never the workbooks, never in the public Git repository, and the
// CI job prints aggregates only (Actions logs are public).

import { basename } from "node:path";

import { requireEnv } from "./config.mjs";
import { hostOf, isHeldOut, isPlatformHost, seriesKey } from "./registry-seeds.mjs";

export const PRIVATE_BUCKET = "cineradar-private";
export const TRUTH_OBJECT = "evaluation/coverage-truth.json";
export const COVERAGE_LATEST = "evaluation/coverage-latest.json";
const ACTIONABLE = /^(?:open|upcoming|rolling|announced|in_progress)/i;

/** Truth file from the owner's XLSX datasets (local only; refuses the benchmark). */
export async function buildTruthFromDatasets(paths) {
  const { readXlsx, sheetToObjects } = await import("./xlsx-reader.mjs");
  const truth = new Map();
  const festivalHosts = new Set();
  for (const path of paths) {
    const workbook = await readXlsx(path);
    if (/Film_Opportunities_DeepResearch/i.test(basename(path)) || workbook.sheetNames.includes("Benchmark_Items")) {
      throw new Error(`Refusing to use the benchmark workbook: ${basename(path)}`);
    }
    for (const sheet of workbook.sheets.filter((item) => item.name === "Dataset" || item.name === "Editions")) {
      for (const row of sheetToObjects(sheet)) {
        const key = seriesKey(row.event_series ?? row.opportunity_name);
        if (!key) continue;
        const hosts = [row.official_url, row.source_url].map(hostOf).filter((host) => host && !isPlatformHost(host));
        if (/festival|short|animation|screening/i.test(String(row.category_primary ?? ""))) {
          for (const host of hosts) festivalHosts.add(host);
        }
        if (!ACTIONABLE.test(String(row.status_at_2026_09_25 ?? ""))) continue;
        const entry = truth.get(key) ?? { key, names: new Set(), hosts: new Set(), category: String(row.category_primary ?? ""), dataset: basename(path) };
        for (const host of hosts) entry.hosts.add(host);
        entry.names.add(String(row.event_series ?? row.opportunity_name));
        truth.set(key, entry);
      }
    }
  }
  return {
    generated_at: new Date().toISOString(),
    description: "owner datasets, series actionable at 2026-09-25 (open/upcoming/rolling)",
    entries: [...truth.values()].map((entry) => ({ ...entry, names: [...entry.names], hosts: [...entry.hosts], held_out: isHeldOut(entry.key) })),
    festival_hosts: [...festivalHosts],
  };
}

/** Entries as coverage.mjs uses them (Sets). */
export function truthEntries(file) {
  return (file?.entries ?? []).map((entry) => ({ ...entry, names: new Set(entry.names ?? []), hosts: new Set(entry.hosts ?? []) }));
}

function storageHeaders(extra = {}) {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function storageUrl(path) {
  return `${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}/storage/v1/${path}`;
}

/** Creates the private bucket once (never public). */
export async function ensurePrivateBucket() {
  const existing = await fetch(storageUrl(`bucket/${PRIVATE_BUCKET}`), { headers: storageHeaders() });
  if (existing.ok) {
    const bucket = await existing.json();
    if (bucket.public) throw new Error(`Bucket ${PRIVATE_BUCKET} is public: refusing to store evaluation data there`);
    return;
  }
  const created = await fetch(storageUrl("bucket"), {
    method: "POST",
    headers: storageHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: PRIVATE_BUCKET, name: PRIVATE_BUCKET, public: false }),
  });
  if (!created.ok) throw new Error(`Creating bucket failed: ${created.status} ${await created.text()}`);
}

export async function putPrivateJson(path, value) {
  const response = await fetch(storageUrl(`object/${PRIVATE_BUCKET}/${path}`), {
    method: "POST",
    headers: storageHeaders({ "Content-Type": "application/json", "x-upsert": "true" }),
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Storage upload ${path} failed: ${response.status} ${await response.text()}`);
}

/** A private JSON object, or null when it does not exist. */
export async function getPrivateJson(path) {
  const response = await fetch(storageUrl(`object/${PRIVATE_BUCKET}/${path}`), { headers: storageHeaders() });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Storage download ${path} failed: ${response.status}`);
  return response.json();
}
