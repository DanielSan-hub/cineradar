// Pure source-registry policy helpers. This module deliberately has no
// environment, network, filesystem, or database side effects.

export const SOURCE_FAMILIES = Object.freeze([
  "structured-festival",
  "opportunity-directory",
  "media-art-residency",
  "film-funding",
  "ai-creative-tech",
  "arts-institution",
  "platform-company",
  "news-feed",
  "official-site",
  "other",
]);

export const SOURCE_HEALTH_STATUSES = Object.freeze([
  "healthy",
  "degraded",
  "failing",
  "blocked",
  "paused",
]);

export const SOURCE_ADAPTERS = Object.freeze([
  "generic",
  "page",
  "cursor",
  "link-window",
  "rss",
  "sitemap",
  "json",
]);

export const OPPORTUNITY_CATEGORIES = Object.freeze([
  "film-festival",
  "short-film",
  "ai-film",
  "animation",
  "music-video",
  "experimental-new-media",
  "grant",
  "residency",
  "lab-fellowship",
  "platform-challenge",
  "branded-open-call",
]);

export const DEFAULT_SOURCE_POLICY = Object.freeze({
  priority: 3,
  minPollIntervalMinutes: 6 * 60,
  pollIntervalMinutes: 3 * 24 * 60,
  maxPollIntervalMinutes: 30 * 24 * 60,
  linkWindowSize: 20,
  maxPageNumber: 10,
  maxLinkOffset: 100_000,
});

const LANGUAGE_ALIASES = Object.freeze({
  english: "en",
  italian: "it",
  italiano: "it",
  french: "fr",
  francais: "fr",
  français: "fr",
  spanish: "es",
  espanol: "es",
  español: "es",
  portuguese: "pt",
  portugues: "pt",
  português: "pt",
  german: "de",
  deutsch: "de",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  arabic: "ar",
});

const CATEGORY_ALIASES = new Map([
  ["festival", "film-festival"],
  ["traditional-festival", "film-festival"],
  ["short", "short-film"],
  ["short-film-festival", "short-film"],
  ["ai", "ai-film"],
  ["ai-film-festival", "ai-film"],
  ["generative-video", "ai-film"],
  ["animated-film", "animation"],
  ["new-media", "experimental-new-media"],
  ["media-art", "experimental-new-media"],
  ["video-art", "experimental-new-media"],
  ["funding", "grant"],
  ["film-fund", "grant"],
  ["artist-residency", "residency"],
  ["fellowship", "lab-fellowship"],
  ["lab", "lab-fellowship"],
  ["challenge", "platform-challenge"],
  ["brand-challenge", "branded-open-call"],
  ["advertising-competition", "branded-open-call"],
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonnegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.trunc(finiteNumber(value, fallback)));
}

function clampInteger(value, min, max, fallback = min) {
  return Math.min(max, Math.max(min, Math.trunc(finiteNumber(value, fallback))));
}

function unique(values) {
  return [...new Set(values)];
}

