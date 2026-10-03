// EU Funding & Tenders Portal: Creative Europe MEDIA calls for film and
// audiovisual producers. The portal's public search API (no account, no key
// of ours; robots.txt allows it) gives each topic's title, status, opening
// date and deadlines. Reuse is free with attribution (Commission Decision
// 2011/833/EU, CC BY 4.0): records keep the portal page as their source and
// the site credits "EU Funding & Tenders Portal, © European Union".
// Pure helpers: no network, no database.

export const EU_FT_SEARCH = "https://api.tech.ec.europa.eu/search-api/prod/rest/search";
export const EU_CREATIVE_EUROPE = "43251814";
const OPEN = "31094502";
const FORTHCOMING = "31094501";

// Topics a film or audiovisual production company applies to (the default
// scope). Industry topics (distribution, sales, festivals, markets,
// training) are included only with EU_FT_INCLUDE_INDUSTRY=true.
export const FILMMAKER_TOPIC = /^CREA-(?:MEDIA|CROSS)-\d{4}-(?:DEVSLATE|DEVMINISLATE|MINISLATE|CODEV|DEVVGIM|TVONLINE(?:-\d+)?|INNOVLAB)$/;
export const INDUSTRY_TOPIC = /^CREA-(?:MEDIA|CROSS)-\d{4}-/;

/** The search request: multipart parts, each a JSON value. */
export function euSearchQuery({ programme = EU_CREATIVE_EUROPE } = {}) {
  return {
    query: { bool: { must: [{ terms: { type: ["1", "2"] } }, { terms: { status: [FORTHCOMING, OPEN] } }, { terms: { frameworkProgramme: [programme] } }] } },
    languages: ["en"],
    sort: [{ field: "deadlineDate", order: "ASC" }],
  };
}

