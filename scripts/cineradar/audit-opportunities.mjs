import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const localEnvPath = resolve(scriptDirectory, "..", "..", ".env.local");

if (existsSync(localEnvPath) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(localEnvPath);
}

const pageSize = 1000;
const timeoutMs = Number(process.env.HTTP_TIMEOUT_MS ?? 12000);
const publishedStatuses = new Set(["verified", "open", "closing-soon"]);
const acceptedHttpStatuses = new Set([200, 301, 302, 307, 308]);
const expectedStatuses = [
  "signal",
  "discovered",
  "verified",
  "open",
  "closing-soon",
  "closed",
];

const enhancedColumns = [
  "id",
  "slug",
  "title",
  "organizer",
  "location",
  "status",
  "deadline",
  "opens_at",
  "deadline_status",
  "canonical_key",
  "edition_year",
  "source_url",
  "official_url",
  "application_url",
  "source_url_status",
  "source_url_http_status",
  "source_url_final",
  "official_url_status",
  "official_url_http_status",
  "official_url_final",
  "application_url_status",
  "application_url_http_status",
  "application_url_final",
  "raw_payload",
];

const legacyColumns = [
  "id",
  "slug",
  "title",
  "organizer",
  "location",
  "status",
  "deadline",
  "opens_at",
  "source_url",
  "official_url",
  "raw_payload",
];

