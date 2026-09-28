/**
 * Pure helpers for the human review workflow. The database function
 * apply_opportunity_review is authoritative; these rules only validate form
 * input and give the reviewer early hints, and must stay in sync with
 * opportunity_publication_blockers in the review workflow migration.
 */

export const REVIEW_ACTIONS = Object.freeze(["edit", "approve", "reject", "archive", "reopen"]);
export const REVIEW_VIEWS = Object.freeze(["pending", "approved", "rejected"]);
export const PUBLIC_TARGET_STATUSES = Object.freeze(["verified", "open", "closing-soon"]);
export const REVIEW_PAGE_SIZE = 25;

export const CATEGORIES = Object.freeze([
  "AI film festival", "Traditional festival", "Platform challenge",
  "Grant", "Residency", "Advertising competition",
]);
export const AI_POLICIES = Object.freeze(["allowed", "required", "restricted", "unclear"]);
export const DEADLINE_STATUSES = Object.freeze(["confirmed", "estimated", "unknown", "rolling"]);

/** Field kind drives parsing and comparison; keys are opportunity columns. */
export const EDITABLE_FIELDS = Object.freeze({
  title: "required-text",
  organizer: "required-text",
  category: "category",
  ai_policy: "ai-policy",
  summary: "long-text",
  location: "required-text",
  remote: "boolean",
  deadline: "timestamp",
  deadline_status: "deadline-status",
  deadline_source_url: "url",
  opens_at: "timestamp",
  edition_year: "year",
  prize_amount: "amount",
  prize_currency: "currency",
  entry_fee_amount: "amount",
  entry_fee_currency: "currency",
  max_runtime_minutes: "minutes",
  official_url: "url",
  application_url: "url",
  eligibility: "list",
  formats: "list",
  tags: "list",
});

