import { config, requireEnv } from "./config.mjs";
import { fetchWithTimeout } from "./http.mjs";

const LEGACY_FIELDS = new Set([
  "slug", "title", "organizer", "category", "status", "ai_policy",
  "deadline", "opens_at", "prize_amount", "prize_currency",
  "entry_fee_amount", "entry_fee_currency", "location", "remote",
  "max_runtime_minutes", "source_url", "official_url", "source_type",
  "confidence", "summary", "eligibility", "formats", "tags",
  "discovered_at", "verified_at", "featured", "content_hash", "raw_payload",
]);

const INTEGRITY_FIELDS = new Set([
  "canonical_key", "edition_year", "application_url", "deadline_status",
  "deadline_source_url", "deadline_last_verified_at",
  "source_url_status", "source_url_http_status", "source_url_final",
  "source_url_last_checked_at", "source_url_verified_at",
  "official_url_status", "official_url_http_status", "official_url_final",
  "official_url_last_checked_at", "official_url_verified_at",
  "application_url_status", "application_url_http_status", "application_url_final",
  "application_url_last_checked_at", "application_url_verified_at",
]);

const PUBLISHED_STATUSES = new Set(["verified", "open", "closing-soon", "closed"]);
let integritySchemaPromise;

function headers(prefer) {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function supabaseResponse(path, init = {}) {
  const base = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  return fetchWithTimeout(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(init.prefer), ...(init.headers ?? {}) },
  });
}

export async function supabase(path, init = {}) {
  const response = await supabaseResponse(path, init);
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}

export async function supportsIntegritySchema() {
  integritySchemaPromise ??= (async () => {
    const response = await supabaseResponse("opportunities?select=canonical_key&limit=1");
    if (response.ok) return true;
    if (response.status === 400) {
      await response.body?.cancel?.().catch?.(() => {});
      return false;
    }
    throw new Error(`Unable to inspect Supabase schema (${response.status})`);
  })();
  return integritySchemaPromise;
}

export async function startRun(kind) {
  const [run] = await supabase("pipeline_runs", {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify({ kind, status: "running" }),
  });
  return run;
}

export async function finishRun(id, values) {
  const integrity = await supportsIntegritySchema();
  const legacy = ["status", "candidates", "records_written", "error"];
  const allowed = integrity
    ? [...legacy, "discovered", "fetched", "parsed", "validated", "duplicates", "rejected", "stored", "rejection_reasons"]
    : legacy;
  const body = Object.fromEntries(
    allowed.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]),
  );
  body.finished_at = new Date().toISOString();
  return supabase(`pipeline_runs?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(body),
  });
}

function withLegacyFallbackPayload(record) {
  const integrity = Object.fromEntries(
    [...INTEGRITY_FIELDS]
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
  return {
    ...record,
    raw_payload: {
      ...(record.raw_payload ?? {}),
      ...integrity,
      integrity_schema_pending: true,
    },
  };
}

function sanitizeRecord(record, integrity) {
  const prepared = integrity ? record : withLegacyFallbackPayload(record);
  const allowed = integrity ? new Set([...LEGACY_FIELDS, ...INTEGRITY_FIELDS]) : LEGACY_FIELDS;
  return Object.fromEntries(
    Object.entries(prepared).filter(([key, value]) => allowed.has(key) && value !== undefined),
  );
}

function quotedInValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function fetchExisting(field, values) {
  const unique = [...new Set(values.filter(Boolean))];
  const rows = [];
  for (let index = 0; index < unique.length; index += 20) {
    const batch = unique.slice(index, index + 20);
    const params = new URLSearchParams({
      select: "*",
      [field]: `in.(${batch.map(quotedInValue).join(",")})`,
      limit: "1000",
    });
    rows.push(...await supabase(`opportunities?${params.toString()}`));
  }
  return rows;
}

function shouldKeepExisting(value) {
  return value !== null && value !== undefined && value !== "";
}

function mergeWithExisting(incoming, existing, conflictField) {
  if (!existing) return incoming;
  const incomingCanonical = incoming.canonical_key ?? incoming.raw_payload?.canonical_key;
  const existingCanonical = existing.canonical_key ?? existing.raw_payload?.canonical_key;
  if (
    conflictField === "source_url"
    && incomingCanonical
    && existingCanonical
    && incomingCanonical !== existingCanonical
  ) {
    return Number(incoming.confidence ?? 0) > Number(existing.confidence ?? 0)
      ? incoming
      : existing;
  }
  const merged = { ...incoming };
  for (const [key, value] of Object.entries(incoming)) {
    if (
      (!shouldKeepExisting(value) || (Array.isArray(value) && value.length === 0))
      && shouldKeepExisting(existing[key])
    ) {
      merged[key] = existing[key];
    }
  }
  if (PUBLISHED_STATUSES.has(existing.status)) merged.status = existing.status;
  if (existing.verified_at) merged.verified_at = existing.verified_at;
  if (existing.featured) merged.featured = true;
  if (existing.discovered_at) merged.discovered_at = existing.discovered_at;
  return merged;
}

function collapseLegacySourceConflicts(records) {
  const bySource = new Map();
  for (const record of records) {
    const current = bySource.get(record.source_url);
    if (!current || Number(record.confidence ?? 0) > Number(current.confidence ?? 0)) {
      bySource.set(record.source_url, record);
    }
  }
  return [...bySource.values()];
}

export async function ingest(records) {
  if (!records.length) return { records: [], stored: 0, inserted: 0, updated: 0, legacyCollapsed: 0 };
  if (config.ingestUrl && config.ingestSecret) {
    const response = await fetchWithTimeout(config.ingestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ingestSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(records),
    });
    if (!response.ok) throw new Error(`CineRadar ingest ${response.status}: ${await response.text()}`);
    const body = await response.json();
    return {
      records: body.records ?? [],
      stored: Number(body.accepted ?? body.records?.length ?? records.length),
      inserted: Number(body.inserted ?? 0),
      updated: Number(body.updated ?? 0),
      legacyCollapsed: 0,
    };
  }

  const integrity = await supportsIntegritySchema();
  const input = integrity ? records : collapseLegacySourceConflicts(records);
  const conflictField = integrity ? "canonical_key" : "source_url";
  const existingRows = await fetchExisting(conflictField, input.map((record) => record[conflictField]));
  const existingByKey = new Map(existingRows.map((record) => [record[conflictField], record]));
  const prepared = input.map((record) => sanitizeRecord(
    mergeWithExisting(record, existingByKey.get(record[conflictField]), conflictField),
    integrity,
  ));
  const storedRecords = await supabase(`opportunities?on_conflict=${conflictField}`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify(prepared),
  });
  const updated = prepared.filter((record) => existingByKey.has(record[conflictField])).length;
  return {
    records: storedRecords,
    stored: storedRecords.length,
    inserted: prepared.length - updated,
    updated,
    legacyCollapsed: records.length - input.length,
  };
}