export function euSearchUrl(pageNumber = 1, pageSize = 100) {
  return `${EU_FT_SEARCH}?apiKey=SEDIA&text=***&pageSize=${pageSize}&pageNumber=${pageNumber}`;
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseJson(value) {
  try {
    return JSON.parse(first(value) ?? "null");
  } catch {
    return null;
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Topics from a search response: identifier, title, portal URL, the topic's
 * own actions (status, opening date, deadline dates) and tags. The index
 * status is stale for old topics: only the actions' status counts.
 */
export function parseEuSearchResults(json) {
  const topics = [];
  for (const result of json?.results ?? []) {
    const metadata = result.metadata ?? {};
    const identifier = String(first(metadata.identifier) ?? "").trim();
    if (!identifier || String(first(metadata.type)) === "8") continue;
    const actions = (parseJson(metadata.actions) ?? []).filter((action) => action && typeof action === "object");
    const deadlines = [...new Set(actions.flatMap((action) => action.deadlineDates ?? []).filter((date) => ISO_DAY.test(String(date))))].sort();
    const opening = actions.map((action) => action.plannedOpeningDate).find((date) => ISO_DAY.test(String(date))) ?? null;
    topics.push({
      identifier,
      title: String(first(metadata.title) ?? result.summary ?? "").trim(),
      url: String(first(metadata.url) ?? result.url ?? ""),
      callIdentifier: String(first(metadata.callIdentifier) ?? ""),
      deadlineModel: String(first(metadata.deadlineModel) ?? ""),
      status: actions.map((action) => action.status?.abbreviation).find(Boolean) ?? null,
      opening,
      deadlines,
      typeOfAction: actions.flatMap((action) => (action.types ?? []).map((type) => type.typeOfAction)).find(Boolean) ?? null,
      tags: (metadata.tags ?? []).map(String).slice(0, 12),
      checksum: String(first(metadata.esST_checksum) ?? ""),
    });
  }
  return topics;
}

/** The next cut-off on or after today (null when every deadline has passed). */
export function nextCutoff(topic, now = Date.now()) {
  return topic.deadlines.find((date) => Date.parse(`${date}T23:59:59Z`) >= now) ?? null;
}

/** An open topic in scope with a future deadline. */
export function euTopicInScope(topic, { now = Date.now(), includeIndustry = false } = {}) {
  const scope = includeIndustry ? INDUSTRY_TOPIC : FILMMAKER_TOPIC;
  if (!scope.test(topic.identifier)) return false;
  if (topic.status !== "Open") return false;
  if (topic.opening && Date.parse(`${topic.opening}T00:00:00Z`) > now) return false;
  return Boolean(nextCutoff(topic, now));
}

/** Deterministic page text from the API values (what the record is grounded on). */
export function euTopicText(topic, description = "") {
  return [
    `EU Funding & Tenders Portal – topic ${topic.identifier}`,
    `Title: ${topic.title}`,
    "Programme: Creative Europe MEDIA",
    "Organizer: European Commission – Creative Europe MEDIA",
    topic.callIdentifier ? `Call: ${topic.callIdentifier}` : null,
    `Status: ${topic.status ?? "unknown"}`,
    topic.opening ? `Opening date: ${topic.opening}` : null,
    topic.deadlineModel ? `Deadline model: ${topic.deadlineModel}` : null,
    ...topic.deadlines.map((date) => `Deadline: ${date}`),
    topic.typeOfAction ? `Type of action: ${topic.typeOfAction}` : null,
    topic.tags.length ? `Topics: ${topic.tags.join(", ")}` : null,
    String(description ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 4000),
  ].filter(Boolean).join("\n");
}

/** Raw item (LLM output shape) for one open topic. */
export function euRawItem(topic, { now = Date.now() } = {}) {
  const deadline = nextCutoff(topic, now);
  if (!deadline) return null;
  const title = `Creative Europe MEDIA – ${topic.title}`.replace(/\bProgramme\b/gi, "").replace(/\s+/g, " ").trim();
  const animation = topic.tags.some((tag) => /animation/i.test(tag));
  return {
    relevant: true,
    title,
    canonical_name: topic.identifier,
    organizer: "European Commission – Creative Europe MEDIA",
    category: "Grant",
    ai_policy: "unclear",
    deadline,
    deadline_status: "confirmed",
    deadline_evidence: `Deadline: ${deadline}`,
    observed_status: null,
    status_evidence: null,
    deadline_source_url: topic.url,
    opens_at: topic.opening,
    // Call budgets are shared across topics: never a prize.
    prize_amount: null,
    prize_currency: null,
    entry_fee_amount: null,
    entry_fee_currency: null,
    location: null,
    remote: false,
    max_runtime_minutes: null,
    official_url: topic.url,
    application_url: topic.url,
    source_type: "official",
    confidence: 0.85,
    summary: "",
    eligibility: [],
    formats: animation ? ["animation"] : [],
    tags: ["platform:eu-ft-portal", `eu-topic:${topic.identifier}`],
    opportunity_year: Number(deadline.slice(0, 4)),
    edition: null,
    field_evidence: { title: topic.title, organizer: "European Commission – Creative Europe MEDIA", opens_at: topic.opening ? `Opening date: ${topic.opening}` : null, prize: null, entry_fee: null, location: null, max_runtime: null, ai_policy: null, eligibility: null, formats: null },
    series_evidence: { method: "eu-ft-portal-v1", deadline_method: "portal-api", platform: "EU Funding & Tenders Portal", cutoffs: topic.deadlines },
  };
}

/** The topic identifier of a portal topic page, or null. */
export function euTopicIdentifier(url) {
  return /^https:\/\/ec\.europa\.eu\/info\/funding-tenders\/opportunities\/portal\/screen\/opportunities\/topic-details\/([A-Za-z0-9-]+)\/?$/.exec(String(url ?? ""))?.[1] ?? null;
}

export function euTopicDetailsUrl(identifier) {
  return `https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/${String(identifier).toLowerCase()}.json`;
}

/** Open status and deadline dates (YYYY-MM-DD) from a topicDetails JSON. */
export function euTopicDetailsState(json) {
  const actions = json?.TopicDetails?.actions ?? [];
  const toDay = (value) => {
    const text = String(value ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const time = Number(text);
    return Number.isFinite(time) && time > 0 ? new Date(time).toISOString().slice(0, 10) : null;
  };
  return {
    open: actions.some((action) => action?.status?.abbreviation === "Open"),
    deadlines: [...new Set(actions.flatMap((action) => (action?.deadlineDates ?? []).map(toDay)).filter(Boolean))].sort(),
  };
}
