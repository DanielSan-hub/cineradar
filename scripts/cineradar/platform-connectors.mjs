// Readable submission platforms (robots.txt allows them; FilmFreeway is never
// used). Festhome publishes, for each festival, its deadline calendar, its
// own website and its rules: a structured, organizer-maintained source. Pure
// parsers: no network, no database.

import { isAiFilmText } from "./call-signal.mjs";
import { hostOf } from "./registry-seeds.mjs";

export const FESTHOME_LISTING = "https://filmmakers.festhome.com/en/festivals";
export const festhomeDetailUrl = (id) => `https://filmmakers.festhome.com/festival/${id}`;
// The listing loads further pages as AJAX fragments (request them with X-Requested-With).
export const festhomeListingPage = (page) => `https://filmmakers.festhome.com/festivals/page:${page}`;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const FULL_MONTH = "January|February|March|April|May|June|July|August|September|October|November|December";
const SHORT_MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

function isoDate(day, monthName, year) {
  const month = MONTHS[String(monthName).slice(0, 3).toLowerCase()];
  const date = new Date(Date.UTC(Number(year), month - 1, Number(day)));
  if (!month || date.getUTCMonth() !== month - 1) return null;
  return date.toISOString().slice(0, 10);
}

/** Festival cards on a listing page: id, name, slug and the dates shown. */
export function parseFesthomeListing(html) {
  const cards = [];
  for (const chunk of String(html ?? "").split(/festival_card-container-/).slice(1)) {
    const name = /alt="Logo of ([^"]+)"/.exec(chunk)?.[1];
    const id = /OpenNewTab\(event,(\d+)\)/.exec(chunk)?.[1] ?? /href="\/festival\/(\d+)"/.exec(chunk)?.[1];
    if (!name || !id) continue;
    const dates = [...chunk.matchAll(new RegExp(`(\\d{1,2}) (${FULL_MONTH}) (\\d{4})`, "g"))]
      .map((match) => isoDate(match[1], match[2], match[3]))
      .filter(Boolean);
    cards.push({
      id,
      name: name.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, "\"").trim(),
      slug: /data-full_url="([^"]+)"/.exec(chunk)?.[1] ?? null,
      dates,
    });
  }
  return cards;
}

export function listingHasFutureDeadline(cards, now = Date.now()) {
  return cards.some((card) => card.dates.some((date) => Date.parse(`${date}T23:59:59Z`) >= now));
}

/** The deadline calendar of a festival page: "15 Jun 2026 Early deadline …". */
export function parseFesthomeDeadlines(text) {
  const body = String(text ?? "");
  const start = body.search(/\bDeadlines\b/);
  if (start < 0) return [];
  // Dates and labels sit on separate lines in the page text.
  const block = body.slice(start, start + 900).replace(/\s+/g, " ");
  const entries = [];
  // A countdown ("3 mths", "6 days") may sit between a label and the next date.
  const countdown = "(?:\\d+\\s+(?:mths?|months?|days?|weeks?|wks?|hours?|hrs?|years?|yrs?|mins?)\\s+)?";
  const pattern = new RegExp(`(\\d{1,2}) (${SHORT_MONTH})[a-z]* (\\d{4}) ([A-Za-z][A-Za-z .()/-]{1,40}?)(?=\\s+${countdown}\\d{1,2} (?:${SHORT_MONTH})[a-z]* \\d{4}|\\s+${countdown}(?:Address|Location|Contact|Festival description)|\\s*$)`, "g");
  for (const match of block.matchAll(pattern)) {
    const date = isoDate(match[1], match[2], match[3]);
    if (!date) continue;
    entries.push({ date, label: match[4].trim(), evidence: match[0].replace(/\s+/g, " ").trim().slice(0, 120) });
  }
  return entries;
}

