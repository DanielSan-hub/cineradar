import { createHash } from "node:crypto";

import { canonicalizeUrl, isUrlGrounded } from "./web-validation.mjs";

const ALLOWED_CATEGORIES = new Set([
  "AI film festival",
  "Traditional festival",
  "Platform challenge",
  "Grant",
  "Residency",
  "Advertising competition",
]);
const ALLOWED_AI_POLICIES = new Set(["allowed", "required", "restricted", "unclear"]);
const ALLOWED_SOURCE_TYPES = new Set(["official", "press", "social", "community"]);
const ALLOWED_DEADLINE_STATUSES = new Set(["confirmed", "estimated", "unknown", "rolling"]);
const SUBMISSION_HOSTS = [
  "filmfreeway.com",
  "festhome.com",
  "shortfilmdepot.com",
  "filmfestplatform.com",
  "eventival.com",
];
const COMMUNITY_HOSTS = ["reddit.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "discord.com"];
const PRESS_HOSTS = ["prnewswire.com", "businesswire.com", "globenewswire.com", "yahoo.com"];

export class PipelineRejection extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "PipelineRejection";
    this.code = code;
  }
}

function cleanText(value, maxLength = 300) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function identityText(value) {
  return cleanText(String(value ?? ""), 500)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b\d{1,3}(?:st|nd|rd|th|a|e|o)?\s+(?:annual\s+)?edition\b/gi, " ")
    .replace(/[^a-z0-9\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferredYear(value) {
  const explicit = Number(value.opportunity_year ?? value.year);
  if (Number.isInteger(explicit) && explicit >= 2000 && explicit <= 2100) return explicit;
  const titleMatch = String(value.title ?? "").match(/\b(20\d{2})\b/);
  if (titleMatch) return Number(titleMatch[1]);
  const deadline = value.deadline ? new Date(value.deadline) : null;
  return deadline && !Number.isNaN(deadline.getTime()) ? deadline.getUTCFullYear() : null;
}

function inferredEdition(value) {
  const explicit = cleanText(value.edition, 80);
  if (explicit) return explicit;
  const match = String(value.title ?? "").match(/\b(\d{1,3}(?:st|nd|rd|th))\s+(?:annual\s+)?edition\b/i);
  return match?.[1] ?? null;
}

export function canonicalOpportunityKey(value) {
  const parts = [
    identityText(value.canonical_name ?? value.title),
    identityText(value.organizer),
    String(inferredYear(value) ?? "year-unknown"),
    identityText(inferredEdition(value) ?? "edition-unknown"),
    identityText(value.location ?? "location-unknown"),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function fuzzyOpportunityKey(value) {
  return [
    identityText(value.canonical_name ?? value.title),
    String(inferredYear(value) ?? "year-unknown"),
    identityText(value.location ?? "location-unknown"),
  ].join("|");
}

function slugify(value) {
  return identityText(value)
    .replace(/\s+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}

const ENGLISH_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const ENGLISH_WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];
const EXPLICIT_CET_DATE_TIME = /^(?:(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+)?(0?[1-9]|[12]\d|3[01])(st|nd|rd|th)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2}),?\s+(\d{1,2})[.:](\d{2})\s*(am|pm)?\s+(cet|cest)$/i;

function parseExplicitCetDateTime(raw) {
  const match = raw.match(EXPLICIT_CET_DATE_TIME);
  if (!match) return undefined;
  const [, weekday, dayText, suffix, monthText, yearText, hourText, minuteText, meridiem, zone] = match;
  const day = Number(dayText);
  const year = Number(yearText);
  const month = ENGLISH_MONTHS.indexOf(monthText.toLowerCase());
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const expectedSuffix = day % 100 >= 11 && day % 100 <= 13
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th");
  if (
    suffix.toLowerCase() !== expectedSuffix
    || minute > 59
    || (meridiem ? hour < 1 || hour > 12 : hour > 23)
  ) return null;

  const localHour = meridiem
    ? hour % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0)
    : hour;
  const localDate = new Date(Date.UTC(year, month, day, localHour, minute));
  if (
    localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month
    || localDate.getUTCDate() !== day
    || (weekday && ENGLISH_WEEKDAYS[localDate.getUTCDay()] !== weekday.toLowerCase())
  ) return null;

  const offsetHours = zone.toLowerCase() === "cest" ? 2 : 1;
  return new Date(localDate.getTime() - offsetHours * 60 * 60 * 1000);
}

export function normalizeDeadline(value, { now = new Date() } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const raw = value instanceof Date ? value.toISOString() : value.trim();
  const dateOnly = raw.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  const isoDateTime = /^20\d{2}-\d{2}-\d{2}T/.test(raw);
  const textualFullDate = /\b20\d{2}\b/.test(raw)
    && /\b(?:[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/i.test(raw)
    && /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(raw);
  if (!dateOnly && !isoDateTime && !textualFullDate) return null;
  const explicitCetTime = parseExplicitCetDateTime(raw);
  if (explicitCetTime === null) return null;
  let parsed = explicitCetTime ?? new Date(dateOnly ? `${raw}T23:59:59.000Z` : raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const hasExplicitTime = /\d{1,2}:\d{2}|\b(?:am|pm|utc|gmt|cet|cest|est|edt|pst|pdt)\b/i.test(raw);
  if (textualFullDate && !hasExplicitTime) {
    parsed = new Date(Date.UTC(
      parsed.getFullYear(),
      parsed.getMonth(),
      parsed.getDate(),
      23,
      59,
      59,
    ));
  }
  const year = parsed.getUTCFullYear();
  if (year < now.getUTCFullYear() - 1 || year > now.getUTCFullYear() + 10) return null;
  return parsed.toISOString();
}

function deadlineMatchesEvidence(deadline, rawValue, quote) {
  if (!deadline || !quote) return false;
  const evidence = cleanText(quote, 500).toLocaleLowerCase();
  const raw = cleanText(String(rawValue ?? ""), 100).toLocaleLowerCase();
  const describesOpening = /\b(?:submissions?|applications?|entries|inscripciones|inscriç(?:ão|ões)|candidatures)\s+(?:open|start|abren|abertas?)|\bopening\b|\bsubmission start/i.test(evidence);
  const describesClosing = /\bdeadline\b|\bclose[sd]?\b|\bdue\b|\bfinal\b|\bsubmit by\b|\bapply by\b|fecha límite|cierre|prazo|encerramento|date limite|bewerbungsfrist|موعد نهائي/i.test(evidence);
  if (describesOpening && !describesClosing) return false;
  if (raw && evidence.includes(raw)) return true;
  const date = new Date(deadline);
  const year = String(date.getUTCFullYear());
  const day = String(date.getUTCDate());
  if (!new RegExp(`\\b${year}\\b`).test(evidence)) return false;
  if (!new RegExp(`\\b0?${day}\\b`).test(evidence)) return false;
  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const month = date.getUTCMonth() + 1;
  return evidence.includes(monthNames[month - 1])
    || new RegExp(`(?:^|\\D)0?${month}(?:\\D|$)`).test(evidence);
}

function categoryFor(raw) {
  const supplied = cleanText(raw.category, 100);
  if (ALLOWED_CATEGORIES.has(supplied)) return supplied;
  const value = `${supplied} ${raw.title ?? ""} ${(raw.tags ?? []).join?.(" ") ?? ""}`.toLowerCase();
  if (/grant|fund|fellowship|bursary|finanziament|subvention/.test(value)) return "Grant";
  if (/residen|artist[- ]?in[- ]?residence|retreat/.test(value)) return "Residency";
  if (/advert|brand(?:ed)?|commercial|music video/.test(value)) return "Advertising competition";
  if (/platform|challenge|hackathon|creator contest|video competition/.test(value)) return "Platform challenge";
  if (/\bai\b|artificial intelligence|generative/.test(value) && /festival|film|cinema/.test(value)) {
    return "AI film festival";
  }
  if (/festival|film|cinema|animation|moving image|screenplay|open call|exhibition|lab/.test(value)) {
    return "Traditional festival";
  }
  throw new PipelineRejection("UNSUPPORTED_CATEGORY");
}

function hostMatches(hostname, candidates) {
  return candidates.some((candidate) => hostname === candidate || hostname.endsWith(`.${candidate}`));
}

function sourceTypeFor(rawType, sourceUrl, officialUrl, knownSourceType) {
  const hostname = new URL(sourceUrl).hostname;
  if (hostMatches(hostname, COMMUNITY_HOSTS)) return hostname.includes("reddit") ? "community" : "social";
  if (hostMatches(hostname, PRESS_HOSTS)) return "press";
  if (hostMatches(hostname, SUBMISSION_HOSTS)) return "community";
  if (knownSourceType === "official") return "official";
  if (officialUrl && new URL(officialUrl).hostname === hostname) return "official";
  return ALLOWED_SOURCE_TYPES.has(rawType) && rawType !== "official" ? rawType : "press";
}

function normalizeStringArray(value, maxItems = 16) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(String(item), 160)).filter(Boolean))].slice(0, maxItems);
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizeCurrency(value) {
  const currency = cleanText(String(value ?? ""), 3).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function evidenceContains(pageText, quote) {
  const evidence = cleanText(quote, 500).toLocaleLowerCase();
  if (evidence.length < 4) return false;
  return cleanText(pageText, 200_000).toLocaleLowerCase().includes(evidence);
}

function factIsGrounded(value, quote, context) {
  const normalizedValue = cleanText(String(value ?? ""), 500);
  if (!normalizedValue) return false;
  const haystack = `${context.sourceTitle ?? ""}\n${context.sourceText ?? ""}`.toLocaleLowerCase();
  if (haystack.includes(normalizedValue.toLocaleLowerCase())) return true;
  return evidenceContains(context.sourceText, quote);
}

function groundedUrl(rawValue, context) {
  const value = canonicalizeUrl(rawValue, context.sourceFinalUrl ?? context.sourceUrl);
  if (!value) return { url: null, reason: rawValue ? "INVALID_URL" : null };
  const grounded = isUrlGrounded(value, {
    sourceUrl: context.sourceUrl,
    finalUrl: context.sourceFinalUrl,
    links: context.sourceLinks,
  });
  return grounded ? { url: value, reason: null } : { url: null, reason: "UNGROUNDED_URL" };
}

export function normalizeOpportunity(raw, context) {
  if (!raw || typeof raw !== "object" || raw.relevant === false) {
    throw new PipelineRejection("NOT_RELEVANT");
  }
  const sourceUrl = canonicalizeUrl(context?.sourceFinalUrl ?? context?.sourceUrl);
  if (!sourceUrl) throw new PipelineRejection("INVALID_SOURCE_URL");
  const evidence = raw.field_evidence && typeof raw.field_evidence === "object"
    ? raw.field_evidence
    : {};
  const title = cleanText(raw.title, 240);
  if (!title) throw new PipelineRejection("MISSING_TITLE");
  if (!factIsGrounded(title, evidence.title, context)) {
    throw new PipelineRejection("UNGROUNDED_TITLE");
  }
  const extractedOrganizer = cleanText(raw.organizer, 240);
  const organizer = factIsGrounded(extractedOrganizer, evidence.organizer, context)
    ? extractedOrganizer
    : "Unknown organizer";

  const warnings = [];
  let official = groundedUrl(raw.official_url, context);
  let application = groundedUrl(raw.application_url, context);
  if (official.reason) warnings.push(`${official.reason}_OFFICIAL_URL`);
  if (application.reason) warnings.push(`${application.reason}_APPLICATION_URL`);

  if (official.url && hostMatches(new URL(official.url).hostname, SUBMISSION_HOSTS)) {
    if (!application.url) application = official;
    official = { url: null, reason: "SUBMISSION_PLATFORM_IS_NOT_OFFICIAL_SITE" };
    warnings.push("SUBMISSION_PLATFORM_IS_NOT_OFFICIAL_SITE");
  }
  // A URL supplied as a monitored official source is stronger evidence than an
  // LLM-selected sibling link (which may point to the wrong edition).
  if (context.sourceType === "official") {
    official = { url: sourceUrl, reason: null };
  }

  const requestedDeadlineStatus = ALLOWED_DEADLINE_STATUSES.has(raw.deadline_status)
    ? raw.deadline_status
    : raw.rolling
      ? "rolling"
      : "unknown";
  const deadlineEvidence = cleanText(raw.deadline_evidence, 500);
  const groundedDeadline = evidenceContains(context.sourceText, deadlineEvidence);
  let deadline = requestedDeadlineStatus === "rolling" ? null : normalizeDeadline(raw.deadline);
  let deadlineStatus = requestedDeadlineStatus;
  if (raw.deadline && !deadline) warnings.push("INVALID_DEADLINE");
  if (deadline && (!groundedDeadline || !deadlineMatchesEvidence(deadline, raw.deadline, deadlineEvidence))) {
    deadline = null;
    deadlineStatus = "unknown";
    warnings.push("UNGROUNDED_DEADLINE");
  } else if (deadline && deadlineStatus === "unknown") {
    deadlineStatus = "confirmed";
  } else if (!deadline && deadlineStatus !== "rolling") {
    deadlineStatus = "unknown";
  }

  const positiveOpportunityTitle = /festival|competition|contest|challenge|grant|fund|residen|fellowship|\blab\b|open call|call for|submissions?|entries|award|exhibition|screenplay|convocatoria|inscripciones|edital|fomento|beca|bando|appel à|einreichung|bewerbung|دعوة|منحة|募集|征集|출품/i.test(title);
  const retrospectiveTitle = /winners?|honou?red|awarded at|recap|programme|program schedule|masterclass|highlights?|closing ceremony|opening ceremony/i.test(title);
  if ((!positiveOpportunityTitle || retrospectiveTitle) && !application.url && !deadline) {
    throw new PipelineRejection("NOT_AN_OPPORTUNITY");
  }

  const deadlineSource = deadline
    ? groundedUrl(raw.deadline_source_url ?? sourceUrl, context).url ?? sourceUrl
    : null;
  const opportunityYear = inferredYear({ ...raw, deadline });
  const edition = inferredEdition(raw);
  const extractedLocation = cleanText(raw.location, 200);
  const location = factIsGrounded(extractedLocation, evidence.location, context)
    ? extractedLocation
    : "Unspecified";
  const category = categoryFor(raw);
  const key = canonicalOpportunityKey({
    title,
    organizer,
    opportunity_year: opportunityYear,
    edition,
    location,
    deadline,
  });
  const slugBase = slugify(title) || "opportunity";
  const checkedAt = context.checkedAt ?? new Date().toISOString();
  const sourceType = sourceTypeFor(
    raw.source_type,
    sourceUrl,
    official.url,
    context.sourceType,
  );
  const opensAt = factIsGrounded(raw.opens_at, evidence.opens_at, context)
    ? normalizeDeadline(raw.opens_at)
    : null;
  const prizeGrounded = raw.prize_amount !== null && raw.prize_amount !== undefined
    && evidenceContains(context.sourceText, evidence.prize);
  const feeGrounded = raw.entry_fee_amount !== null && raw.entry_fee_amount !== undefined
    && evidenceContains(context.sourceText, evidence.entry_fee);
  const aiPolicy = ALLOWED_AI_POLICIES.has(raw.ai_policy)
    && factIsGrounded(raw.ai_policy, evidence.ai_policy, context)
    ? raw.ai_policy
    : "unclear";
  const eligibility = evidenceContains(context.sourceText, evidence.eligibility)
    ? normalizeStringArray(raw.eligibility, 12)
    : [];
  const formats = evidenceContains(context.sourceText, evidence.formats)
    ? normalizeStringArray(raw.formats, 12)
    : [];

  return {
    slug: `${slugBase}-${key.slice(0, 10)}`,
    title,
    organizer,
    category,
    status: "discovered",
    ai_policy: aiPolicy,
    deadline,
    deadline_status: deadlineStatus,
    deadline_source_url: deadlineSource,
    deadline_last_verified_at: deadline && groundedDeadline ? checkedAt : null,
    opens_at: opensAt,
    prize_amount: prizeGrounded ? normalizeAmount(raw.prize_amount) : null,
    prize_currency: prizeGrounded ? normalizeCurrency(raw.prize_currency) : null,
    entry_fee_amount: feeGrounded ? normalizeAmount(raw.entry_fee_amount) : null,
    entry_fee_currency: feeGrounded ? normalizeCurrency(raw.entry_fee_currency) : null,
    location,
    remote: Boolean(raw.remote) && /\bonline\b|\bremote\b/i.test(`${extractedLocation} ${evidence.location ?? ""}`),
    max_runtime_minutes: evidenceContains(context.sourceText, evidence.max_runtime)
      ? normalizeAmount(raw.max_runtime_minutes)
      : null,
    source_url: sourceUrl,
    official_url: official.url,
    application_url: application.url,
    source_type: sourceType,
    confidence: 0,
    summary: cleanText(raw.summary, 800),
    eligibility,
    formats,
    tags: normalizeStringArray(raw.tags, 16),
    discovered_at: new Date().toISOString(),
    canonical_key: key,
    edition_year: opportunityYear,
    raw_payload: {
      extraction: raw,
      evidence: {
        source_url: context.sourceUrl,
        source_final_url: sourceUrl,
        deadline_quote: deadlineEvidence || null,
        grounded_link_count: context.sourceLinks?.length ?? 0,
      },
      normalization: {
        warnings,
        canonical_key: key,
        edition: edition ?? null,
        edition_year: opportunityYear,
      },
      validation: { urls: {} },
    },
  };
}

function validUrlStatus(validation) {
  return validation && ["verified", "redirected"].includes(validation.status);
}

export function applyUrlValidations(record, validations) {
  const source = validations.source;
  const official = validations.official ?? null;
  const application = validations.application ?? null;
  const next = {
    ...record,
    source_url: validUrlStatus(source) ? source.final_url : record.source_url,
    official_url: validUrlStatus(official) ? official.final_url : null,
    application_url: validUrlStatus(application) ? application.final_url : null,
    source_url_status: source?.status ?? "unchecked",
    source_url_http_status: source?.http_status ?? null,
    source_url_final: source?.final_url ?? null,
    source_url_last_checked_at: source?.checked_at ?? null,
    source_url_verified_at: validUrlStatus(source) ? source.checked_at : null,
    official_url_status: official?.status ?? (record.official_url ? "unreachable" : "unchecked"),
    official_url_http_status: official?.http_status ?? null,
    official_url_final: official?.final_url ?? null,
    official_url_last_checked_at: official?.checked_at ?? null,
    official_url_verified_at: validUrlStatus(official) ? official.checked_at : null,
    application_url_status: application?.status ?? (record.application_url ? "unreachable" : "unchecked"),
    application_url_http_status: application?.http_status ?? null,
    application_url_final: application?.final_url ?? null,
    application_url_last_checked_at: application?.checked_at ?? null,
    application_url_verified_at: validUrlStatus(application) ? application.checked_at : null,
    raw_payload: {
      ...record.raw_payload,
      validation: {
        ...(record.raw_payload?.validation ?? {}),
        urls: { source, official, application },
      },
    },
  };
  next.confidence = scoreOpportunity(next);
  return next;
}

export function scoreOpportunity(record) {
  const urls = record.raw_payload?.validation?.urls ?? {};
  let score = 0.18;
  if (validUrlStatus(urls.source)) score += 0.18;
  if (record.source_type === "official") score += 0.12;
  if (record.official_url && validUrlStatus(urls.official)) score += 0.17;
  if (record.application_url && validUrlStatus(urls.application)) score += 0.08;
  if (record.deadline && record.deadline_status === "confirmed") score += 0.12;
  if (record.summary) score += 0.04;
  if (record.eligibility?.length) score += 0.03;
  if (record.formats?.length) score += 0.03;
  if (record.location && record.location !== "Unspecified") score += 0.03;
  const modelConfidence = Number(record.raw_payload?.extraction?.confidence);
  if (Number.isFinite(modelConfidence)) score += Math.max(0, Math.min(0.02, modelConfidence * 0.02));
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function mergeArrays(a, b, max = 16) {
  return [...new Set([...(a ?? []), ...(b ?? [])])].slice(0, max);
}

function mergeProvenance(a, b) {
  const unique = new Map();
  for (const entry of [...(a ?? []), ...(b ?? [])]) {
    const key = [
      entry.provider,
      entry.queryId,
      entry.sourceId,
      entry.sourceUrl,
      entry.resultRank,
    ].join("|");
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()];
}

function preferredRecord(a, b) {
  const scoreA = Number(a.confidence ?? 0);
  const scoreB = Number(b.confidence ?? 0);
  const base = scoreB > scoreA ? b : a;
  const other = base === a ? b : a;
  const preferDeadline = base.deadline_status === "confirmed" ? base : other.deadline_status === "confirmed" ? other : base;
  return {
    ...other,
    ...base,
    deadline: preferDeadline.deadline,
    deadline_status: preferDeadline.deadline_status,
    deadline_source_url: preferDeadline.deadline_source_url,
    deadline_last_verified_at: preferDeadline.deadline_last_verified_at,
    official_url: base.official_url ?? other.official_url,
    application_url: base.application_url ?? other.application_url,
    eligibility: mergeArrays(base.eligibility, other.eligibility, 12),
    formats: mergeArrays(base.formats, other.formats, 12),
    tags: mergeArrays(base.tags, other.tags, 16),
    _provenance: mergeProvenance(base._provenance, other._provenance),
    raw_payload: {
      ...base.raw_payload,
      additional_source_urls: mergeArrays(
        base.raw_payload?.additional_source_urls,
        [other.source_url, ...(other.raw_payload?.additional_source_urls ?? [])],
        20,
      ),
    },
  };
}

export function dedupeOpportunitiesDetailed(records) {
  const unique = new Map();
  const fuzzy = new Map();
  let duplicates = 0;
  for (const record of records) {
    const key = record.canonical_key ?? canonicalOpportunityKey(record);
    const fuzzyKey = fuzzyOpportunityKey(record);
    const existingKey = unique.has(key) ? key : fuzzy.get(fuzzyKey);
    if (existingKey) {
      duplicates += 1;
      unique.set(existingKey, preferredRecord(unique.get(existingKey), record));
    } else {
      unique.set(key, { ...record, canonical_key: key });
      fuzzy.set(fuzzyKey, key);
    }
  }
  return { records: [...unique.values()], duplicates };
}

export function dedupeOpportunities(records) {
  return dedupeOpportunitiesDetailed(records).records;
}
