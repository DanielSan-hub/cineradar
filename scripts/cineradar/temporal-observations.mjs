import { createHash } from "node:crypto";

import { supabase } from "./supabase.mjs";
import { canonicalizeUrl } from "./web-validation.mjs";

const MAX_RECORDS_PER_RUN = 1_000;
const DIRECTORY_FAMILIES = new Set(["structured-festival", "opportunity-directory", "news-feed"]);
const VALID_URL_STATUSES = new Set(["verified", "redirected"]);
const DEADLINE_STATUSES_WITH_DATE = new Set(["confirmed", "estimated"]);
const SOURCE_STATUSES = new Set(["open", "closing-soon", "closed"]);
const GENERIC_IDENTITY_WORDS = new Set([
  "ai", "animation", "annual", "applications", "arts", "award", "awards",
  "call", "challenge", "cinema", "competition", "contest", "creative",
  "entries", "experimental", "festival", "fellowship", "film", "films",
  "for", "fund", "funding", "global", "grant", "grants", "international",
  "lab", "media", "music", "new", "open", "projects", "residency", "short",
  "submissions", "video",
]);

function hashParts(parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex");
}

function hostOf(value) {
  const url = canonicalizeUrl(value);
  return url ? new URL(url).hostname.replace(/^www\./i, "").toLowerCase() : null;
}

function pathOf(value) {
  const url = canonicalizeUrl(value);
  return url ? new URL(url).pathname : null;
}

// Must remain identical to the historical backfill's series normalizer.
export function normalizedSeriesName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\b20\d{2}\b/g, " ")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedOrganizerName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function explicitEditionYear(record) {
  const years = [...new Set((String(record?.title ?? "").match(/\b20\d{2}\b/g) ?? []).map(Number))];
  if (years.length !== 1) return null;
  const year = years[0];
  if (year < 2000 || year > 2100 || Number(record?.edition_year) !== year) return null;
  return year;
}

function genericSeriesName(name) {
  return /^(?:open call|call for (?:entries|applications|projects|submissions)|applications?|submissions?|festival|film festival|funding|grants?|residency|competition|contest|challenge|past editions?|archive|history)$/iu.test(name)
    || /\b(?:archive|past editions|previous editions|winners|programme|program)\b/iu.test(name);
}

/** Entity creation requires a verified official page and a dated, non-generic identity. */
export function temporalEntityEvidence(record, source = null) {
  const sourceUrl = canonicalizeUrl(record?.source_url);
  const officialUrl = canonicalizeUrl(record?.official_url);
  const host = hostOf(sourceUrl);
  if (
    !sourceUrl || !officialUrl || !host
    || !source || source.source_type !== "official"
    || hostOf(source.url) !== host
    || record?.source_type !== "official"
    || !VALID_URL_STATUSES.has(record?.official_url_status)
    || hostOf(officialUrl) !== host
    || DIRECTORY_FAMILIES.has(source?.source_family)
  ) return null;

  const year = explicitEditionYear(record);
  if (!year) return null;
  const title = String(record.title ?? "").replace(/\s+/g, " ").trim();
  const seriesName = title.replace(/\b20\d{2}\b/g, " ")
    .replace(/\b\d{1,3}(?:st|nd|rd|th)\s+(?:annual\s+)?edition\b/giu, " ")
    .replace(/\s+/g, " ").trim();
  const normalizedName = normalizedSeriesName(seriesName);
  if (
    normalizedName.length < 10
    || normalizedName.split(" ").length < 2
    || genericSeriesName(normalizedName)
    || !normalizedName.split(" ").some((word) =>
      word.length >= 4 && !GENERIC_IDENTITY_WORDS.has(word),
    )
  ) return null;

  const organizerName = String(record?.organizer ?? "").replace(/\s+/g, " ").trim();
  const normalizedOrganizer = normalizedOrganizerName(organizerName);
  const hasOrganizer = Boolean(
    normalizedOrganizer.length >= 4
    && !/^(?:unknown organizer|unknown|not specified|n a)$/iu.test(normalizedOrganizer),
  );
  const seriesKey = `series:v1:${hashParts([host, normalizedName])}`;
  return {
    host,
    year,
    title,
    seriesName,
    normalizedName,
    seriesKey,
    editionKey: `edition:v1:${hashParts([seriesKey, year])}`,
    organizer: hasOrganizer ? {
      name: organizerName,
      normalizedName: normalizedOrganizer,
      key: `organizer:v1:${hashParts([host, normalizedOrganizer])}`,
    } : null,
    sourceUrl,
  };
}

