// Pure helpers that turn external registries (Wikidata, owner research
// datasets) into source-registry rows, and define the coverage hold-out.
// Seeds describe *where to look*; opportunities are only ever extracted from
// the live pages those sources point to.

import { createHash } from "node:crypto";

export const HOLDOUT_SALT = "cineradar-holdout-v1";
export const HOLDOUT_FRACTION = 0.2;

// Hosts that are submission platforms or aggregators, not a series' own site.
// FilmFreeway blocks automated clients; it must never be fetched.
export const PLATFORM_HOSTS = Object.freeze([
  "filmfreeway.com", "festhome.com", "shortfilmdepot.com", "clickforfestivals.com",
  "movibeta.com", "submittable.com", "eventival.com", "filmfestplatform.com",
  "forms.gle", "docs.google.com", "formstack.com", "smapply.org", "wixsite.com",
  "facebook.com", "instagram.com", "x.com", "twitter.com", "youtube.com",
  "linkedin.com", "tiktok.com", "wikipedia.org", "web.archive.org",
]);
export const BLOCKED_HOSTS = Object.freeze(["filmfreeway.com"]);

const STOP_WORDS = /\b(?:the|festival|film|films|international|intl|of|and|de|du|des|la|le|les|di|del|della|der|die|das|und|awards?|competition|edition|annual|fest)\b/g;