class SupabaseAuditError extends Error {
  constructor(status, operation) {
    super(`Supabase returned HTTP ${status} while ${operation}`);
    this.name = "SupabaseAuditError";
    this.status = status;
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function endpoint(baseUrl, columns) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/rest/v1/opportunities`);
  url.searchParams.set("select", columns.join(","));
  url.searchParams.set("order", "id.asc");
  return url;
}

function authHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...extra,
  };
}

async function fetchAllRows(baseUrl, serviceKey, columns) {
  const rows = [];
  for (let start = 0; ; start += pageSize) {
    const response = await fetchWithTimeout(endpoint(baseUrl, columns), {
      headers: authHeaders(serviceKey, {
        Range: `${start}-${start + pageSize - 1}`,
        "Range-Unit": "items",
      }),
    });
    if (!response.ok) {
      throw new SupabaseAuditError(response.status, "reading opportunities");
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("Supabase returned a non-array payload");
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchExactPublicCount(baseUrl, anonKey) {
  const url = endpoint(baseUrl, ["id"]);
  url.searchParams.delete("order");
  const response = await fetchWithTimeout(url, {
    headers: authHeaders(anonKey, {
      Range: "0-0",
      "Range-Unit": "items",
      Prefer: "count=exact",
    }),
  });
  if (!response.ok) {
    throw new SupabaseAuditError(response.status, "checking anonymous visibility");
  }
  const contentRange = response.headers.get("content-range") ?? "";
  const match = contentRange.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function countBy(rows, selector, initialKeys = []) {
  const counts = Object.fromEntries(initialKeys.map((key) => [key, 0]));
  for (const row of rows) {
    const key = selector(row) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function timestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isHttpUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function classifyLink(row, prefix) {
  const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
  const validation = raw.validation?.urls?.[prefix] ?? {};
  const value = row[`${prefix}_url`] ?? raw[`${prefix}_url`] ?? validation.input_url ?? validation.final_url;
  const status = row[`${prefix}_url_status`] ?? raw[`${prefix}_url_status`] ?? validation.status ?? "unchecked";
  const httpStatus = Number(row[`${prefix}_url_http_status`] ?? raw[`${prefix}_url_http_status`] ?? validation.http_status);
  const finalUrl = row[`${prefix}_url_final`] ?? raw[`${prefix}_url_final`] ?? validation.final_url;

  if (!value) return "missing";
  if (!isHttpUrl(value) || (finalUrl && !isHttpUrl(finalUrl))) return "malformed";
  if (status === "invalid" || httpStatus === 404 || httpStatus === 410) return "invalid";
  if (status === "unreachable" || (httpStatus >= 500 && httpStatus <= 599)) {
    return "unreachable";
  }
  if (status === "verified" || status === "redirected") return "verified";
  if (status === "unchecked" && !Number.isFinite(httpStatus)) return "unchecked";
  if (acceptedHttpStatuses.has(httpStatus)) return "verified-metadata-missing";
  return "needs-review";
}

function normalizeIdentity(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function duplicateReport(rows, keySelector) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keySelector(row);
    if (!key) continue;
    const members = grouped.get(key) ?? [];
    members.push(row.id);
    grouped.set(key, members);
  }
  const groups = [...grouped.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort((left, right) => right[1].length - left[1].length)
    .map(([key, ids]) => ({ key_hash: digest(key), count: ids.length, ids }));
  return {
    group_count: groups.length,
    row_count: groups.reduce((total, group) => total + group.count, 0),
    groups: groups.slice(0, 100),
    truncated: groups.length > 100,
  };
}

function buildReport(rows, schemaMode, publicCount, publicCheck) {
  const now = Date.now();
  const expired = rows.filter((row) => {
    const deadline = timestamp(row.deadline);
    return row.status === "closed" || (deadline !== null && deadline < now);
  });
  const expiredIds = new Set(expired.map((row) => row.id));
  const upcoming = rows.filter((row) => {
    const opensAt = timestamp(row.opens_at);
    return !expiredIds.has(row.id) && opensAt !== null && opensAt > now;
  });
  const upcomingIds = new Set(upcoming.map((row) => row.id));
  const active = rows.filter(
    (row) => !expiredIds.has(row.id) && !upcomingIds.has(row.id),
  );
  const unknownDeadline = rows.filter(
    (row) => !row.deadline || (row.deadline_status ?? row.raw_payload?.deadline_status ?? "unknown") === "unknown",
  );
  const expectedPublicRows = rows.filter((row) => publishedStatuses.has(row.status));

  const linkKinds = ["source", "official", "application"];
  const linkReport = {};
  const invalidOpportunityIds = new Set();
  for (const kind of linkKinds) {
    const classifications = rows.map((row) => ({
      id: row.id,
      classification: classifyLink(row, kind),
    }));
    const counts = countBy(
      classifications,
      (item) => item.classification,
      [
        "verified",
        "verified-metadata-missing",
        "unchecked",
        "invalid",
        "unreachable",
        "malformed",
        "needs-review",
        "missing",
      ],
    );
    for (const item of classifications) {
      if (["invalid", "unreachable", "malformed"].includes(item.classification)) {
        invalidOpportunityIds.add(item.id);
      }
    }
    linkReport[kind] = counts;
  }

  const identityKey = (row) => {
    const title = normalizeIdentity(row.title);
    const organizer = normalizeIdentity(row.organizer);
    if (!title || !organizer) return null;
    return [
      title,
      organizer,
      row.edition_year ?? row.raw_payload?.edition_year ?? "year-unknown",
      normalizeIdentity(row.location) || "location-unknown",
    ].join("|");
  };

  const titleEditionLocationKey = (row) => {
    const title = normalizeIdentity(row.title);
    if (!title) return null;
    return [
      title,
      row.edition_year ?? row.raw_payload?.edition_year ?? "year-unknown",
      normalizeIdentity(row.location) || "location-unknown",
    ].join("|");
  };

  return {
    GENERATED_AT: new Date().toISOString(),
    SCHEMA_MODE: schemaMode,
    DEFINITIONS: {
      ACTIVE: "not closed or past deadline, and opens_at is not in the future",
      UPCOMING: "not expired and opens_at is in the future",
      EXPIRED: "status is closed or deadline is in the past",
      UNKNOWN: "deadline is absent or deadline_status is unknown",
      VISIBLE_ON_WEBSITE: "rows allowed by the unchanged public RLS status policy",
    },
    TOTAL: rows.length,
    STATUS: countBy(rows, (row) => row.status, expectedStatuses),
    ACTIVE: active.length,
    UPCOMING: upcoming.length,
    EXPIRED: expired.length,
    UNKNOWN: unknownDeadline.length,
    PUBLISHED: expectedPublicRows.length,
    LINKS: {
      ...linkReport,
      INVALID_OR_UNREACHABLE_OPPORTUNITIES: invalidOpportunityIds.size,
      MISSING_OFFICIAL_URL: linkReport.official.missing,
      MISSING_APPLICATION_URL: linkReport.application.missing,
    },
    DUPLICATE_GROUPS: {
      canonical_key: duplicateReport(rows, (row) => row.canonical_key?.trim() || row.raw_payload?.canonical_key?.trim() || null),
      identity_heuristic: duplicateReport(rows, identityKey),
      title_edition_location_candidates: duplicateReport(rows, titleEditionLocationKey),
      repeated_source_url: duplicateReport(
        rows,
        (row) => (isHttpUrl(row.source_url) ? row.source_url : null),
      ),
    },
    VISIBLE_ON_WEBSITE: {
      expected_by_policy: expectedPublicRows.length,
      actual_via_anon: publicCount,
      check: publicCheck,
      difference:
        publicCount === null ? null : publicCount - expectedPublicRows.length,
    },
  };
}

async function main() {
  const baseUrl = requiredEnvironment("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let schemaMode = "integrity-columns";
  let rows;
  try {
    rows = await fetchAllRows(baseUrl, serviceKey, enhancedColumns);
  } catch (error) {
    if (!(error instanceof SupabaseAuditError) || error.status !== 400) throw error;
    rows = await fetchAllRows(baseUrl, serviceKey, legacyColumns);
    schemaMode = "legacy-columns-migration-required";
  }

  let publicCount = null;
  let publicCheck = "skipped-missing-anon-key";
  if (anonKey) {
    try {
      publicCount = await fetchExactPublicCount(baseUrl, anonKey);
      publicCheck = publicCount === null ? "count-header-unavailable" : "ok";
    } catch (error) {
      publicCheck = error instanceof SupabaseAuditError
        ? `failed-http-${error.status}`
        : "failed";
    }
  }

  console.log(JSON.stringify(buildReport(rows, schemaMode, publicCount, publicCheck), null, 2));
}

main().catch((error) => {
  console.error(`Audit failed: ${error.message}`);
  process.exitCode = 1;
});
