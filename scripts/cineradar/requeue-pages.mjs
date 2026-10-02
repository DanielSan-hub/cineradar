// Puts already-settled pages of known series back in the discovery queue after
// the extraction improved (series-anchored rules, Submit/Rules links). Only
// pages settled by the given processor versions are requeued; nothing else
// changes, and the next discovery runs read them again (oldest first).
//
//   node scripts/cineradar/requeue-pages.mjs                       # dry run
//   node scripts/cineradar/requeue-pages.mjs --apply
//   REQUEUE_PROCESSORS=call-signal-v1,call-signal-v2 node scripts/cineradar/requeue-pages.mjs --apply

import { isSeriesSource } from "./series-extraction.mjs";
import { selectIn, supabase } from "./supabase.mjs";

const apply = process.argv.includes("--apply");
const processors = String(process.env.REQUEUE_PROCESSORS ?? "call-signal-v1,call-signal-v2,cineradar-v5.1")
  .split(",").map((value) => value.trim()).filter(Boolean);

const rows = [];
for (let offset = 0; ; offset += 1000) {
  const batch = await supabase(`url_fetch_cache?select=canonical_url,source_id,processor_version&source_id=not.is.null&processed_hash=not.is.null&processor_version=in.(${processors.join(",")})&order=canonical_url.asc&limit=1000&offset=${offset}`);
  rows.push(...batch);
  if (batch.length < 1000) break;
}
const sourceIds = [...new Set(rows.map((row) => row.source_id))];
const sources = sourceIds.length
  ? await selectIn("sources", "id,source_family,adapter_config,enabled", "id", sourceIds)
  : [];
const series = new Set(sources.filter((source) => source.enabled && isSeriesSource(source)).map((source) => source.id));
const requeue = rows.filter((row) => series.has(row.source_id));
const byProcessor = {};
for (const row of requeue) byProcessor[row.processor_version] = (byProcessor[row.processor_version] ?? 0) + 1;

if (apply) {
  for (let index = 0; index < requeue.length; index += 100) {
    const urls = requeue.slice(index, index + 100).map((row) => `"${row.canonical_url.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
    await supabase(`url_fetch_cache?canonical_url=in.(${encodeURIComponent(urls.join(","))})`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ processed_hash: null, next_retry_at: null, last_error: null }),
    });
  }
}
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", processors, settledPages: rows.length, seriesPages: requeue.length, byProcessor }, null, 2));
