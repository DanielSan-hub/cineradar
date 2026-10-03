import { createHash } from "node:crypto";

import { canonicalizeUrl } from "./web-validation.mjs";
import { supabase } from "./supabase.mjs";

export const PROCESSOR_VERSION = "cineradar-v5.1";

function quotedInValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function pageContentHash(page) {
  return createHash("sha256").update(String(page?.text ?? "")).digest("hex");
}

export async function fetchUrlCache(urls) {
  const canonical = [...new Set(urls.map((url) => canonicalizeUrl(url)).filter(Boolean))];
  const rows = [];
  for (let index = 0; index < canonical.length; index += 20) {
    const batch = canonical.slice(index, index + 20);
    const params = new URLSearchParams({
      select: "*",
      canonical_url: `in.(${batch.map(quotedInValue).join(",")})`,
      limit: "1000",
    });
    rows.push(...await supabase(`url_fetch_cache?${params.toString()}`));
  }
  return new Map(rows.map((row) => [row.canonical_url, row]));
}

export async function observeFetchedPage(
  page,
  { sourceId = null, existing = null } = {},
) {
  const canonicalUrl = canonicalizeUrl(page.inputUrl ?? page.finalUrl);
  if (!canonicalUrl) throw new Error("Cannot cache a page without a canonical URL");
  const contentHash = pageContentHash(page);
  const changed = existing?.content_hash !== contentHash;
  const checkedAt = page.checkedAt ?? new Date().toISOString();
  const [stored] = await supabase("url_fetch_cache?on_conflict=canonical_url", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify([{
      canonical_url: canonicalUrl,
      source_id: sourceId ?? existing?.source_id ?? null,
      final_url: page.finalUrl ?? canonicalUrl,
      content_hash: contentHash,
      etag: page.etag ?? null,
      last_modified: page.lastModified ?? null,
      http_status: page.httpStatus ?? null,
      content_type: page.contentType ?? null,
      last_checked_at: checkedAt,
      last_changed_at: changed ? checkedAt : existing?.last_changed_at ?? checkedAt,
      consecutive_failures: 0,
      next_retry_at: null,
      last_error: null,
      updated_at: checkedAt,
    }]),
  });
  return {
    row: stored,
    contentHash,
    changed,
    alreadyProcessed: existing?.processed_hash === contentHash,
  };
}

export async function observeNotModified(page, existing) {
  if (!existing?.canonical_url || !existing?.content_hash) {
    throw new Error("HTTP 304 received without a cached representation");
  }
  const checkedAt = page.checkedAt ?? new Date().toISOString();
  await supabase(
    `url_fetch_cache?canonical_url=eq.${encodeURIComponent(existing.canonical_url)}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        final_url: page.finalUrl ?? existing.final_url ?? existing.canonical_url,
        etag: page.etag ?? existing.etag ?? null,
        last_modified: page.lastModified ?? existing.last_modified ?? null,
        http_status: 304,
        last_checked_at: checkedAt,
        consecutive_failures: 0,
        next_retry_at: null,
        last_error: null,
        updated_at: checkedAt,
      }),
    },
  );
  return {
    row: { ...existing, last_checked_at: checkedAt, http_status: 304 },
    contentHash: existing.content_hash,
    changed: false,
    alreadyProcessed: existing.processed_hash === existing.content_hash,
  };
}

export async function recordFetchFailure(url, error, existing = null) {
  const canonicalUrl = canonicalizeUrl(url);
  if (!canonicalUrl) return null;
  const checkedAt = new Date().toISOString();
  const failures = Number(existing?.consecutive_failures ?? 0) + 1;
  const retryDelayMinutes = Math.min(24 * 60, 15 * 2 ** Math.min(failures - 1, 7));
  return supabase("url_fetch_cache?on_conflict=canonical_url", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify([{
      canonical_url: canonicalUrl,
      final_url: existing?.final_url ?? canonicalUrl,
      content_hash: existing?.content_hash ?? null,
      processed_hash: existing?.processed_hash ?? null,
      source_id: existing?.source_id ?? null,
      http_status: error?.validation?.http_status ?? null,
      last_checked_at: checkedAt,
      last_changed_at: existing?.last_changed_at ?? null,
      last_processed_at: existing?.last_processed_at ?? null,
      processor_version: existing?.processor_version ?? null,
      consecutive_failures: failures,
      next_retry_at: new Date(Date.now() + retryDelayMinutes * 60_000).toISOString(),
      last_error: String(error?.code ?? error?.message ?? "FETCH_FAILED").slice(0, 300),
      updated_at: checkedAt,
    }]),
  });
}

export async function markPagesProcessed(items) {
  for (const item of items) {
    const canonicalUrl = canonicalizeUrl(item.page?.inputUrl ?? item.page?.finalUrl);
    if (!canonicalUrl) continue;
    const processedAt = new Date().toISOString();
    await supabase(`url_fetch_cache?canonical_url=eq.${encodeURIComponent(canonicalUrl)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        processed_hash: item.contentHash,
        last_processed_at: processedAt,
        processor_version: PROCESSOR_VERSION,
        updated_at: processedAt,
      }),
    });
  }
}