/** Edition-agnostic series key: drops years, ordinals and filler words. */
export function seriesKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b\d+(?:st|nd|rd|th|e|er|a|o|º|ª)?\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(STOP_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hostOf(url) {
  try {
    return new URL(String(url).trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isPlatformHost(host) {
  return Boolean(host) && PLATFORM_HOSTS.some((platform) => host === platform || host.endsWith(`.${platform}`));
}

function hashFraction(value) {
  const digest = createHash("sha256").update(`${HOLDOUT_SALT}\u001f${value}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Deterministic hold-out membership for a series. Held-out series are never
 * seeded from the owner's datasets, so finding them measures real discovery.
 */
export function isHeldOut(key, { fraction = HOLDOUT_FRACTION } = {}) {
  return Boolean(key) && hashFraction(key) < fraction;
}

export function safeSeedUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Spread first checks so a large import never lands on one monitor run. */
export function staggeredFirstCheck(url, { now = Date.now(), spreadDays = 14 } = {}) {
  const offset = Math.floor(hashFraction(`stagger\u001f${url}`) * spreadDays * 86_400_000);
  return new Date(now + offset).toISOString();
}

const DATASET_CATEGORY_RULES = [
  [/\bai\b|genai|generative|ai_film|ai film|platform_genvideo/i, ["ai-film"]],
  [/animation|animat/i, ["animation"]],
  [/music[_ ]video/i, ["music-video"]],
  [/experimental|new[_ ]?media|video[_ ]?art|digital art|xr|immersive|exhibition|public[_ ]screen/i, ["experimental-new-media"]],
  [/grant|fund|commission|mobility/i, ["grant"]],
  [/residen/i, ["residency"]],
  [/lab|fellowship|talent|market|incubat/i, ["lab-fellowship"]],
  [/brand|advertis/i, ["branded-open-call"]],
  [/platform|creator|challenge|contest/i, ["platform-challenge"]],
  [/short/i, ["short-film"]],
  [/festival|screening|award|prize|competition/i, ["film-festival"]],
];

export function datasetCategories(...labels) {
  const text = labels.filter(Boolean).join(" ");
  const categories = DATASET_CATEGORY_RULES.filter(([pattern]) => pattern.test(text)).flatMap(([, value]) => value);
  return [...new Set(categories)].slice(0, 6);
}

function datasetFamily(categories, url) {
  if (categories.includes("ai-film")) return "ai-creative-tech";
  if (categories.includes("grant")) return "film-funding";
  if (categories.includes("residency") || categories.includes("experimental-new-media")) return "media-art-residency";
  if (categories.includes("platform-challenge") || categories.includes("branded-open-call")) return "platform-company";
  if (/\b(?:arts?council|ministry|gov|gob|gouv)\b/i.test(hostOf(url) ?? "")) return "film-funding";
  return "official-site";
}

const ACTIONABLE_STATUS = /^(?:open|upcoming|rolling|announced|in_progress)/i;

/**
 * Source row for one dataset record, or null when it has no usable own URL.
 * Platform URLs are skipped: a series' own site is what gets monitored.
 */
export function sourceFromDatasetRow(row, { dataset, now = Date.now() } = {}) {
  const candidates = [row.official_url, row.source_url].map(safeSeedUrl).filter(Boolean);
  const url = candidates.find((value) => !isPlatformHost(hostOf(value)));
  if (!url) return null;
  const name = String(row.event_series ?? row.opportunity_name ?? row.organization ?? hostOf(url)).trim().slice(0, 300);
  const categories = datasetCategories(row.category_primary, row.category_secondary, name);
  const actionable = ACTIONABLE_STATUS.test(String(row.status_at_2026_09_25 ?? ""));
  const pollMinutes = actionable ? 3 * 1_440 : 10 * 1_440;
  return {
    name,
    url,
    tier: actionable ? 1 : 2,
    priority: actionable ? 1 : 2,
    source_type: "official",
    source_family: datasetFamily(categories, url),
    country: /^[A-Za-z]{2}$/.test(String(row.country ?? "")) ? String(row.country).toUpperCase() : null,
    region: row.region ? String(row.region).slice(0, 60) : null,
    language: normalizeLanguageTag(row.source_language),
    opportunity_categories: categories,
    adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 2, seed: dataset },
    min_poll_interval_minutes: 720,
    poll_interval_minutes: pollMinutes,
    max_poll_interval_minutes: 30 * 1_440,
    next_check_at: staggeredFirstCheck(url, { now, spreadDays: actionable ? 1 : 7 }),
  };
}

/** Source row for a directory/portal (Monitor list, Local channels, Sources sheets). */
export function sourceFromPortalRow(row, { dataset, now = Date.now() } = {}) {
  const url = safeSeedUrl(row.url);
  if (!url || isPlatformHost(hostOf(url))) return null;
  const name = String(row.organization ?? row.portal_or_board ?? row.domain ?? hostOf(url)).trim().slice(0, 300);
  const categories = datasetCategories(row.what_it_surfaces, row.why_monitor, row.source_family, name);
  return {
    name,
    url,
    tier: 1,
    priority: 1,
    source_type: "official",
    source_family: /portal|board|aggregator|listing|network/i.test(`${row.source_family ?? ""} ${row.what_it_surfaces ?? ""} ${name}`)
      ? "opportunity-directory"
      : datasetFamily(categories, url),
    country: /^[A-Za-z]{2}$/.test(String(row.country ?? "")) ? String(row.country).toUpperCase() : null,
    region: null,
    language: normalizeLanguageTag(row.language ?? row.languages),
    opportunity_categories: categories,
    adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 4, seed: dataset },
    min_poll_interval_minutes: 720,
    poll_interval_minutes: 3 * 1_440,
    max_poll_interval_minutes: 14 * 1_440,
    next_check_at: staggeredFirstCheck(url, { now, spreadDays: 2 }),
  };
}

/** Source row for an active Wikidata film-festival item with an official site. */
export function sourceFromWikidata(item, { now = Date.now() } = {}) {
  const url = safeSeedUrl(item.site);
  if (!url || isPlatformHost(hostOf(url))) return null;
  return {
    name: String(item.label || hostOf(url)).trim().slice(0, 300),
    url,
    tier: 3,
    priority: 3,
    source_type: "official",
    source_family: "official-site",
    country: /^[A-Z]{2}$/.test(String(item.country ?? "")) ? item.country : null,
    region: null,
    language: null,
    opportunity_categories: ["film-festival"],
    adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 2, seed: "wikidata", wikidata_id: item.id },
    min_poll_interval_minutes: 1_440,
    poll_interval_minutes: 21 * 1_440,
    max_poll_interval_minutes: 60 * 1_440,
    next_check_at: staggeredFirstCheck(url, { now, spreadDays: 21 }),
  };
}

function normalizeLanguageTag(value) {
  const first = String(value ?? "").toLowerCase().split(/[\s/,;]+/)[0];
  const aliases = { english: "en", spanish: "es", french: "fr", portuguese: "pt", italian: "it", german: "de", japanese: "ja", korean: "ko", chinese: "zh" };
  const tag = aliases[first] ?? first;
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag) ? tag : null;
}

/**
 * Merge seed rows by URL. The strongest (lowest) priority and shortest poll
 * interval win; categories are unioned; first-check time is the earliest.
 */
export function mergeSeedSources(rows) {
  const byUrl = new Map();
  for (const row of rows) {
    if (!row) continue;
    const existing = byUrl.get(row.url);
    if (!existing) {
      byUrl.set(row.url, { ...row, opportunity_categories: [...row.opportunity_categories] });
      continue;
    }
    existing.priority = Math.min(existing.priority, row.priority);
    existing.tier = Math.min(existing.tier, row.tier);
    existing.poll_interval_minutes = Math.min(existing.poll_interval_minutes, row.poll_interval_minutes);
    existing.min_poll_interval_minutes = Math.min(existing.min_poll_interval_minutes, row.min_poll_interval_minutes);
    existing.max_poll_interval_minutes = Math.max(existing.max_poll_interval_minutes, row.max_poll_interval_minutes, existing.poll_interval_minutes);
    existing.opportunity_categories = [...new Set([...existing.opportunity_categories, ...row.opportunity_categories])].slice(0, 32);
    existing.next_check_at = existing.next_check_at < row.next_check_at ? existing.next_check_at : row.next_check_at;
    existing.country ??= row.country;
    existing.language ??= row.language;
    if (existing.source_family === "official-site" && row.source_family !== "official-site") existing.source_family = row.source_family;
  }
  return [...byUrl.values()];
}

/** Chapman's bias-corrected Lincoln-Petersen estimate of population size. */
export function chapman(n1, n2, m) {
  return Math.round(((n1 + 1) * (n2 + 1)) / (m + 1) - 1);
}

// Result hosts that describe a series but are never its own site.
const NON_OFFICIAL_HOSTS = [
  "imdb.com", "letterboxd.com", "wikipedia.org", "wikidata.org", "festivalfocus.org",
  "filmfestivallife.com", "filmmakers.festhome.com", "reddit.com", "medium.com",
  "eventbrite.com", "allevents.in", "withoutabox.com", "stage32.com", "backstage.com",
  "festagent.com", "festivalreel.com", "filmfestivalguild.com", "stayhappening.com",
];

/** Initials of a series name, including filler words ("Burano AI Film Festival" -> "baiff"). */
function nameInitials(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("");
}

function nameTokens(value) {
  return seriesKey(value).split(" ").filter((token) => token.length > 2);
}

/**
 * Choose a series' own website from search results, or null. The result must
 * not be a platform/database and must share most of the series' name tokens
 * (in its title or host); single-word names must appear in the host.
 */
export function pickOfficialSite(seriesName, results) {
  const wanted = nameTokens(seriesName);
  if (!wanted.length) return null;
  for (const result of results ?? []) {
    const url = safeSeedUrl(result?.url);
    const host = hostOf(url);
    if (!url || !host || isPlatformHost(host)) continue;
    if (NON_OFFICIAL_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) continue;
    const hostText = host.replace(/[.-]/g, " ");
    const haystack = new Set([...nameTokens(result.title ?? ""), ...nameTokens(hostText)]);
    const compactHost = host.replace(/[^a-z0-9]/g, "");
    const shared = wanted.filter((token) => haystack.has(token) || compactHost.includes(token)).length;
    // Own sites carry the series' name or initials in the domain; listings,
    // news articles and similarly named organisations usually do not.
    const registrable = host.split(".").slice(0, -1).join("").replace(/[^a-z0-9]/g, "");
    const initials = nameInitials(seriesName);
    const hostNamesSeries = wanted.some((token) => token.length >= 3 && registrable.includes(token))
      || (initials.length >= 3 && registrable.includes(initials.slice(0, Math.min(initials.length, 5))));
    if (!hostNamesSeries) continue;
    if (wanted.length === 1 ? compactHost.includes(wanted[0]) : shared / wanted.length >= 0.6) {
      return url;
    }
  }
  return null;
}

/** A host listing this many distinct series is a channel (aggregator, portal), not one series' site. */
export const CHANNEL_MIN_SERIES = 3;

/**
 * Hosts that serve several series in the owner's datasets. They are monitored
 * as directories and never excluded by the hold-out: finding a held-out series
 * through a general channel is the discovery the hold-out is meant to measure.
 *
 * @param {Array<Record<string, any>>} seriesRows dataset rows
 * @returns {Map<string, number>} host -> distinct series count
 */
export function channelHosts(seriesRows) {
  const byHost = new Map();
  for (const row of seriesRows) {
    const key = seriesKey(row.event_series ?? row.opportunity_name);
    if (!key) continue;
    for (const url of [row.official_url, row.source_url]) {
      const host = hostOf(url);
      if (!host || isPlatformHost(host)) continue;
      if (!byHost.has(host)) byHost.set(host, new Set());
      byHost.get(host).add(key);
    }
  }
  return new Map([...byHost].filter(([, keys]) => keys.size >= CHANNEL_MIN_SERIES).map(([host, keys]) => [host, keys.size]));
}

/** Directory source for a channel host: its home page, checked daily with a wider link window. */
export function channelSource(host, seriesCount, { now = Date.now() } = {}) {
  const url = `https://${host}/`;
  return {
    name: host,
    url,
    tier: 1,
    priority: 1,
    source_type: "community",
    source_family: "opportunity-directory",
    country: null,
    region: null,
    language: null,
    opportunity_categories: [],
    adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 6, seed: "dataset-channel", series_count: seriesCount },
    min_poll_interval_minutes: 360,
    poll_interval_minutes: 1_440,
    max_poll_interval_minutes: 4_320,
    next_check_at: staggeredFirstCheck(url, { now, spreadDays: 1 }),
  };
}