function sourceIdFor(record) {
  const sourceUrl = canonicalizeUrl(record?.source_url);
  const requestedUrl = canonicalizeUrl(record?.raw_payload?.evidence?.source_url);
  const matching = (record?._provenance ?? []).find((entry) =>
    entry?.sourceId
      && [sourceUrl, requestedUrl].includes(canonicalizeUrl(entry.sourceUrl)),
  );
  return matching?.sourceId ?? null;
}

/** Lower values are stronger. A directory can never impersonate its listed organizer. */
export function temporalClaimPriority(record, source = null) {
  const family = source?.source_family;
  if (DIRECTORY_FAMILIES.has(family)) return 80;
  if (record?.source_type === "social") return 300;
  if (record?.source_type === "community") return 250;
  if (record?.source_type === "press") return 180;
  const official = record?.source_type === "official"
    && VALID_URL_STATUSES.has(record?.official_url_status)
    && hostOf(record?.official_url) === hostOf(record?.source_url);
  if (!official) return 120;
  if (canonicalizeUrl(record?.application_url) === canonicalizeUrl(record?.source_url)) return 10;
  return pathOf(record?.source_url) === "/" ? 40 : 20;
}

function observedDeadline(record) {
  const status = record?.deadline_status;
  const date = record?.deadline;
  const quote = record?.raw_payload?.evidence?.deadline_quote;
  if (!DEADLINE_STATUSES_WITH_DATE.has(status) || !date || !quote) {
    return { deadline: null, status: null };
  }
  const parsed = Date.parse(date);
  return Number.isFinite(parsed)
    ? { deadline: new Date(parsed).toISOString(), status }
    : { deadline: null, status: null };
}

function normalizedEvidenceText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function observedStatus(record, page) {
  const extraction = record?.raw_payload?.extraction ?? {};
  const rawStatus = extraction.observed_status ?? page?.observedStatus ?? null;
  const quote = extraction.status_evidence ?? page?.statusEvidence ?? null;
  const pageText = page?.pageText ?? page?.text ?? null;
  if (!SOURCE_STATUSES.has(rawStatus) || !quote || !pageText) {
    return { status: null, quote: null };
  }
  if (
    extraction.observed_status && page?.observedStatus
    && extraction.observed_status !== page.observedStatus
  ) return { status: null, quote: null };
  const normalizedQuote = normalizedEvidenceText(quote);
  if (
    normalizedQuote.length < 8 || normalizedQuote.length > 300
    || !normalizedEvidenceText(pageText).includes(normalizedQuote)
  ) return { status: null, quote: null };

  const openSignal = !/\b(?:no longer|not)\s+accepting\b/iu.test(normalizedQuote)
    && /\b(?:applications?|submissions?|entries)\s+(?:are\s+|now\s+)?open\b|\bopen\s+for\s+(?:applications?|submissions?|entries)\b|\baccepting\s+(?:applications?|submissions?|entries)\b/iu.test(normalizedQuote);
  const closedSignal = /\b(?:applications?|submissions?|entries)\s+(?:are\s+|now\s+)?closed\b|\b(?:no longer|not)\s+accepting\s+(?:applications?|submissions?|entries)\b|\b(?:deadline|call)\s+(?:has\s+)?(?:passed|closed)\b/iu.test(normalizedQuote);
  const closingSoonSignal = /\b(?:applications?|submissions?|entries)\s+clos(?:e|ing)\s+soon\b|\bclosing\s+soon\b/iu.test(normalizedQuote);
  if (rawStatus === "open" && openSignal && !closedSignal && !closingSoonSignal) {
    return { status: "open", quote: String(quote).trim().slice(0, 300) };
  }
  if (rawStatus === "closed" && closedSignal && !openSignal) {
    return { status: "closed", quote: String(quote).trim().slice(0, 300) };
  }
  if (rawStatus === "closing-soon" && closingSoonSignal && !closedSignal) {
    return { status: "closing-soon", quote: String(quote).trim().slice(0, 300) };
  }
  return { status: null, quote: null };
}