export async function deferPageProcessing(page, reason, { hours = 24 } = {}) {
  const canonicalUrl = canonicalizeUrl(page?.inputUrl ?? page?.finalUrl);
  if (!canonicalUrl) return null;
  return supabase(`url_fetch_cache?canonical_url=eq.${encodeURIComponent(canonicalUrl)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      next_retry_at: new Date(Date.now() + Math.max(1, Math.min(168, hours)) * 3_600_000).toISOString(),
      last_error: String(reason ?? "PROCESSING_DEFERRED").slice(0, 300),
    }),
  });
}

export function withProvenance(record, entries) {
  return {
    ...record,
    _provenance: [...(record._provenance ?? []), ...entries],
  };
}

function provenanceKey(parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex");
}

export async function persistProvenance(records, storedRecords, runId) {
  const idsByCanonicalKey = new Map(
    storedRecords
      .filter((row) => row.canonical_key && row.id)
      .map((row) => [row.canonical_key, row.id]),
  );
  const rows = [];
  for (const record of records) {
    const opportunityId = idsByCanonicalKey.get(record.canonical_key);
    if (!opportunityId) {
      throw new Error(`Stored opportunity missing for canonical key ${record.canonical_key}`);
    }
    for (const entry of record._provenance ?? []) {
      const observedAt = entry.observedAt ?? new Date().toISOString();
      const idempotencyKey = provenanceKey([
        opportunityId,
        runId,
        entry.provider,
        entry.queryId,
        entry.sourceId,
        entry.sourceUrl,
        entry.resultRank,
      ]);
      rows.push({
        idempotency_key: idempotencyKey,
        opportunity_id: opportunityId,
        pipeline_run_id: runId ?? null,
        provider: entry.provider,
        query_id: entry.queryId ?? null,
        query_text: entry.queryText ?? null,
        source_id: entry.sourceId ?? null,
        source_url: entry.sourceUrl,
        result_rank: entry.resultRank ?? null,
        observed_at: observedAt,
        metadata: entry.metadata ?? {},
      });
    }
  }
  if (!rows.length) return [];
  return supabase("opportunity_provenance?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: JSON.stringify(rows),
  });
}

export async function persistExistingPageProvenance(items, runId) {
  const entriesByUrl = new Map();
  for (const item of items) {
    for (const value of [item.page?.inputUrl, item.page?.finalUrl]) {
      const url = canonicalizeUrl(value);
      if (!url) continue;
      const entries = entriesByUrl.get(url) ?? [];
      entries.push(...(item.candidate?.provenance ?? []));
      entriesByUrl.set(url, entries);
    }
  }
  const urls = [...entriesByUrl.keys()];
  if (!urls.length) return [];

  const storedRecords = [];
  for (let index = 0; index < urls.length; index += 20) {
    const batch = urls.slice(index, index + 20);
    const params = new URLSearchParams({
      select: "id,canonical_key,source_url",
      source_url: `in.(${batch.map(quotedInValue).join(",")})`,
      limit: "1000",
    });
    storedRecords.push(...await supabase(`opportunities?${params.toString()}`));
  }
  const records = storedRecords.map((row) => ({
    canonical_key: row.canonical_key,
    _provenance: entriesByUrl.get(canonicalizeUrl(row.source_url)) ?? [],
  }));
  return persistProvenance(records, storedRecords, runId);
}

const NON_ORGANIZER_HOSTS = new Set([
  "filmfreeway.com",
  "festhome.com",
  "shortfilmdepot.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "vimeo.com",
  "forms.gle",
  "docs.google.com",
]);

export function productiveOrganizerSource(record) {
  const organizer = String(record?.organizer ?? "").trim();
  const url = canonicalizeUrl(record?.official_url);
  if (!url) return null;
  if (!["verified", "redirected"].includes(record?.official_url_status)) return null;
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if ([...NON_ORGANIZER_HOSTS].some((excluded) => host === excluded || host.endsWith(`.${excluded}`))) {
    return null;
  }
  return {
    host,
    name: organizer && !/^unknown organizer$/i.test(organizer)
      ? organizer.slice(0, 240)
      : host,
    url: `${parsed.protocol}//${parsed.host}/`,
  };
}

/** A validated productive organizer becomes a low-frequency registry source. */
export async function registerProductiveSources(records) {
  const candidates = new Map();
  for (const record of records) {
    const candidate = productiveOrganizerSource(record);
    if (candidate) candidates.set(candidate.host, candidate);
  }
  if (!candidates.size) return [];
  // Every registered source (the server returns 1,000 rows at a time): a
  // single read had let 488 duplicate organizer sources through.
  const known = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await supabase(`sources?select=id,url&order=id.asc&limit=1000&offset=${offset}`);
    known.push(...batch);
    if (batch.length < 1000) break;
  }
  const knownHosts = new Set(known.flatMap((row) => {
    try {
      return [new URL(row.url).hostname.replace(/^www\./i, "").toLowerCase()];
    } catch {
      return [];
    }
  }));
  const novel = [...candidates.values()].filter((item) => !knownHosts.has(item.host));
  if (!novel.length) return [];
  const rows = novel.map((item) => ({
    name: item.name,
    url: item.url,
    tier: 3,
    priority: 3,
    enabled: true,
    source_type: "official",
    source_family: "official-site",
    opportunity_categories: [],
    adapter: "link-window",
    adapter_config: { checkpoint_key: "organizer-home", link_window_size: 2 },
    min_poll_interval_minutes: 2_880,
    poll_interval_minutes: 10_080,
    max_poll_interval_minutes: 43_200,
    health_status: "healthy",
  }));
  const inserted = await supabase("sources?on_conflict=url", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: JSON.stringify(rows),
  });
  return inserted.map((row) => ({ id: row.id, host: new URL(row.url).hostname.replace(/^www\./i, "") }));
}
