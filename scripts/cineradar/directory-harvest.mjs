// Pure helpers for turning opportunity directories into official sources.
// A directory (aggregator) page is used only to learn *where* a call lives:
// the official page it points to is registered as a source and then monitored
// and extracted like any other. No fact is copied from the directory.

import { BLOCKED_HOSTS, hostOf } from "./registry-seeds.mjs";
import { canonicalizeUrl } from "./web-validation.mjs";

// Never useful as a call's own page: social profiles, link shorteners, forms,
// media, generic infrastructure.
const NON_OFFICIAL_HOSTS = [
  "facebook.com", "instagram.com", "x.com", "twitter.com", "youtube.com", "youtu.be",
  "linkedin.com", "tiktok.com", "vimeo.com", "threads.net", "t.me", "discord.gg",
  "discord.com", "reddit.com", "pinterest.com", "wikipedia.org", "web.archive.org",
  "bit.ly", "linktr.ee", "forms.gle", "docs.google.com", "google.com", "goo.gl",
  "fonts.googleapis.com", "fonts.gstatic.com", "gstatic.com", "googletagmanager.com",
  "apple.com", "spotify.com", "medium.com", "substack.com", "github.com",
  "prnewswire.com", "businesswire.com", "globenewswire.com", "imdb.com",
  "wa.me", "whatsapp.com", "mailchimp.com", "eventbrite.com",
];

const DETAIL_PATH = /(?:contest|festival|call|opportunit|grant|residenc|competition|award|challenge|event|fund|lab\b|fellowship|prize|submission|convocatoria|bando|concorso|ausschreibung|appel)/i;
const LISTING_PATH = /\/(?:closing-soon|free|cash-prizes|categories?|tags?|topics?|page|location|search|guide|blog|news|vs|tools|creators|about|contact|privacy|terms)(?:\/|$)/i;
const OFFICIAL_LINK_TEXT = /\b(?:official|website|web ?site|visit|apply|submit|enter|register|more info|learn more|go to|homepage|site officiel|sito ufficiale|sitio oficial|inscr[ií]bete|iscriviti)\b/i;
// The monitor reads HTML only: documents and media are not sources.
const DOCUMENT_URL = /\.(?:pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|webp|mp4|mov)(?:[?#]|$)/i;
const EVENT_TYPES =/^(?:Event|Festival|ScreeningEvent|EducationEvent|SocialEvent|BusinessEvent|ExhibitionEvent|Grant|MonetaryGrant|CreativeWork|Competition)$/;

/** Registrable-domain approximation: festhome.com for filmmakers.festhome.com. */
export function baseDomain(host) {
  const labels = String(host ?? "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const secondLevel = labels.at(-2);
  const keep = labels.at(-1).length === 2 && secondLevel.length <= 3 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function hostMatches(host, list) {
  return Boolean(host) && list.some((item) => host === item || host.endsWith(`.${item}`));
}

export function isHarvestableHost(host, { directoryHost = null, directoryHosts = new Set() } = {}) {
  if (!host) return false;
  if (host === directoryHost || (directoryHost && host.endsWith(`.${directoryHost}`))) return false;
  if (directoryHosts.has(host)) return false;
  if (hostMatches(host, BLOCKED_HOSTS) || hostMatches(host, NON_OFFICIAL_HOSTS)) return false;
  return true;
}

/** `<loc>` entries of a sitemap or sitemap index. */
export function parseSitemapLocs(xml) {
  return [...String(xml ?? "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((match) => match[1].replace(/&amp;/g, "&"))
    .filter((url) => /^https?:\/\//i.test(url));
}

/** Detail pages of a directory: same host, call-like path, not a listing. */
export function detailUrls(urls, directoryHost) {
  const seen = new Set();
  const result = [];
  for (const raw of urls) {
    const url = canonicalizeUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== directoryHost) continue;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2 || LISTING_PATH.test(parsed.pathname)) continue;
    if (!DETAIL_PATH.test(parsed.pathname)) continue;
    result.push(url);
  }
  return result;
}

function* jsonLdObjects(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* jsonLdObjects(item);
  } else if (value && typeof value === "object") {
    yield value;
    if (Array.isArray(value["@graph"])) yield* jsonLdObjects(value["@graph"]);
  }
}

/** Official URLs a page declares in schema.org JSON-LD (event url, organizer url). */
export function jsonLdOfficialLinks(html) {
  const links = [];
  const blocks = String(html ?? "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue;
    }
    for (const item of jsonLdObjects(parsed)) {
      const types = [item["@type"]].flat().map(String);
      if (!types.some((type) => EVENT_TYPES.test(type))) continue;
      const name = typeof item.name === "string" ? item.name.slice(0, 200) : null;
      if (typeof item.url === "string") links.push({ url: item.url, name, via: "json-ld" });
      const organizer = [item.organizer].flat().find((entry) => entry && typeof entry.url === "string");
      if (organizer) links.push({ url: organizer.url, name: organizer.name ?? name, via: "json-ld-organizer" });
    }
  }
  return links;
}

/**
 * The official page(s) one directory detail page points to. JSON-LD is
 * preferred; otherwise outbound links labelled as the official site or the
 * way to apply. At most `limit` candidates, one per host.
 */
export function officialCandidates({ html, linkRecords = [], pageUrl, directoryHost, directoryHosts, limit = 2 }) {
  const ranked = [
    ...jsonLdOfficialLinks(html),
    ...linkRecords
      .filter((record) => OFFICIAL_LINK_TEXT.test(String(record.text ?? "")))
      .map((record) => ({ url: record.url, name: null, via: "labelled-link" })),
  ];
  const result = [];
  const hosts = new Set();
  let platformOnly = 0;
  for (const candidate of ranked) {
    const url = canonicalizeUrl(candidate.url, pageUrl);
    const host = hostOf(url);
    if (!url || !host || DOCUMENT_URL.test(url)) continue;
    if (hostMatches(host, BLOCKED_HOSTS)) {
      platformOnly += 1;
      continue;
    }
    if (!isHarvestableHost(host, { directoryHost, directoryHosts }) || hosts.has(baseDomain(host))) continue;
    hosts.add(baseDomain(host));
    result.push({ ...candidate, url, host });
    if (result.length >= limit) break;
  }
  return { candidates: result, platformOnly: platformOnly > 0 && result.length === 0 };
}

/** Source row for a harvested official page. Checked on the next monitor run. */
export function harvestedSource(candidate, { ai = false, directoryHost, now = Date.now() }) {
  return {
    name: String(candidate.name ?? candidate.host).replace(/\s+/g, " ").trim().slice(0, 200) || candidate.host,
    url: candidate.url,
    tier: 2,
    priority: ai ? 1 : 2,
    source_type: "official",
    source_family: ai ? "ai-creative-tech" : "official-site",
    country: null,
    region: null,
    language: null,
    opportunity_categories: ai ? ["ai-film"] : [],
    adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 6, seed: "directory-harvest", found_via: directoryHost, found_by: candidate.via },
    min_poll_interval_minutes: 360,
    poll_interval_minutes: 1_440,
    max_poll_interval_minutes: 10_080,
    next_check_at: new Date(now).toISOString(),
  };
}
