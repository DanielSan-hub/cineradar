export const LEGACY_OPPORTUNITY_FIELDS = Object.freeze([
  "slug", "title", "organizer", "category", "status", "ai_policy",
  "deadline", "opens_at", "prize_amount", "prize_currency",
  "entry_fee_amount", "entry_fee_currency", "location", "remote",
  "max_runtime_minutes", "source_url", "official_url", "source_type",
  "confidence", "summary", "eligibility", "formats", "tags",
  "discovered_at", "verified_at", "featured", "content_hash", "raw_payload",
]);

export const INTEGRITY_OPPORTUNITY_FIELDS = Object.freeze([
  "canonical_key", "edition_year", "application_url", "deadline_status",
  "deadline_source_url", "deadline_last_verified_at",
  "source_url_status", "source_url_http_status", "source_url_final",
  "source_url_last_checked_at", "source_url_verified_at",
  "official_url_status", "official_url_http_status", "official_url_final",
  "official_url_last_checked_at", "official_url_verified_at",
  "application_url_status", "application_url_http_status", "application_url_final",
  "application_url_last_checked_at", "application_url_verified_at",
]);

const REQUIRED_FIELDS = Object.freeze([
  "slug",
  "title",
  "organizer",
  "category",
  "source_url",
]);

const NON_NULL_DEFAULTS = Object.freeze({
  status: "discovered",
  ai_policy: "unclear",
  location: "Online",
  remote: true,
  source_type: "official",
  confidence: 0.5,
  summary: "",
  eligibility: Object.freeze([]),
  formats: Object.freeze([]),
  tags: Object.freeze([]),
  featured: false,
  raw_payload: Object.freeze({}),
  review_required: true,
  deadline_status: "unknown",
  source_url_status: "unchecked",
  official_url_status: "unchecked",
  application_url_status: "unchecked",
});

const PUBLIC_STATUSES = new Set(["verified", "open", "closing-soon", "closed"]);

export function reviewRequiredForAutomatedIngest(existing) {
  // A public-looking status alone is not proof of human approval, especially
  // for legacy rows that have no verification timestamp.
  return !(
    existing?.review_required === false
    && existing?.verified_at
    && PUBLIC_STATUSES.has(existing.status)
  );
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cloneDefault(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === "object") return {};
  return value;
}

/**
 * PostgREST bulk inserts require every JSON object to have the same top-level
 * keys. Existing legacy rows can contain optional fields that fresh pipeline
 * records omit, so aligning only the union of present properties is unsafe.
 * Emit the complete schema-specific field list and use SQL-compatible values
 * for every omitted nullable/non-null column instead.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {{ integrity: boolean, reviewGate?: boolean, now?: string }} options
 * @returns {Array<Record<string, unknown>>}
 */
export function alignOpportunityPayload(
  records,
  { integrity, reviewGate = false, now = new Date().toISOString() },
) {
  const schemaFields = integrity
    ? [...LEGACY_OPPORTUNITY_FIELDS, ...INTEGRITY_OPPORTUNITY_FIELDS]
    : [...LEGACY_OPPORTUNITY_FIELDS];
  const fields = reviewGate ? [...schemaFields, "review_required"] : schemaFields;
  const required = integrity
    ? [...REQUIRED_FIELDS, "canonical_key"]
    : [...REQUIRED_FIELDS];

  return records.map((record, index) => {
    for (const field of required) {
      if (!hasOwn(record, field) || record[field] === null || record[field] === undefined || record[field] === "") {
        throw new Error(`Ingest record ${index} is missing required field: ${field}`);
      }
    }

    return Object.fromEntries(fields.map((field) => {
      if (hasOwn(record, field) && record[field] !== undefined) {
        return [field, record[field]];
      }
      if (field === "discovered_at") return [field, now];
      if (hasOwn(NON_NULL_DEFAULTS, field)) {
        return [field, cloneDefault(NON_NULL_DEFAULTS[field])];
      }
      return [field, null];
    }));
  });
}