export const BLOCKER_MESSAGES = Object.freeze({
  "status-not-public": "Choose a public status (verified, open or closing soon).",
  "missing-title": "The title is empty.",
  "missing-organizer": "The organizer is missing or still a placeholder.",
  "no-verified-official-page": "No official page with a verified URL: add an official URL and run URL revalidation, or confirm the source itself is official and verified.",
  "unresolved-conflict": "Sources conflict. Check the current evidence and confirm the conflict is resolved.",
  "deadline-not-confirmed": "Open calls need a confirmed deadline (with timezone) or a rolling deadline.",
  "deadline-passed": "The deadline has passed; the record cannot be published as open.",
  "closing-soon-without-deadline": "“Closing soon” needs a deadline.",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Timestamps must carry an explicit offset so that no timezone is guessed.
const EXPLICIT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT = { "required-text": 300, "long-text": 4000 };
const MAX_LIST_ITEMS = 30;
const MAX_LIST_ITEM_LENGTH = 200;

export function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

export function parseReviewView(value) {
  return REVIEW_VIEWS.includes(value) ? value : "pending";
}

/** Parse a 1-based page number from a search param, clamped to a sane range. */
export function parseReviewPage(value) {
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

/** PostgREST filter and ordering for one review tab. */
export function reviewViewFilter(view) {
  switch (parseReviewView(view)) {
    case "approved":
      return { review_decision: "eq.approved", order: "verified_at.desc.nullslast,id.asc" };
    case "rejected":
      return { review_decision: "in.(rejected,archived)", order: "updated_at.desc,id.asc" };
    default:
      return { review_decision: "eq.pending", order: "confidence.desc,discovered_at.desc,id.asc" };
  }
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === "example.com" || host.endsWith(".example.com") || host === "localhost") return null;
    return url.href;
  } catch {
    return null;
  }
}

function parseField(kind, raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  switch (kind) {
    case "required-text":
      if (!text) return { error: "Required." };
      if (text.length > MAX_TEXT[kind]) return { error: `At most ${MAX_TEXT[kind]} characters.` };
      return { value: text };
    case "long-text":
      if (text.length > MAX_TEXT[kind]) return { error: `At most ${MAX_TEXT[kind]} characters.` };
      return { value: text };
    case "category":
      return CATEGORIES.includes(text) ? { value: text } : { error: "Unknown category." };
    case "ai-policy":
      return AI_POLICIES.includes(text) ? { value: text } : { error: "Unknown AI policy." };
    case "deadline-status":
      return DEADLINE_STATUSES.includes(text) ? { value: text } : { error: "Unknown deadline status." };
    case "boolean":
      if (text === "true") return { value: true };
      if (text === "false") return { value: false };
      return { error: "Choose yes or no." };
    case "timestamp": {
      if (!text) return { value: null };
      if (!EXPLICIT_TIMESTAMP.test(text)) {
        return { error: "Use ISO 8601 with an explicit offset, e.g. 2026-10-15T23:59:00+02:00." };
      }
      const time = Date.parse(text);
      return Number.isFinite(time) ? { value: new Date(time).toISOString() } : { error: "Invalid date." };
    }
    case "url": {
      if (!text) return { value: null };
      const url = safeHttpUrl(text);
      return url ? { value: url } : { error: "Use a public http(s) URL." };
    }
    case "year": {
      if (!text) return { value: null };
      const year = Number(text);
      return Number.isInteger(year) && year >= 2000 && year <= 2100
        ? { value: year }
        : { error: "Year between 2000 and 2100." };
    }
    case "amount": {
      if (!text) return { value: null };
      if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) return { error: "A non-negative amount, e.g. 1500 or 12.50." };
      return { value: Number(text) };
    }
    case "minutes": {
      if (!text) return { value: null };
      const minutes = Number(text);
      return Number.isInteger(minutes) && minutes > 0 && minutes <= 10_000
        ? { value: minutes }
        : { error: "Whole minutes, greater than zero." };
    }
    case "currency": {
      if (!text) return { value: null };
      const code = text.toUpperCase();
      return /^[A-Z]{3}$/.test(code) ? { value: code } : { error: "Three-letter ISO code, e.g. EUR." };
    }
    case "list": {
      const items = [...new Set(text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
      if (items.length > MAX_LIST_ITEMS) return { error: `At most ${MAX_LIST_ITEMS} lines.` };
      if (items.some((item) => item.length > MAX_LIST_ITEM_LENGTH)) {
        return { error: `Each line at most ${MAX_LIST_ITEM_LENGTH} characters.` };
      }
      return { value: items };
    }
    default:
      return { error: "Unsupported field." };
  }
}

function comparable(kind, value) {
  if (value === undefined || value === null || value === "") return null;
  if (kind === "timestamp") {
    const time = Date.parse(String(value));
    return Number.isFinite(time) ? time : String(value);
  }
  if (kind === "amount" || kind === "year" || kind === "minutes") return Number(value);
  if (kind === "boolean") return Boolean(value);
  if (kind === "list") return JSON.stringify(Array.isArray(value) ? value : []);
  return String(value);
}

/**
 * Validate submitted form values against the current row and return only the
 * fields the reviewer actually changed.
 *
 * @param {Record<string, unknown>} current opportunity row (snake_case)
 * @param {Record<string, unknown>} submitted raw form values keyed by column
 * @returns {{ changes: Record<string, unknown>, errors: Record<string, string> }}
 */
export function diffReviewFields(current, submitted) {
  /** @type {Record<string, unknown>} */
  const changes = {};
  /** @type {Record<string, string>} */
  const errors = {};
  for (const [field, kind] of Object.entries(EDITABLE_FIELDS)) {
    if (!(field in submitted)) continue;
    const parsed = parseField(kind, submitted[field]);
    if ("error" in parsed) {
      errors[field] = parsed.error;
      continue;
    }
    if (comparable(kind, parsed.value) !== comparable(kind, current[field])) {
      changes[field] = parsed.value;
    }
  }
  return { changes, errors };
}

/**
 * Validate the non-field parts of a submission (action, reason, target status).
 */
export function validateReviewIntent({ action, reason, targetStatus }) {
  const errors = {};
  if (!REVIEW_ACTIONS.includes(action)) errors.action = "Unknown action.";
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (trimmedReason.length < 3) errors.reason = "Explain what you checked (at least 3 characters).";
  if (trimmedReason.length > 2000) errors.reason = "At most 2000 characters.";
  if (action === "approve" && !PUBLIC_TARGET_STATUSES.includes(targetStatus)) {
    errors.targetStatus = "Choose the public status to publish with.";
  }
  return { reason: trimmedReason, errors };
}

/**
 * Mirror of opportunity_publication_blockers for UI hints. Pass the row as it
 * would be after edits, with the intended status applied.
 */
export function publicationBlockers(row, { acknowledgeConflict = false, now = Date.now() } = {}) {
  const blockers = [];
  const status = row.status;
  if (!PUBLIC_TARGET_STATUSES.includes(status)) blockers.push("status-not-public");
  if (!String(row.title ?? "").trim()) blockers.push("missing-title");
  const organizer = String(row.organizer ?? "").trim().toLowerCase();
  if (!organizer || organizer === "unknown" || organizer === "unknown organizer") {
    blockers.push("missing-organizer");
  }
  const verifiedStatus = (value) => value === "verified" || value === "redirected";
  const officialPage = (row.official_url && verifiedStatus(row.official_url_status))
    || (row.source_type === "official" && verifiedStatus(row.source_url_status));
  if (!officialPage) blockers.push("no-verified-official-page");
  if (row.has_conflict && !acknowledgeConflict) blockers.push("unresolved-conflict");
  if (status === "open" || status === "closing-soon") {
    if (row.deadline_status !== "rolling") {
      const deadline = row.deadline ? Date.parse(String(row.deadline)) : NaN;
      if (!Number.isFinite(deadline) || row.deadline_status !== "confirmed") {
        blockers.push("deadline-not-confirmed");
      } else if (deadline <= now) {
        blockers.push("deadline-passed");
      }
    }
  }
  if (status === "closing-soon" && !row.deadline) blockers.push("closing-soon-without-deadline");
  return blockers;
}

/** Render a stored timestamp for an explicit-offset text input (UTC). */
export function timestampInputValue(value) {
  if (!value) return "";
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString().replace(".000Z", "Z") : "";
}
