// Lead feeds: sites that announce calls (news aggregators such as Ti
// Consiglio's "Concorsi creativi") are read only for the *name* of a call.
// Nothing they write is copied: the name goes to the site resolver, which
// finds the organizer's own page, and every fact is read there. Their terms
// forbid reproducing their content; reading their RSS headlines is what a
// feed is for. Pure helpers: no network, no database.

export const LEAD_FEEDS = Object.freeze([
  { name: "Ti Consiglio – Concorsi creativi", url: "https://www.ticonsiglio.com/category/concorsi-creativi/feed/", host: "ticonsiglio.com", language: "it" },
]);

function decode(value) {
  return String(value ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#8217;|&#039;|&rsquo;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, "\"")
    .replace(/&#8211;|&ndash;/g, "–").replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** RSS items: title, link, publication date. */
export function parseRssItems(xml) {
  return [...String(xml ?? "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => ({
    title: decode(/<title>([\s\S]*?)<\/title>/.exec(match[1])?.[1]),
    link: decode(/<link>([\s\S]*?)<\/link>/.exec(match[1])?.[1]),
    published: Date.parse(decode(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(match[1])?.[1])) || null,
  })).filter((item) => item.title && item.link);
}

// Film, moving image and AI calls; photography, writing or music alone are out.
const RELEVANT = /\b(?:film|cinema|cinematograf\w*|cortometragg\w*|corto|lungometragg\w*|video\w*|regia|registi|sceneggiatur\w*|audiovisiv\w*|animazion\w*|animat\w*|documentar\w*|videoclip|multimedia\w*|new media|arte digitale|digital art|intelligenza artificiale|artificial intelligence|AI|IA|immersiv\w*|realtà virtuale|VR)\b/iu;
const ROUNDUP = /\b(?:le migliori opportunità|migliori concorsi|tutti i concorsi|elenco|calendario)\b/iu;

/** A headline about one film, video, media-art or AI call. */
export function relevantLead(title) {
  return RELEVANT.test(title) && !ROUNDUP.test(title);
}

/**
 * The call's own name in a headline: a quoted name ("“AI Horizons”"), else
 * the text before the first comma or colon ("Malamegi Lab Art Prize 2027,
 * concorso d'arte ..."). Null when the headline names no call.
 */
export function leadName(title) {
  const text = String(title ?? "").trim();
  const quoted = /[“"«]([^”"»]{3,80})[”"»]/.exec(text)?.[1];
  if (quoted) return quoted.trim();
  const head = text.split(/\s*[,:–]\s+/)[0].trim();
  // A headline that starts with a generic description names nothing.
  if (/^(?:concorso|bando|premio|call|contest|opportunità|nuovo|nuova)\b[^A-Z0-9]*$/iu.test(head) || head.split(/\s+/).length < 2) return null;
  return head.slice(0, 100);
}

const NEWS_PATH = /\/(?:articolo|articoli|article|news|notizie|events?|eventi|blog|post|magazine|\d{4}\/\d{2})\//iu;

/**
 * For a lead, the organizer's own site may not carry the call's name in its
 * domain (PARMA 360's "AI Horizons"): a result counts when it is the call's
 * own document or page on that site - a PDF in the site's uploads, or a page
 * whose path names the call - and not a news or aggregator article.
 */
export function leadCallPage(name, result, { exclude = [] } = {}) {
  let url;
  try {
    url = new URL(result?.url);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (exclude.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return false;
  if (/(?:^|\.)(?:blogspot\.com|wordpress\.com|medium\.com|substack\.com)$/.test(host)) return false;
  const words = String(name ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  if (!words.length) return false;
  const path = decodeURIComponent(url.pathname).toLowerCase();
  const title = String(result?.title ?? "").toLowerCase();
  const named = (text) => words.filter((word) => text.includes(word)).length / words.length >= 0.6;
  const pdf = /\.pdf$/.test(path);
  if (pdf) return /\/wp-content\/uploads\/|\/(?:bandi?|regolament\w*|call|docs?|download)/.test(path) && (named(path) || named(title));
  return !NEWS_PATH.test(path) && named(path);
}
