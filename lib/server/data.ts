import "server-only";

import { demoOpportunities, demoPipelineHealth } from "@/lib/demo-data";
import {
  alignOpportunityPayload,
  INTEGRITY_OPPORTUNITY_FIELDS,
  reviewRequiredForAutomatedIngest,
} from "@/lib/ingest-payload.mjs";
import {
  buildOpportunitiesSearchParams,
  normalizeOpportunityQuery,
} from "@/lib/opportunity-pagination.mjs";
import type {
  OpportunitiesPage,
  Opportunity,
  OpportunityPageOptions,
  PipelineHealth,
  UrlVerificationStatus,
} from "@/lib/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishedStatuses = new Set(["verified", "open", "closing-soon", "closed"]);
const integrityOpportunityFields = new Set(INTEGRITY_OPPORTUNITY_FIELDS);
let integritySchemaSupport: Promise<boolean> | undefined;
let temporalReviewSupport: Promise<boolean> | undefined;

export const DEFAULT_OPPORTUNITIES_PAGE_SIZE = 24;
export const MAX_OPPORTUNITIES_PAGE_SIZE = 50;
export const MAX_OPPORTUNITIES_OFFSET = 100_000;

type JsonRecord = Record<string, unknown>;
type LinkKind = "source" | "official" | "application";

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeHttpUrl(value: unknown): string | null {
  const candidate = nullableString(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function normalizeUrlStatus(value: unknown): UrlVerificationStatus | undefined {
  if (
    value === "verified" ||
    value === "redirected" ||
    value === "invalid" ||
    value === "unreachable" ||
    value === "unchecked"
  ) {
    return value;
  }
  return undefined;
}

function acceptedHttpStatus(status: number | null) {
  return status === null || [200, 301, 302, 307, 308].includes(status);
}

function readLink(
  record: JsonRecord,
  rawPayload: JsonRecord,
  kind: LinkKind,
) {
  const rawValidation = asRecord(rawPayload.validation);
  const validationUrls = asRecord(rawValidation.urls);
  const validation = asRecord(validationUrls[kind]);
  const column = `${kind}_url`;
  const statusColumn = `${kind}_url_status`;
  const httpStatusColumn = `${kind}_url_http_status`;
  const checkedAtColumn = `${kind}_url_last_checked_at`;
  const finalColumn = `${kind}_url_final`;

  const status = normalizeUrlStatus(
    firstDefined(record[statusColumn], rawPayload[statusColumn], validation.status),
  );
  const httpStatus = nullableNumber(
    firstDefined(
      record[httpStatusColumn],
      rawPayload[httpStatusColumn],
      validation.http_status,
    ),
  );
  const lastCheckedAt = nullableString(
    firstDefined(
      record[checkedAtColumn],
      rawPayload[checkedAtColumn],
      validation.checked_at,
    ),
  );
  const url = safeHttpUrl(
    firstDefined(
      validation.final_url,
      record[finalColumn],
      rawPayload[finalColumn],
      record[column],
      rawPayload[column],
      validation.input_url,
    ),
  );
  const explicitlyVerified =
    (status === "verified" || status === "redirected") &&
    acceptedHttpStatus(httpStatus);

  return {
    url,
    status,
    httpStatus,
    lastCheckedAt,
    verified: Boolean(url) && explicitlyVerified,
  };
}

export function mapOpportunityRecord(record: JsonRecord): Opportunity {
  const rawPayload = asRecord(record.raw_payload);
  const verifiedAt = nullableString(record.verified_at);
  const source = readLink(record, rawPayload, "source");
  const official = readLink(record, rawPayload, "official");
  const application = readLink(record, rawPayload, "application");

  return {
    id: String(record.id),
    slug: String(record.slug),
    title: String(record.title),
    organizer: String(record.organizer),
    category: record.category as Opportunity["category"],
    status: record.status as Opportunity["status"],
    aiPolicy: record.ai_policy as Opportunity["aiPolicy"],
    deadline: nullableString(record.deadline),
    deadlineStatus:
      (firstDefined(record.deadline_status, rawPayload.deadline_status) as Opportunity["deadlineStatus"]) ?? "unknown",
    deadlineSourceUrl: safeHttpUrl(
      firstDefined(record.deadline_source_url, rawPayload.deadline_source_url),
    ),
    deadlineLastVerifiedAt: nullableString(
      firstDefined(
        record.deadline_last_verified_at,
        rawPayload.deadline_last_verified_at,
      ),
    ),
    opensAt: nullableString(record.opens_at),
    prizeAmount: nullableNumber(record.prize_amount),
    prizeCurrency:
      (record.prize_currency as Opportunity["prizeCurrency"]) ?? null,
    entryFeeAmount: nullableNumber(record.entry_fee_amount),
    entryFeeCurrency:
      (record.entry_fee_currency as Opportunity["entryFeeCurrency"]) ?? null,
    location: String(record.location ?? "Online"),
    remote: Boolean(record.remote),
    maxRuntimeMinutes: nullableNumber(record.max_runtime_minutes),
    sourceUrl: source.url,
    officialUrl: official.url,
    applicationUrl: application.url,
    sourceUrlStatus: source.status,
    officialUrlStatus: official.status,
    applicationUrlStatus: application.status,
    sourceUrlHttpStatus: source.httpStatus,
    officialUrlHttpStatus: official.httpStatus,
    applicationUrlHttpStatus: application.httpStatus,
    sourceUrlLastCheckedAt: source.lastCheckedAt,
    officialUrlLastCheckedAt: official.lastCheckedAt,
    applicationUrlLastCheckedAt: application.lastCheckedAt,
    sourceUrlVerified: source.verified,
    officialUrlVerified: official.verified,
    applicationUrlVerified: application.verified,
    sourceType:
      (record.source_type as Opportunity["sourceType"]) ?? "community",
    confidence: Number(record.confidence ?? 0),
    summary: String(record.summary ?? ""),
    eligibility: (record.eligibility as string[]) ?? [],
    formats: (record.formats as string[]) ?? [],
    tags: (record.tags as string[]) ?? [],
    discoveredAt: String(record.discovered_at),
    verifiedAt,
    reviewRequired: Boolean(record.review_required),
    hasConflict: Boolean(record.has_conflict),
    previousStatus: nullableString(record.previous_status) as Opportunity["previousStatus"],
    previousDeadline: nullableString(record.previous_deadline),
    featured: Boolean(record.featured),
  };
}

async function supabaseRequest(
  path: string,
  key: string | undefined,
  init?: RequestInit,
) {
  if (!SUPABASE_URL || !key) {
    throw new Error("Supabase is not configured");
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    next: { revalidate: 300 },
  });
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function supportsTemporalReview() {
  temporalReviewSupport ??= supabaseRequest(
    "opportunities?select=review_required&limit=1",
    SUPABASE_SERVICE_ROLE_KEY,
  ).then(() => true).catch((error: unknown) => {
    if (/Supabase 400:.*(?:review_required|PGRST204|42703)/i.test(String(error))) {
      return false;
    }
    temporalReviewSupport = undefined;
    throw error;
  });
  return temporalReviewSupport;
}

function clampPageOptions(options?: OpportunityPageOptions) {
  const requestedLimit = Math.trunc(
    options?.limit ?? DEFAULT_OPPORTUNITIES_PAGE_SIZE,
  );
  const requestedOffset = Math.trunc(options?.offset ?? 0);
  return {
    limit: Math.min(
      Math.max(requestedLimit, 1),
      MAX_OPPORTUNITIES_PAGE_SIZE,
    ),
    offset: Math.min(Math.max(requestedOffset, 0), MAX_OPPORTUNITIES_OFFSET),
  };
}

function responseTotal(response: Response, fallback: number) {
  const contentRange = response.headers.get("content-range");
  const total = contentRange?.match(/\/(\d+)$/)?.[1];
  return total ? Number(total) : fallback;
}

function buildPage(
  opportunities: Opportunity[],
  total: number,
  limit: number,
  offset: number,
  demoMode: boolean,
  error?: string,
): OpportunitiesPage {
  return {
    opportunities,
    total,
    limit,
    offset,
    hasMore: offset + opportunities.length < total,
    demoMode,
    ...(error ? { error } : {}),
  };
}

function getDemoPage(
  options?: OpportunityPageOptions,
  statuses?: Opportunity["status"][],
) {
  const { limit, offset } = clampPageOptions(options);
  const normalizedQuery = normalizeOpportunityQuery(options?.query).toLowerCase();
  const records = (statuses
    ? demoOpportunities.filter((item) => statuses.includes(item.status))
    : demoOpportunities
  )
    .filter((item) => {
      if (
        options?.category &&
        options.category !== "all" &&
        item.category !== options.category
      ) {
        return false;
      }
      if (
        options?.aiPolicy &&
        options.aiPolicy !== "all" &&
        item.aiPolicy !== options.aiPolicy
      ) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [item.title, item.organizer, item.summary, item.location]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((a, b) => {
      if (options?.sort === "newest") {
        return +new Date(b.discoveredAt) - +new Date(a.discoveredAt);
      }
      if (options?.sort === "prize") {
        return (b.prizeAmount ?? 0) - (a.prizeAmount ?? 0);
      }
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return +new Date(a.deadline) - +new Date(b.deadline);
    });
  return buildPage(
    records.slice(offset, offset + limit),
    records.length,
    limit,
    offset,
    true,
  );
}

export async function getOpportunitiesPage(
  options?: OpportunityPageOptions,
): Promise<OpportunitiesPage> {
  const { limit, offset } = clampPageOptions(options);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return getDemoPage({ ...options, limit, offset });
  }

  try {
    const query = buildOpportunitiesSearchParams({
      ...options,
      limit,
      offset,
    });
    const response = await supabaseRequest(
      `opportunities?${query.toString()}`,
      SUPABASE_ANON_KEY,
      { headers: { Prefer: "count=exact" } },
    );
    const records = (await response.json()) as JsonRecord[];
    const total = responseTotal(response, offset + records.length);
    return buildPage(
      records.map(mapOpportunityRecord),
      total,
      limit,
      offset,
      false,
    );
  } catch (error) {
    console.error("Unable to load live opportunities", error);
    return buildPage([], 0, limit, offset, false, "live-query-failed");
  }
}

/** @deprecated Prefer getOpportunitiesPage for bounded reads. */
export async function getOpportunities(): Promise<{
  opportunities: Opportunity[];
  demoMode: boolean;
}> {
  const page = await getOpportunitiesPage({
    limit: MAX_OPPORTUNITIES_PAGE_SIZE,
    offset: 0,
  });
  return { opportunities: page.opportunities, demoMode: page.demoMode };
}

export async function getReviewQueue(
  options?: OpportunityPageOptions,
): Promise<OpportunitiesPage> {
  const { limit, offset } = clampPageOptions(options);
  if (!SUPABASE_URL && !SUPABASE_SERVICE_ROLE_KEY) {
    return getDemoPage({ limit, offset }, ["signal", "discovered"]);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return buildPage([], 0, limit, offset, false, "review-query-unavailable");
  }

  try {
    const temporal = await supportsTemporalReview();
    const query = new URLSearchParams({
      select: "*",
      ...(temporal
        ? { or: "(status.in.(signal,discovered),review_required.eq.true)" }
        : { status: "in.(signal,discovered)" }),
      order: "discovered_at.desc,id.asc",
      limit: String(limit),
      offset: String(offset),
    });
    const response = await supabaseRequest(
      `opportunities?${query.toString()}`,
      SUPABASE_SERVICE_ROLE_KEY,
      { headers: { Prefer: "count=exact" } },
    );
    const records = (await response.json()) as JsonRecord[];
    const total = responseTotal(response, offset + records.length);
    return buildPage(
      records.map(mapOpportunityRecord),
      total,
      limit,
      offset,
      false,
    );
  } catch (error) {
    console.error("Unable to load the live review queue", error);
    return buildPage([], 0, limit, offset, false, "review-query-failed");
  }
}

export async function getPipelineHealth(): Promise<PipelineHealth> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return demoPipelineHealth;
  try {
    const temporal = await supportsTemporalReview();
    const [runsResponse, sourceResponse, openResponse, leadResponse] =
      await Promise.all([
        supabaseRequest(
          "pipeline_runs?select=kind,finished_at,status&order=finished_at.desc&limit=10",
          SUPABASE_SERVICE_ROLE_KEY,
        ),
        supabaseRequest("sources?select=id&enabled=eq.true", SUPABASE_SERVICE_ROLE_KEY),
        supabaseRequest(
          "opportunities?select=id&status=in.(open,closing-soon)",
          SUPABASE_SERVICE_ROLE_KEY,
        ),
        supabaseRequest(
          temporal
            ? "opportunities?select=id&or=(status.in.(signal,discovered),review_required.eq.true)"
            : "opportunities?select=id&status=in.(signal,discovered)",
          SUPABASE_SERVICE_ROLE_KEY,
        ),
      ]);
    const runs = (await runsResponse.json()) as Array<{
      kind: string;
      finished_at: string;
    }>;
    const lastDiscovery = runs.find((run) => run.kind === "discovery");
    const lastMonitor = runs.find((run) =>
      run.kind === "monitor" || run.kind === "refresh",
    );
    return {
      lastDiscoveryAt: lastDiscovery?.finished_at ?? null,
      lastMonitorAt: lastMonitor?.finished_at ?? null,
      sourcesTracked: ((await sourceResponse.json()) as unknown[]).length,
      recordsOpen: ((await openResponse.json()) as unknown[]).length,
      leadsPending: ((await leadResponse.json()) as unknown[]).length,
      demoMode: false,
    };
  } catch (error) {
    console.error("Unable to load live pipeline health", error);
    return {
      lastDiscoveryAt: null,
      lastMonitorAt: null,
      sourcesTracked: 0,
      recordsOpen: 0,
      leadsPending: 0,
      demoMode: false,
    };
  }
}

export async function upsertOpportunities(records: JsonRecord[]) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase service credentials are not configured");
  }
  integritySchemaSupport ??= supabaseRequest(
    "opportunities?select=canonical_key&limit=1",
    SUPABASE_SERVICE_ROLE_KEY,
  ).then(() => true);
  const integrity = await integritySchemaSupport;
  const reviewGate = await supportsTemporalReview();
  const conflictField = integrity ? "canonical_key" : "source_url";
  const collapsed = integrity
    ? records
    : [...new Map(records.map((record) => [String(record.source_url), record])).values()];
  const keys = collapsed.map((record) => record[conflictField]).filter(Boolean);
  const existing: JsonRecord[] = [];
  for (let index = 0; index < keys.length; index += 20) {
    const batch = keys.slice(index, index + 20);
    const quoted = batch.map((value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
    const query = new URLSearchParams({
      select: "*",
      [conflictField]: `in.(${quoted.join(",")})`,
      limit: "1000",
    });
    const existingResponse = await supabaseRequest(
      `opportunities?${query.toString()}`,
      SUPABASE_SERVICE_ROLE_KEY,
    );
    existing.push(...((await existingResponse.json()) as JsonRecord[]));
  }
  const existingByKey = new Map(existing.map((record) => [record[conflictField], record]));
  const mergedRecords = collapsed.map((incoming) => {
    const previous = existingByKey.get(incoming[conflictField]);
    const incomingCanonical = incoming.canonical_key ?? asRecord(incoming.raw_payload).canonical_key;
    const previousCanonical = previous?.canonical_key ?? asRecord(previous?.raw_payload).canonical_key;
    const differentLegacyEntity = !integrity
      && incomingCanonical
      && previousCanonical
      && incomingCanonical !== previousCanonical;
    const merged = differentLegacyEntity
      ? Number(incoming.confidence ?? 0) > Number(previous?.confidence ?? 0)
        ? { ...incoming }
        : { ...previous }
      : { ...incoming };
    if (previous && !differentLegacyEntity) {
      for (const [key, value] of Object.entries(incoming)) {
        if ((value === null || value === "" || (Array.isArray(value) && value.length === 0)) && previous[key] != null) {
          merged[key] = previous[key];
        }
      }
      if (publishedStatuses.has(String(previous.status))) merged.status = previous.status;
      if (previous.verified_at) merged.verified_at = previous.verified_at;
      if (previous.featured) merged.featured = true;
    }
    if (reviewGate) {
      merged.review_required = reviewRequiredForAutomatedIngest(
        differentLegacyEntity ? null : previous,
      );
    }
    if (!integrity) {
      const integrityPayload = Object.fromEntries(
        [...integrityOpportunityFields]
          .filter((key) => merged[key] !== undefined)
          .map((key) => [key, merged[key]]),
      );
      merged.raw_payload = {
        ...asRecord(merged.raw_payload),
        ...integrityPayload,
        integrity_schema_pending: true,
      };
    }
    return merged;
  });
  const prepared = alignOpportunityPayload(mergedRecords, { integrity, reviewGate });
  const response = await supabaseRequest(
    `opportunities?on_conflict=${conflictField}`,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(prepared),
    },
  );
  return (await response.json()) as JsonRecord[];
}
