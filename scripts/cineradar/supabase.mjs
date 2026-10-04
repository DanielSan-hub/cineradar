import { config, requireEnv } from "./config.mjs";
import { fetchWithTimeout } from "./http.mjs";
import {
  alignOpportunityPayload,
  INTEGRITY_OPPORTUNITY_FIELDS,
  reviewRequiredForAutomatedIngest,
} from "../../lib/ingest-payload.mjs";

const INTEGRITY_FIELDS = new Set(INTEGRITY_OPPORTUNITY_FIELDS);

const PUBLISHED_STATUSES = new Set(["verified", "open", "closing-soon", "closed"]);
let integritySchemaConfirmed = false;
let operationalSchemaConfirmed = false;
let sourceRegistrySchemaConfirmed = false;
let temporalSchemaConfirmed = false;

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

/**
 * GET rows whose `column` is in `values`, in chunks: a single `in.(...)` list
 * of hundreds of UUIDs makes the URL too long and the gateway answers 400.
 *
 * @param {string} table
 * @param {string} select
 * @param {string} column
 * @param {string[]} values
 */
export async function selectIn(table, select, column, values, { chunk = 100 } = {}) {
  const rows = [];
  const unique = [...new Set(values.filter(Boolean))];
  for (let index = 0; index < unique.length; index += chunk) {
    const batch = unique.slice(index, index + chunk);
    rows.push(...await supabase(`${table}?select=${select}&${column}=in.(${batch.join(",")})&limit=${chunk * 20}`));
  }
  return rows;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One PostgREST request. A dropped connection ("fetch failed") or a gateway
 * hiccup (429/502/503/504) is retried up to three times with backoff: a
 * single transient network error used to abort a 30-minute monitor run.
 */
export async function supabase(path, init = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await supabaseResponse(path, init);
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < 4) {
      await response.text().catch(() => "");
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
    return parseSupabasePayload(response);
  }
}

export async function parseSupabasePayload(response) {
  if (response.status === 204) return null;
  const body = await response.text();
  return body.trim() ? JSON.parse(body) : null;
}

export async function supportsIntegritySchema() {
  if (integritySchemaConfirmed) return true;
  const response = await supabaseResponse("opportunities?select=canonical_key&limit=1");
  if (response.ok) {
    await response.body?.cancel?.().catch?.(() => {});
    integritySchemaConfirmed = true;
    return true;
  }
  const detail = await response.text();
  if (
    response.status === 400
    && /canonical_key/i.test(detail)
    && /(?:does not exist|schema cache|42703|PGRST)/i.test(detail)
  ) {
    return false;
  }
  throw new Error(
    `Unable to inspect Supabase integrity schema (${response.status}): ${detail.slice(0, 300)}`,
  );
}

export async function assertOperationalSchema() {
  if (operationalSchemaConfirmed) return true;
  if (!await supportsIntegritySchema()) {
    throw new Error(
      "OPERATIONAL_SCHEMA_REQUIRED: apply 202609220001_opportunity_integrity_and_audit.sql",
    );
  }
  try {
    const [usage, provenance, cache, missingKeys] = await Promise.all([
      supabase("provider_usage_events?select=id&limit=1"),
      supabase("opportunity_provenance?select=id&limit=1"),
      supabase("url_fetch_cache?select=canonical_url&limit=1"),
      supabase("opportunities?select=id&canonical_key=is.null&limit=1"),
    ]);
    void usage;
    void provenance;
    void cache;
    if (missingKeys.length) {
      throw new Error(
        "CANONICAL_KEY_BACKFILL_REQUIRED: run radar:backfill-integrity",
      );
    }
  } catch (error) {
    if (/CANONICAL_KEY_BACKFILL_REQUIRED/.test(error.message)) throw error;
    throw new Error(
      `OPERATIONAL_SCHEMA_REQUIRED: apply 202609230001_operational_controls.sql (${error.message})`,
    );
  }
  operationalSchemaConfirmed = true;
  return true;
}

export async function assertSourceRegistrySchema() {
  if (sourceRegistrySchemaConfirmed) return true;
  await assertOperationalSchema();
  try {
    await Promise.all([
      supabase("sources?select=id,source_family,priority,next_check_at,adapter&limit=1"),
      supabase("source_checkpoints?select=id&limit=1"),
      supabase("discovery_attempts?select=id&limit=1"),
      supabase("discovered_urls?select=id&limit=1"),
    ]);
  } catch (error) {
    throw new Error(
      `SOURCE_REGISTRY_SCHEMA_REQUIRED: apply 202609230002_source_registry_and_economics.sql (${error.message})`,
    );
  }
  sourceRegistrySchemaConfirmed = true;
  return true;
}

export async function assertTemporalSchema() {
  if (temporalSchemaConfirmed) return true;
  await assertSourceRegistrySchema();
  try {
    await Promise.all([
      supabase("event_series?select=id&limit=1"),
      supabase("opportunity_editions?select=id&limit=1"),
      supabase("opportunity_observations?select=id&limit=1"),
      supabase("opportunities?select=id,first_seen_at,last_seen_at,review_required&limit=1"),
    ]);
  } catch (error) {
    throw new Error(
      `TEMPORAL_SCHEMA_REQUIRED: apply 202609230003_temporal_history.sql (${error.message})`,
    );
  }
  temporalSchemaConfirmed = true;
  return true;
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

function mergeWithExisting(incoming, existing, conflictField, { temporalProjection = false } = {}) {
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
  if (temporalProjection) {
    for (const field of [
      "status", "deadline", "deadline_status", "deadline_source_url",
      "deadline_last_verified_at", "previous_deadline", "previous_status",
      "has_conflict", "review_required", "opportunity_edition_id",
      "first_seen_at", "last_seen_at", "last_verified_at",
    ]) {
      if (field in existing) merged[field] = existing[field];
    }
  }
  if (temporalProjection) {
    // An automated status claim may update the row later. Keep new and
    // unreviewed rows behind RLS even if that claim says "open".
    merged.review_required = reviewRequiredForAutomatedIngest(existing);
  }
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

export async function ingest(records, { temporalProjection = false } = {}) {
  if (!records.length) return { records: [], stored: 0, inserted: 0, updated: 0, legacyCollapsed: 0, insertedCanonicalKeys: [] };
  if (config.ingestUrl && config.ingestSecret && !temporalProjection) {
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
      insertedCanonicalKeys: Array.isArray(body.insertedCanonicalKeys)
        ? body.insertedCanonicalKeys : [],
    };
  }

  const integrity = await supportsIntegritySchema();
  const input = integrity ? records : collapseLegacySourceConflicts(records);
  const conflictField = integrity ? "canonical_key" : "source_url";
  const existingRows = await fetchExisting(conflictField, input.map((record) => record[conflictField]));
  const existingByKey = new Map(existingRows.map((record) => [record[conflictField], record]));
  const merged = input.map((record) => {
    const next = mergeWithExisting(
      record,
      existingByKey.get(record[conflictField]),
      conflictField,
      { temporalProjection },
    );
    if (temporalProjection && !existingByKey.has(record[conflictField])) {
      next.review_required = true;
    }
    return integrity ? next : withLegacyFallbackPayload(next);
  });
  const prepared = alignOpportunityPayload(merged, {
    integrity,
    reviewGate: temporalProjection,
  });
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
    insertedCanonicalKeys: prepared
      .filter((record) => !existingByKey.has(record[conflictField]))
      .map((record) => record.canonical_key)
      .filter(Boolean),
  };
}