function evidenceSnapshot(record, deadline, status) {
  return {
    title: record.title ?? null,
    organizer: record.organizer ?? null,
    category: record.category ?? null,
    source_type: record.source_type ?? null,
    official_url: record.official_url ?? null,
    application_url: record.application_url ?? null,
    edition_year: record.edition_year ?? null,
    deadline: deadline.deadline,
    deadline_status: deadline.status ?? "unknown",
    deadline_quote: record?.raw_payload?.evidence?.deadline_quote ?? null,
    observed_status: status.status,
    status_quote: status.quote,
    normalization_warnings: record?.raw_payload?.normalization?.warnings ?? [],
    no_forecasting: true,
  };
}

function pageEvidenceFor(url, pageEvidence) {
  if (!url) return null;
  if (pageEvidence instanceof Map) return pageEvidence.get(url) ?? null;
  if (!Array.isArray(pageEvidence)) return null;
  return pageEvidence.find((item) => canonicalizeUrl(item.url) === url) ?? null;
}

async function rowByKey(client, table, field, key) {
  const rows = await client(`${table}?select=*&${field}=eq.${encodeURIComponent(key)}&limit=1`);
  return rows[0] ?? null;
}

async function insertIfAbsent(client, table, keyField, payload) {
  const inserted = await client(`${table}?on_conflict=${keyField}`, {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: JSON.stringify([payload]),
  });
  const row = inserted[0] ?? await rowByKey(client, table, keyField, payload[keyField]);
  if (!row) throw new Error(`TEMPORAL_${table.toUpperCase()}_WRITE_NOT_VISIBLE`);
  return { row, created: inserted.length > 0 };
}

async function loadSourceRows(client, records) {
  const ids = [...new Set(records.map(sourceIdFor).filter(Boolean))];
  const rows = [];
  for (let index = 0; index < ids.length; index += 20) {
    const batch = ids.slice(index, index + 20);
    rows.push(...await client(
      `sources?select=id,source_family,source_type,url&id=in.(${batch.join(",")})&limit=20`,
    ));
  }
  return new Map(rows.map((row) => [row.id, row]));
}