/** The last submission deadline (never the notification or event dates). */
export function finalFesthomeDeadline(entries) {
  const deadlines = entries.filter((entry) => /deadline/i.test(entry.label) && !/notification|result/i.test(entry.label));
  return deadlines.sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
}

const NOT_A_WEBSITE = /(?:^|\.)(?:festhome\.com|festhomedocs\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|vimeo\.com|linkedin\.com|tiktok\.com|google\.[a-z.]+|googleapis\.com|gstatic\.com|doubleclick\.net|fontawesome\.com|uservoice\.com|apple\.com|cloudflare\.com|jsdelivr\.net|bootstrapcdn\.com|stripe\.com|paypal\.com|filmfreeway\.com)$/i;

/** The festival's own website linked from its platform page. */
export function platformWebsite(linkRecords) {
  for (const link of linkRecords ?? []) {
    const host = hostOf(link.url);
    if (!host || NOT_A_WEBSITE.test(host)) continue;
    if (!/^https?:/i.test(link.url)) continue;
    return link.url;
  }
  return null;
}

function jsonLdEventName(html) {
  for (const [, body] of String(html ?? "").matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(body.trim());
      for (const item of [data].flat()) {
        if (String(item?.["@type"]).includes("Event") && typeof item.name === "string") return item.name.trim();
      }
    } catch {
      // Malformed JSON-LD: fall back to the listing name.
    }
  }
  return null;
}

function categoryFor(name, text) {
  const value = `${name} ${String(text ?? "").slice(0, 4000)}`;
  if (isAiFilmText(name)) return "AI film festival";
  if (/\b(?:pitch|lab|fund|grant|beca|ayuda|convocatoria de proyectos|desarrollo|development)\b/i.test(name)) return "Grant";
  if (/\bresiden/i.test(name)) return "Residency";
  if (/\bmusic video\b|videoclip/i.test(name)) return "Advertising competition";
  return isAiFilmText(value) && /\bai\b/i.test(name) ? "AI film festival" : "Traditional festival";
}

/**
 * Raw item (LLM output shape) for one festival page on Festhome, or null when
 * the page shows no future submission deadline.
 */
export function festhomeRawItem({ page, card = null, now = Date.now() }) {
  const deadline = finalFesthomeDeadline(parseFesthomeDeadlines(page?.text));
  if (!deadline) return null;
  const name = jsonLdEventName(page.html) ?? card?.name ?? null;
  if (!name) return null;
  const organizer = name.replace(/\s*\b(?:19|20)\d{2}\b.*$/, "").replace(/\s+/g, " ").trim() || name;
  const open = Date.parse(`${deadline.date}T23:59:59Z`) >= now;
  return {
    relevant: true,
    title: name,
    canonical_name: name,
    organizer,
    category: categoryFor(name, page.text),
    ai_policy: "unclear",
    deadline: deadline.date,
    deadline_status: "confirmed",
    deadline_evidence: deadline.evidence,
    observed_status: open ? null : "closed",
    status_evidence: open ? null : deadline.evidence,
    deadline_source_url: page.finalUrl,
    opens_at: null,
    prize_amount: null,
    prize_currency: null,
    entry_fee_amount: null,
    entry_fee_currency: null,
    location: null,
    remote: false,
    max_runtime_minutes: null,
    official_url: platformWebsite(page.linkRecords),
    application_url: page.finalUrl,
    source_type: "community",
    confidence: 0.75,
    summary: "",
    eligibility: [],
    formats: [],
    tags: ["platform:festhome", ...(card?.id ? [`festhome:${card.id}`] : [])],
    opportunity_year: Number(deadline.date.slice(0, 4)),
    edition: null,
    field_evidence: { title: name, organizer: name, opens_at: null, prize: null, entry_fee: null, location: null, max_runtime: null, ai_policy: null, eligibility: null, formats: null },
    series_evidence: { method: "platform-festhome-v1", deadline_method: "platform-calendar", platform: "Festhome" },
  };
}