function slug(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizedText(input) {
  if (typeof input === "string") return input.toLowerCase();
  if (!plainObject(input)) return "";
  return [
    input.name,
    input.url,
    input.base_url,
    input.description,
    input.source_family,
    input.source_type,
    ...(Array.isArray(input.opportunity_categories) ? input.opportunity_categories : []),
    ...(Array.isArray(input.categories) ? input.categories : []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(value, fallback = null) {
  return (validDate(value) ?? validDate(fallback))?.toISOString() ?? null;
}

function normalizeHttpUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value).trim());
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeLanguage(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  const resolved = LANGUAGE_ALIASES[raw] ?? raw.replaceAll("_", "-");
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(resolved) ? resolved : null;
}

function normalizeRegion(value) {
  const normalized = slug(value);
  const aliases = {
    eu: "europe",
    european: "europe",
    "north-america": "usa-canada",
    "us-canada": "usa-canada",
    "usa-and-canada": "usa-canada",
    latam: "latin-america",
    mena: "middle-east",
    "asia-pacific": "asia-pacific",
  };
  return normalized ? aliases[normalized] ?? normalized : null;
}

function normalizeCategory(value) {
  const normalized = slug(value);
  if (!normalized) return null;
  if (OPPORTUNITY_CATEGORIES.includes(normalized)) return normalized;
  return CATEGORY_ALIASES.get(normalized) ?? null;
}

function normalizeCategoryList(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return unique(values.map(normalizeCategory).filter(Boolean)).slice(0, 32);
}

export function inferSourceFamily(input) {
  const text = normalizedText(input);
  let hostname = "";
  try {
    hostname = new URL(
      typeof input === "string" ? input : input?.url ?? input?.base_url ?? "",
    ).hostname.toLowerCase();
  } catch {
    // Text heuristics below still work for a name or description.
  }

  if (
    /(?:filmfreeway|festhome|shortfilmdepot)/.test(hostname)
    || /festival (?:directory|submission platform|catalog(?:ue)?)/.test(text)
  ) return "structured-festival";
  if (
    /(?:opportunit|open[ -]?calls?|convocatori|bandi|ausschreibung|公募|공모)/u.test(text)
    && /(?:director|listing|portal|network|mobility|artist)/.test(text)
  ) return "opportunity-directory";
  if (
    /(?:film commission|film institute|arts council|film fund|public fund|funding|grant|fondo|fundo|fonds|förder|est[ií]mulo|edital)/u.test(text)
  ) return "film-funding";
  if (
    /(?:residen|media art|moving image|video art|new media|digital art|biennial|museum)/.test(text)
  ) return "media-art-residency";
  if (
    /(?:generative|creative tech|artificial intelligence|\bai\b|人工智能|인공지능)/u.test(text)
  ) return "ai-creative-tech";
  if (/(?:platform|creator challenge|developer challenge)/.test(text)) {
    return "platform-company";
  }
  if (/(?:rss|atom feed|news feed)/.test(text)) return "news-feed";
  if (/(?:museum|foundation|cultural centre|cultural center|university|academy)/.test(text)) {
    return "arts-institution";
  }
  return "official-site";
}

export function inferOpportunityCategories(input) {
  const text = normalizedText(input);
  const categories = [];
  const add = (category, pattern) => {
    if (pattern.test(text)) categories.push(category);
  };

  add("ai-film", /(?:\bai\b|artificial intelligence|generative (?:film|video)|人工智能|생성형)/u);
  add("short-film", /(?:short film|cortometr|court m[eé]trage|curta[- ]metragem|短編|단편)/u);
  add("animation", /(?:animat|anime|animação|animaci[oó]n|アニメ|애니메이션)/u);
  add("music-video", /(?:music video|videoclip|clip musical|뮤직비디오)/u);
  add("experimental-new-media", /(?:experimental|moving image|media art|video art|new media|digital art|映像芸術|미디어아트|新媒体艺术)/u);
  add("grant", /(?:grant|funding|film fund|fondo|fonds|fundo|förder|est[ií]mulo|edital|资助)/u);
  add("residency", /(?:residen|artist in residence|artist-in-residence|レジデンス|驻留)/u);
  add("lab-fellowship", /(?:\blab\b|laborator|fellowship|mentorship|incubator)/u);
  add("branded-open-call", /(?:brand(?:ed)? (?:challenge|content)|advertising competition|commission)/u);
  add("platform-challenge", /(?:platform (?:challenge|competition)|creator challenge|hackathon)/u);
  add("film-festival", /(?:film festival|festival de cine|festival de cinema|filmfest|映画祭|영화제|电影节)/u);

  const supplied = plainObject(input)
    ? normalizeCategoryList(input.opportunity_categories ?? input.categories ?? input.category)
    : [];
  return unique([...supplied, ...categories]);
}

function inferredAdapter(sourceFamily, definition) {
  const requested = slug(definition.adapter ?? definition.adapter_type);
  if (SOURCE_ADAPTERS.includes(requested)) return requested;
  if (definition.rss_url || /(?:rss|atom)/i.test(definition.url ?? definition.base_url ?? "")) {
    return "rss";
  }
  if (definition.adapter_config?.cursor_param) return "cursor";
  if (definition.adapter_config?.page_param || sourceFamily === "structured-festival") {
    return "page";
  }
  if (definition.adapter_config?.link_window_size) return "link-window";
  return "generic";
}

export function validateSourceDefinition(definition) {
  const errors = [];
  if (!plainObject(definition)) {
    return { valid: false, errors: ["source definition must be an object"] };
  }
  if (!String(definition.name ?? "").trim()) errors.push("name is required");
  if (!normalizeHttpUrl(definition.url ?? definition.base_url)) {
    errors.push("url must be an absolute HTTP(S) URL without credentials");
  }
  const priority = Number(definition.priority ?? definition.tier ?? DEFAULT_SOURCE_POLICY.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    errors.push("priority must be an integer from 1 to 5");
  }
  if (definition.adapter_config !== undefined && !plainObject(definition.adapter_config)) {
    errors.push("adapter_config must be an object");
  }
  if (definition.language && !normalizeLanguage(definition.language)) {
    errors.push("language must be a BCP-47-like language tag or supported language name");
  }
  const min = Number(
    definition.min_poll_interval_minutes ?? DEFAULT_SOURCE_POLICY.minPollIntervalMinutes,
  );
  const poll = Number(
    definition.poll_interval_minutes ?? definition.poll_frequency_minutes
      ?? DEFAULT_SOURCE_POLICY.pollIntervalMinutes,
  );
  const max = Number(
    definition.max_poll_interval_minutes ?? DEFAULT_SOURCE_POLICY.maxPollIntervalMinutes,
  );
  if (![min, poll, max].every(Number.isFinite) || min < 15 || min > poll || poll > max) {
    errors.push("poll intervals must be finite and satisfy 15 <= min <= poll <= max");
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeSourceDefinition(definition, { strict = true } = {}) {
  const validation = validateSourceDefinition(definition);
  if (strict && !validation.valid) {
    const error = new TypeError(`Invalid source definition: ${validation.errors.join("; ")}`);
    error.validationErrors = validation.errors;
    throw error;
  }

  const url = normalizeHttpUrl(definition?.url ?? definition?.base_url);
  const sourceFamily = SOURCE_FAMILIES.includes(definition?.source_family)
    ? definition.source_family
    : inferSourceFamily(definition ?? {});
  const minPoll = clampInteger(
    definition?.min_poll_interval_minutes,
    15,
    525_600,
    DEFAULT_SOURCE_POLICY.minPollIntervalMinutes,
  );
  const maxPoll = clampInteger(
    definition?.max_poll_interval_minutes,
    minPoll,
    525_600,
    DEFAULT_SOURCE_POLICY.maxPollIntervalMinutes,
  );
  const poll = clampInteger(
    definition?.poll_interval_minutes ?? definition?.poll_frequency_minutes,
    minPoll,
    maxPoll,
    DEFAULT_SOURCE_POLICY.pollIntervalMinutes,
  );

  return {
    ...(definition?.id ? { id: definition.id } : {}),
    name: String(definition?.name ?? "").trim(),
    url,
    tier: clampInteger(definition?.tier, 1, 3, 2),
    enabled: definition?.enabled !== false,
    source_type: String(definition?.source_type ?? "official").trim() || "official",
    source_family: sourceFamily,
    country: definition?.country ? String(definition.country).trim().toUpperCase() : null,
    region: normalizeRegion(definition?.region),
    language: normalizeLanguage(definition?.language),
    opportunity_categories: inferOpportunityCategories(definition ?? {}),
    priority: clampInteger(
      definition?.priority ?? definition?.tier,
      1,
      5,
      DEFAULT_SOURCE_POLICY.priority,
    ),
    adapter: inferredAdapter(sourceFamily, definition ?? {}),
    adapter_config: plainObject(definition?.adapter_config)
      ? structuredClone(definition.adapter_config)
      : {},
    min_poll_interval_minutes: minPoll,
    poll_interval_minutes: poll,
    max_poll_interval_minutes: maxPoll,
    next_check_at: isoDate(definition?.next_check_at),
    last_checked_at: isoDate(definition?.last_checked_at),
    last_changed_at: isoDate(definition?.last_changed_at),
    last_new_opportunity_at: isoDate(definition?.last_new_opportunity_at),
    check_count: nonnegativeInteger(definition?.check_count),
    changed_check_count: nonnegativeInteger(definition?.changed_check_count),
    candidate_url_count: nonnegativeInteger(definition?.candidate_url_count),
    successful_discoveries: nonnegativeInteger(definition?.successful_discoveries),
    unique_discoveries: nonnegativeInteger(definition?.unique_discoveries),
    false_positive_count: nonnegativeInteger(definition?.false_positive_count),
    consecutive_failures: nonnegativeInteger(definition?.consecutive_failures),
    consecutive_no_change: nonnegativeInteger(definition?.consecutive_no_change),
    yield_score: Math.max(0, finiteNumber(definition?.yield_score)),
    estimated_cost_eur: Math.max(0, finiteNumber(definition?.estimated_cost_eur)),
    health_status: SOURCE_HEALTH_STATUSES.includes(definition?.health_status)
      ? definition.health_status
      : "healthy",
    health_message: definition?.health_message
      ? String(definition.health_message).slice(0, 500)
      : null,
    last_error_at: isoDate(definition?.last_error_at),
  };
}

export function normalizeSourceDefinitions(definitions, options) {
  if (!Array.isArray(definitions)) throw new TypeError("source definitions must be an array");
  return definitions.map((definition) => normalizeSourceDefinition(definition, options));
}

export function isSourceDue(source, now = new Date()) {
  const at = validDate(now);
  if (!at || source?.enabled === false) return false;
  if (new Set(["blocked", "paused"]).has(source?.health_status)) return false;
  const next = validDate(source?.next_check_at);
  return next === null || next.getTime() <= at.getTime();
}

export function selectDueSources(sources, {
  now = new Date(),
  limit = sources?.length ?? 0,
  priorityShare = 0.3,
} = {}) {
  if (!Array.isArray(sources)) throw new TypeError("sources must be an array");
  const boundedLimit = clampInteger(limit, 0, 100_000, sources.length);
  const dueTime = (source) => (
    validDate(source.next_check_at)
    ?? validDate(source.created_at)
  )?.getTime() ?? 0;
  const checkedTime = (source) => validDate(source.last_checked_at)?.getTime() ?? 0;
  const priority = (source) => finiteNumber(source.priority, DEFAULT_SOURCE_POLICY.priority);
  const ordered = sources
    .filter((source) => isSourceDue(source, now))
    .map((source, inputIndex) => ({ source, inputIndex }))
    .sort((left, right) => (
      dueTime(left.source) - dueTime(right.source)
      || priority(left.source) - priority(right.source)
      || checkedTime(left.source) - checkedTime(right.source)
      || finiteNumber(right.source.yield_score) - finiteNumber(left.source.yield_score)
      || left.inputIndex - right.inputIndex
    ));
  // A share of every run goes to high-priority sources (AI, newly harvested
  // official pages) so they are not stuck behind a backlog of thousands of
  // overdue low-priority sources; the rest stays oldest-first, so nothing
  // starves.
  const reserved = Math.floor(boundedLimit * Math.max(0, Math.min(1, priorityShare)));
  const first = ordered
    .filter(({ source }) => priority(source) < DEFAULT_SOURCE_POLICY.priority)
    .sort((left, right) => priority(left.source) - priority(right.source) || dueTime(left.source) - dueTime(right.source))
    .slice(0, reserved);
  const taken = new Set(first.map(({ source }) => source));
  return [...first, ...ordered.filter(({ source }) => !taken.has(source))]
    .slice(0, boundedLimit)
    .map(({ source }) => source);
}

export function adaptivePollIntervalMinutes(source, outcome = {}) {
  const min = clampInteger(
    source?.min_poll_interval_minutes,
    15,
    525_600,
    DEFAULT_SOURCE_POLICY.minPollIntervalMinutes,
  );
  const max = clampInteger(
    source?.max_poll_interval_minutes,
    min,
    525_600,
    DEFAULT_SOURCE_POLICY.maxPollIntervalMinutes,
  );
  const current = clampInteger(
    source?.poll_interval_minutes,
    min,
    max,
    DEFAULT_SOURCE_POLICY.pollIntervalMinutes,
  );
  const failed = Boolean(outcome.error ?? outcome.failed);
  const blocked = Boolean(outcome.blocked);
  const uniqueDiscoveries = nonnegativeInteger(
    outcome.uniqueDiscoveries ?? outcome.unique_discoveries,
  );
  const changed = Boolean(outcome.changed) || uniqueDiscoveries > 0;
  const noChangeStreak = failed || changed
    ? 0
    : nonnegativeInteger(source?.consecutive_no_change) + 1;

  let next = current;
  if (blocked) {
    next = max;
  } else if (failed) {
    const failureCount = nonnegativeInteger(source?.consecutive_failures) + 1;
    next = current * (2 ** Math.min(failureCount, 5));
  } else if (uniqueDiscoveries > 0) {
    next = current * (uniqueDiscoveries >= 3 ? 0.5 : 0.7);
  } else if (changed) {
    next = current * 0.85;
  } else if (noChangeStreak >= 8) {
    next = current * 2;
  } else if (noChangeStreak >= 3) {
    next = current * 1.5;
  } else {
    next = current * 1.15;
  }

  return clampInteger(Math.round(next), min, max, current);
}

export function sourceOutcomePatch(source, outcome = {}, { now = new Date() } = {}) {
  const checkedAt = validDate(outcome.checkedAt ?? outcome.checked_at ?? now);
  if (!checkedAt) throw new TypeError("outcome check time is invalid");
  const failed = Boolean(outcome.error ?? outcome.failed);
  const blocked = Boolean(outcome.blocked);
  const candidates = nonnegativeInteger(
    outcome.candidateCount ?? outcome.candidate_count ?? outcome.newCandidateUrls,
  );
  const validated = nonnegativeInteger(
    outcome.validatedCount ?? outcome.validated_count ?? outcome.newValidatedOpportunities,
  );
  const uniqueDiscoveries = nonnegativeInteger(
    outcome.uniqueDiscoveries ?? outcome.unique_discoveries ?? outcome.newOpportunities,
  );
  const changed = Boolean(outcome.changed) || uniqueDiscoveries > 0;
  const falsePositives = nonnegativeInteger(
    outcome.falsePositiveCount ?? outcome.false_positive_count ?? outcome.falsePositives,
  );
  const cost = Math.max(0, finiteNumber(
    outcome.estimatedCostEur ?? outcome.estimated_cost_eur,
  ));
  const checkCount = nonnegativeInteger(source?.check_count) + 1;
  const changedCount = nonnegativeInteger(source?.changed_check_count)
    + (changed ? 1 : 0);
  const totalCandidates = nonnegativeInteger(source?.candidate_url_count) + candidates;
  const successes = nonnegativeInteger(source?.successful_discoveries) + validated;
  const uniques = nonnegativeInteger(source?.unique_discoveries) + uniqueDiscoveries;
  const totalFalsePositives = nonnegativeInteger(source?.false_positive_count) + falsePositives;
  const interval = adaptivePollIntervalMinutes(source, outcome);
  const failures = failed ? nonnegativeInteger(source?.consecutive_failures) + 1 : 0;
  const noChange = failed || changed || uniqueDiscoveries > 0
    ? 0
    : nonnegativeInteger(source?.consecutive_no_change) + 1;
  const healthStatus = blocked
    ? "blocked"
    : failures >= 3
      ? "failing"
      : failures > 0
        ? "degraded"
        : "healthy";
  const patch = {
    last_checked_at: checkedAt.toISOString(),
    next_check_at: new Date(checkedAt.getTime() + interval * 60_000).toISOString(),
    poll_interval_minutes: interval,
    check_count: checkCount,
    changed_check_count: changedCount,
    candidate_url_count: totalCandidates,
    successful_discoveries: successes,
    unique_discoveries: uniques,
    false_positive_count: totalFalsePositives,
    consecutive_failures: failures,
    consecutive_no_change: noChange,
    yield_score: Number((uniques / checkCount).toFixed(6)),
    estimated_cost_eur: Number(
      (Math.max(0, finiteNumber(source?.estimated_cost_eur)) + cost).toFixed(8),
    ),
    health_status: healthStatus,
    health_message: failed || blocked
      ? String(outcome.error?.message ?? outcome.error ?? outcome.reason ?? healthStatus).slice(0, 500)
      : null,
    last_error_at: failed || blocked ? checkedAt.toISOString() : source?.last_error_at ?? null,
  };
  if (changed) patch.last_changed_at = checkedAt.toISOString();
  if (uniqueDiscoveries > 0) patch.last_new_opportunity_at = checkedAt.toISOString();
  return patch;
}

export function advanceSourceCheckpoint(checkpoint = {}, outcome = {}, options = {}) {
  const kind = outcome.cursorKind ?? outcome.cursor_kind
    ?? checkpoint.cursor_kind ?? options.cursorKind ?? "page";
  if (!new Set(["none", "page", "cursor", "link-window"]).has(kind)) {
    throw new TypeError(`Unsupported cursor kind: ${kind}`);
  }
  const now = isoDate(outcome.checkedAt ?? outcome.checked_at ?? options.now ?? new Date());
  const maxPage = clampInteger(
    options.maxPageNumber,
    1,
    100_000,
    DEFAULT_SOURCE_POLICY.maxPageNumber,
  );
  const maxLinkOffset = clampInteger(
    options.maxLinkOffset,
    0,
    1_000_000,
    DEFAULT_SOURCE_POLICY.maxLinkOffset,
  );
  const windowSize = clampInteger(
    outcome.linkWindowSize ?? outcome.link_window_size
      ?? checkpoint.link_window_size ?? options.linkWindowSize,
    1,
    200,
    DEFAULT_SOURCE_POLICY.linkWindowSize,
  );
  let pageNumber = clampInteger(checkpoint.page_number, 1, maxPage, 1);
  let linkOffset = clampInteger(checkpoint.link_offset, 0, maxLinkOffset, 0);
  let cursorValue = checkpoint.cursor_value ?? null;
  let cycleCount = nonnegativeInteger(checkpoint.cycle_count);
  let exhausted = false;
  let completedCycle = false;
  const explicitlyExhausted = outcome.exhausted === true || outcome.hasMore === false;

  if (kind === "page") {
    const requestedPage = outcome.nextPage ?? outcome.next_page;
    if (requestedPage !== undefined && requestedPage !== null) {
      pageNumber = clampInteger(requestedPage, 1, maxPage, pageNumber);
    } else if (explicitlyExhausted || pageNumber >= maxPage) {
      pageNumber = 1;
      cycleCount += 1;
      exhausted = true;
      completedCycle = true;
    } else {
      pageNumber += 1;
    }
  } else if (kind === "cursor") {
    const nextCursor = outcome.nextCursor ?? outcome.next_cursor;
    if (nextCursor === null || nextCursor === undefined || explicitlyExhausted) {
      cursorValue = null;
      cycleCount += 1;
      exhausted = true;
      completedCycle = true;
    } else {
      cursorValue = String(nextCursor).slice(0, 2000);
    }
  } else if (kind === "link-window") {
    const totalLinks = outcome.totalLinks ?? outcome.total_links;
    const proposed = Math.min(maxLinkOffset, linkOffset + windowSize);
    if (
      explicitlyExhausted
      || proposed >= maxLinkOffset
      || (Number.isFinite(Number(totalLinks)) && proposed >= Number(totalLinks))
    ) {
      linkOffset = 0;
      cycleCount += 1;
      exhausted = true;
      completedCycle = true;
    } else {
      linkOffset = proposed;
    }
  }

  return {
    cursor_kind: kind,
    cursor_value: cursorValue,
    page_number: pageNumber,
    link_offset: linkOffset,
    link_window_size: windowSize,
    cycle_count: cycleCount,
    request_count: nonnegativeInteger(checkpoint.request_count) + 1,
    exhausted,
    last_seen_url: normalizeHttpUrl(outcome.lastSeenUrl ?? outcome.last_seen_url)
      ?? checkpoint.last_seen_url ?? null,
    last_content_hash: outcome.contentHash ?? outcome.content_hash
      ?? checkpoint.last_content_hash ?? null,
    last_checked_at: now,
    ...(completedCycle ? { completed_cycle_at: now } : {}),
    state: plainObject(outcome.state)
      ? structuredClone(outcome.state)
      : plainObject(checkpoint.state)
        ? structuredClone(checkpoint.state)
        : {},
  };
}

export function buildNextSourceRequestUrl(source, checkpoint = {}) {
  const base = normalizeHttpUrl(source?.url ?? source?.base_url);
  if (!base) throw new TypeError("source URL must be an absolute HTTP(S) URL");
  const config = plainObject(source?.adapter_config) ? source.adapter_config : {};
  const kind = checkpoint.cursor_kind ?? config.cursor_kind ?? source.adapter ?? "none";
  const maxPage = clampInteger(
    config.max_pages,
    1,
    100_000,
    DEFAULT_SOURCE_POLICY.maxPageNumber,
  );
  const page = clampInteger(checkpoint.page_number, 1, maxPage, 1);
  const pageBase = clampInteger(config.page_base, 0, 100_000, 1);
  const requestPage = pageBase + page - 1;
  const offset = clampInteger(checkpoint.link_offset, 0, 1_000_000, 0);
  const limit = clampInteger(
    checkpoint.link_window_size ?? config.page_size,
    1,
    200,
    DEFAULT_SOURCE_POLICY.linkWindowSize,
  );
  const cursor = checkpoint.cursor_value ?? "";
  const template = config.url_template;
  let requestUrl = template
    ? String(template)
      .replaceAll("{page}", encodeURIComponent(requestPage))
      .replaceAll("{cursor}", encodeURIComponent(cursor))
      .replaceAll("{offset}", encodeURIComponent(offset))
      .replaceAll("{limit}", encodeURIComponent(limit))
    : base;
  requestUrl = new URL(requestUrl, base).toString();
  const parsed = new URL(requestUrl);

  if (!template && kind === "page") {
    parsed.searchParams.set(config.page_param ?? "page", String(requestPage));
  } else if (!template && kind === "cursor" && cursor) {
    parsed.searchParams.set(config.cursor_param ?? "cursor", String(cursor));
  } else if (!template && kind === "link-window" && config.offset_param) {
    parsed.searchParams.set(config.offset_param, String(offset));
  }
  if (!template && config.page_size_param) {
    parsed.searchParams.set(config.page_size_param, String(limit));
  }
  if (plainObject(config.static_params)) {
    for (const [name, value] of Object.entries(config.static_params)) {
      if (value !== null && value !== undefined) parsed.searchParams.set(name, String(value));
    }
  }
  parsed.hash = "";
  const safeUrl = normalizeHttpUrl(parsed.toString());
  if (!safeUrl) throw new TypeError("adapter produced a non-HTTP(S) request URL");
  return safeUrl;
}

export const nextSourceRequestUrl = buildNextSourceRequestUrl;
export const computeSourceOutcomePatch = sourceOutcomePatch;