async function persistEntities(client, evidence, record, source, observedAt) {
  let organizer = null;
  let createdOrganizer = false;
  if (evidence.organizer) {
    const result = await insertIfAbsent(client, "organizers", "canonical_key", {
      canonical_key: evidence.organizer.key,
      canonical_name: evidence.organizer.name,
      normalized_name: evidence.organizer.normalizedName,
      website_url: `${new URL(evidence.sourceUrl).protocol}//${evidence.host}/`,
      metadata: { provenance: "verified_official_page", no_forecasting: true },
    });
    organizer = result.row;
    createdOrganizer = result.created;
  }

  const seriesResult = await insertIfAbsent(client, "event_series", "canonical_key", {
    canonical_key: evidence.seriesKey,
    organizer_id: organizer?.id ?? null,
    name: evidence.seriesName,
    normalized_name: evidence.normalizedName,
    official_url: evidence.sourceUrl,
    source_family: source?.source_family ?? "official-site",
    category: record.category ?? null,
    recurring: false,
    earliest_known_year: evidence.year,
    latest_known_year: evidence.year,
    metadata: { provenance: "verified_official_dated_page", no_forecasting: true },
  });
  const series = seriesResult.row;
  if (organizer && series.organizer_id && series.organizer_id !== organizer.id) {
    throw new Error("TEMPORAL_SERIES_ORGANIZER_CONFLICT");
  }
  if (series.normalized_name !== evidence.normalizedName) {
    throw new Error("TEMPORAL_SERIES_IDENTITY_CONFLICT");
  }
  if (!seriesResult.created) {
    const earliest = Math.min(Number(series.earliest_known_year ?? evidence.year), evidence.year);
    const latest = Math.max(Number(series.latest_known_year ?? evidence.year), evidence.year);
    const patch = {};
    if (earliest !== series.earliest_known_year) patch.earliest_known_year = earliest;
    if (latest !== series.latest_known_year) patch.latest_known_year = latest;
    if (latest > earliest && !series.recurring) patch.recurring = true;
    if (organizer && !series.organizer_id) patch.organizer_id = organizer.id;
    if (Object.keys(patch).length) {
      // A page observed before this series row was created (e.g. from the URL
      // cache) must not move last_seen_at before first_seen_at or backwards.
      // Keep the stored string when it is the latest: Postgres keeps
      // microseconds, and re-serialising through Date would truncate them to
      // milliseconds and land just before first_seen_at.
      const latestSeen = [series.first_seen_at, series.last_seen_at, observedAt]
        .filter((value) => Number.isFinite(Date.parse(value)))
        .reduce((best, value) => (Date.parse(value) > Date.parse(best) ? value : best));
      patch.last_seen_at = latestSeen;
      await client(`event_series?id=eq.${encodeURIComponent(series.id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify(patch),
      });
    }
  }

  const editionResult = await insertIfAbsent(client, "opportunity_editions", "edition_key", {
    edition_key: evidence.editionKey,
    event_series_id: series.id,
    edition_label: String(evidence.year),
    edition_year: evidence.year,
    title: evidence.title,
    status: "discovered",
    source_url: evidence.sourceUrl,
    metadata: { provenance: "verified_official_dated_page", no_forecasting: true },
  });
  if (
    editionResult.row.event_series_id !== series.id
    || Number(editionResult.row.edition_year) !== evidence.year
  ) throw new Error("TEMPORAL_EDITION_IDENTITY_CONFLICT");
  return {
    editionId: editionResult.row.id,
    organizerCreated: createdOrganizer,
    seriesCreated: seriesResult.created,
    editionCreated: editionResult.created,
  };
}

/**
 * Persist evidence after ingestion. `pageEvidence` optionally maps source URLs
 * to `{contentHash, observedAt}`; without it, structured facts form the stable
 * idempotency fingerprint. The caller must assert the temporal schema first.
 */
const OBSERVATION_RULE_REFUSAL = /idempotency key belongs to different observation evidence|observation edition conflicts with opportunity edition/;

export async function persistTemporalObservations(
  records,
  storedRecords,
  runId,
  { client = supabase, pageEvidence = [], sourceRows = null } = {},
) {
  if (!Array.isArray(records) || !Array.isArray(storedRecords)) {
    throw new TypeError("Temporal observation inputs must be arrays");
  }
  if (records.length > MAX_RECORDS_PER_RUN) {
    throw new Error("TEMPORAL_RECORD_LIMIT_EXCEEDED");
  }
  const rowsByKey = new Map(storedRecords.map((row) => [row.canonical_key, row]));
  const sources = sourceRows
    ? new Map(sourceRows.map((row) => [row.id, row]))
    : await loadSourceRows(client, records);
  const counts = {
    observationsInserted: 0,
    observationsReplayed: 0,
    organizersCreated: 0,
    seriesCreated: 0,
    editionsCreated: 0,
    entityEvidenceSkipped: 0,
    entityConflictsSkipped: 0,
    observationsRefused: 0,
    conflictsObserved: 0,
  };

  for (const record of records) {
    const stored = rowsByKey.get(record?.canonical_key);
    if (!stored?.id || !record?.canonical_key) {
      throw new Error(`TEMPORAL_STORED_OPPORTUNITY_MISSING: ${record?.canonical_key ?? "unknown"}`);
    }
    const sourceUrl = canonicalizeUrl(record.source_url);
    if (!sourceUrl) throw new Error("TEMPORAL_SOURCE_URL_MISSING");
    const sourceId = sourceIdFor(record);
    const source = sourceId ? sources.get(sourceId) : null;
    if (sourceId && !source) throw new Error(`TEMPORAL_SOURCE_MISSING: ${sourceId}`);
    const page = pageEvidenceFor(sourceUrl, pageEvidence)
      ?? pageEvidenceFor(
        canonicalizeUrl(record?.raw_payload?.evidence?.source_url),
        pageEvidence,
      );
    const deadline = observedDeadline(record);
    const status = observedStatus(record, page);
    const snapshot = evidenceSnapshot(record, deadline, status);
    const snapshotHash = hashParts([JSON.stringify(snapshot)]);
    const contentHash = page?.contentHash ?? null;
    const observedAt = page?.observedAt
      ?? record.source_url_last_checked_at
      ?? record.discovered_at
      ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(observedAt))) {
      throw new Error("TEMPORAL_INVALID_OBSERVED_AT");
    }

    const evidence = temporalEntityEvidence(record, source);
    let entities = null;
    if (evidence) {
      try {
        entities = await persistEntities(client, evidence, record, source, observedAt);
        if (
          stored.opportunity_edition_id
          && stored.opportunity_edition_id !== entities.editionId
        ) throw new Error("TEMPORAL_OPPORTUNITY_EDITION_CONFLICT");
      } catch (error) {
        // Two organizers or editions resolving to one series identity must not
        // be merged, but one ambiguous record must not abort the whole run:
        // keep the observation and leave this record unlinked.
        if (!/^TEMPORAL_(?:SERIES_(?:ORGANIZER|IDENTITY)_CONFLICT|OPPORTUNITY_EDITION_CONFLICT)$/.test(error.message)) throw error;
        console.warn(`Series link skipped for ${record.canonical_key}: ${error.message}`);
        counts.entityConflictsSkipped += 1;
        entities = null;
      }
    } else {
      counts.entityEvidenceSkipped += 1;
    }

    let result;
    try {
      result = await client("rpc/record_opportunity_observation", {
        method: "POST",
        body: JSON.stringify({
          p_idempotency_key: hashParts([
            "temporal:v1", stored.id, sourceUrl, contentHash, snapshotHash,
          ]),
          p_opportunity_id: stored.id,
          p_pipeline_run_id: runId ?? null,
          p_source_id: sourceId,
          p_opportunity_edition_id: entities?.editionId ?? null,
          p_source_url: sourceUrl,
          p_content_hash: contentHash,
          p_observed_at: observedAt,
          // `discovered` is a pipeline state, never an observed source claim.
          p_observed_status: status.status,
          p_observed_deadline: deadline.deadline,
          // PostgreSQL's claim expression must receive a non-null status:
          // NULL = 'rolling' is NULL, which can make applied_to_current NULL.
          p_deadline_status: deadline.status ?? "unknown",
          p_is_primary_evidence: temporalClaimPriority(record, source) <= 40,
          p_claim_priority: temporalClaimPriority(record, source),
          p_observed_fields: snapshot,
        }),
      });
    } catch (error) {
      // The same page and evidence reached through another provenance (monitor
      // vs gap search) reuses the key with a different source: the first
      // observation already holds this evidence. Business-rule refusals are
      // counted; outages and other errors still fail the run visibly.
      if (!OBSERVATION_RULE_REFUSAL.test(String(error.message))) throw error;
      console.warn(`Observation skipped for ${record.canonical_key}: ${String(error.message).slice(0, 160)}`);
      counts.observationsRefused += 1;
      continue;
    }
    if (result?.inserted === true) counts.observationsInserted += 1;
    else if (result?.idempotent_replay === true) counts.observationsReplayed += 1;
    else throw new Error("TEMPORAL_OBSERVATION_RPC_INVALID_RESPONSE");
    counts.conflictsObserved += Number(result.conflict_count ?? 0);
    counts.organizersCreated += Number(entities?.organizerCreated ?? false);
    counts.seriesCreated += Number(entities?.seriesCreated ?? false);
    counts.editionsCreated += Number(entities?.editionCreated ?? false);
  }
  return counts;
}
