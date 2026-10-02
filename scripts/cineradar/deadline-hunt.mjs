// Pure helpers for the deadline hunt: a pending record without a deadline is
// usually extracted from a homepage, while its dates live on the call's
// "Submit", "Rules" or "Dates" page. These helpers pick those pages and read a
// deadline from them with verbatim evidence. No network, no database.

import { MONTH_NUMBERS, scoreCallSignal } from "./call-signal.mjs";
import { extractDeadline } from "./decision-fields.mjs";
import { BLOCKED_HOSTS } from "./registry-seeds.mjs";

const DAY = 86_400_000;

// Pages that state a call's dates and rules, in the languages we monitor.
const HUNT_LINK = /\b(?:submit\w*|submission\w*|apply|application\w*|entr(?:y|ies)|enter|rules|regulations?|guidelines|terms|deadlines?|dates|timeline|calendar|call|open[- ]?call|how[- ]to|participat\w*|register|registration|faq|eligib\w*|bases|reglamento|convocatoria|inscripci\w*|bando|regolamento|iscrizion\w*|partecipa\w*|scadenz\w*|einreich\w*|teilnahme\w*|ausschreibung|appel|candidature\w*|r[eè]glement|inscription\w*|edital|inscri[cç][oõ]es)\b|応募|募集|締切|공모|접수|报名|征集/iu;
const HUNT_NEGATIVE = /\b(?:winners?|jury|juries|archive|past|press|news|blog|shop|store|tickets?|program(?:me)?|schedule|team|about|contact|privacy|cookies?|login|sign[- ]?in|account|donate|sponsor\w*|partners?)\b|\.(?:pdf|jpe?g|png|zip|docx?)(?:[?#]|$)/iu;
// Submission platforms we may read (FilmFreeway blocks automation).
const PLATFORMS = ["festhome.com", "shortfilmdepot.com", "filmfestplatform.com", "submittable.com", "clickforfestivals.com", "movibeta.com", "filmchief.com"];

function baseDomain(host) {
  const labels = String(host ?? "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const keep = labels.at(-1).length === 2 && labels.at(-2).length <= 3 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The call's own subpages most likely to state its dates: same site (or an
 * allowed submission platform), labelled like a submit/rules/dates page.
 */
export function huntLinks(linkRecords, { pageUrl, limit = 3 } = {}) {
  const site = baseDomain(hostOf(pageUrl));
  const seen = new Set([String(pageUrl ?? "").replace(/[#?].*$/, "").replace(/\/$/, "")]);
  return (linkRecords ?? [])
    .map((record) => {
      const host = hostOf(record.url);
      if (!host || BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return null;
      const sameSite = baseDomain(host) === site;
      const platform = PLATFORMS.some((item) => host === item || host.endsWith(`.${item}`));
      if (!sameSite && !platform) return null;
      let path = "";
      try {
        path = decodeURIComponent(new URL(record.url).pathname);
      } catch {
        path = String(record.url);
      }
      const label = `${path.replace(/[-_/]+/g, " ")} ${record.text ?? ""}`;
      if (!HUNT_LINK.test(label) || HUNT_NEGATIVE.test(label)) return null;
      const key = String(record.url).replace(/[#?].*$/, "").replace(/\/$/, "");
      if (seen.has(key)) return null;
      seen.add(key);
      const score = (label.match(new RegExp(HUNT_LINK.source, "giu")) ?? []).length
        + (/\b(?:deadlines?|dates|rules|regulations?|submit\w*|reglamento|bando|regolamento)\b/iu.test(label) ? 2 : 0)
        + (platform ? 1 : 0);
      return { url: record.url, text: record.text ?? "", score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.url.length - right.url.length)
    .slice(0, limit);
}

const MONTH_PATTERN = [...MONTH_NUMBERS.keys()].sort((a, b) => b.length - a.length).join("|");
// Words that put a following date in charge of submissions.
// Bare "by"/"before"/"ends" are not enough ("should be realized by April 2",
// "promo ends Oct 15"): the words must name a submission deadline.
const CLOSING_CONTEXT = /(?:deadline|due\s+date|close[sd]?|closing|until|till|submission\s+(?:window|period)|(?:submit|apply|entries|applications?|submissions?)\s+(?:by|before|through|until|close)|received\s+by|scadenza|entro\s+il|fino\s+al|hasta\s+el|plazo|cierre|date\s+limite|jusqu'au|bis\s+zum|einsendeschluss|bewerbungsschluss)\b[^.\n]{0,40}$/iu;
const YEARLESS = new RegExp(
  `\\b(?:(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th|er|º|°)?\\s+(?:of\\s+|de\\s+|del\\s+)?(${MONTH_PATTERN})\\.?)\\b(?!,?\\s*\\d{4})(?![/.-]\\d)`,
  "giu",
);
const RANGE_END = new RegExp(
  `^\\s*[-–—]\\s*(?:(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(?:of\\s+|de\\s+)?(${MONTH_PATTERN}))?)\\b`,
  "iu",
);

function monthDay(match, offset = 0) {
  const monthName = (match[1 + offset] ?? match[4 + offset] ?? "").toLowerCase().replace(/\.$/, "");
  const month = MONTH_NUMBERS.get(monthName);
  const day = Number(match[2 + offset] ?? match[3 + offset]);
  return month && day >= 1 && day <= 31 ? { month, day } : null;
}

/**
 * A closing date printed without a year ("You have until October 20th",
 * "Submissions: Mar 25 – April 8", "Deadline: December 10"). The year is the
 * next occurrence, accepted only when the page itself names that year, the
 * date is at most ~7 months ahead and the page does not say the call is
 * closed. Returned as an estimated deadline: day and month are quoted, the
 * year is inferred.
 */
export function inferYearlessDeadline(text, { now = Date.now(), maxDaysAhead = 210, accept = () => true } = {}) {
  const body = typeof text === "string" ? text.slice(0, 200_000) : "";
  if (!body || scoreCallSignal(body, { now }).closed) return null;
  const found = [];
  for (const match of body.matchAll(YEARLESS)) {
    const before = body.slice(Math.max(0, match.index - 60), match.index);
    if (!CLOSING_CONTEXT.test(before)) continue;
    let date = monthDay(match);
    let end = match.index + match[0].length;
    // "Mar 25 – April 8": the window closes on the second date.
    const range = RANGE_END.exec(body.slice(end, end + 30));
    if (range && date) {
      const second = monthDay(range);
      const day = Number(range[2] ?? range[3]);
      date = second ?? (day >= 1 && day <= 31 ? { month: date.month, day } : date);
      end += range[0].length;
    }
    if (!date) continue;
    const today = new Date(now);
    let year = today.getUTCFullYear();
    let candidate = Date.UTC(year, date.month - 1, date.day, 23, 59, 59);
    if (candidate < now - DAY) {
      year += 1;
      candidate = Date.UTC(year, date.month - 1, date.day, 23, 59, 59);
    }
    const check = new Date(candidate);
    if (check.getUTCMonth() !== date.month - 1) continue; // 31 February and similar
    if ((candidate - now) / DAY > maxDaysAhead) continue;
    if (!new RegExp(`\\b${year}\\b`).test(body)) continue;
    const evidence = body.slice(Math.max(0, match.index - 40), end).replace(/\s+/g, " ").trim().slice(0, 180);
    if (!accept(evidence)) continue;
    found.push({
      deadline: check.toISOString().slice(0, 10),
      deadline_status: "estimated",
      evidence,
      method: "year-inferred",
    });
  }
  // Early-bird, regular and final dates: the call closes on the last one.
  return found.sort((left, right) => right.deadline.localeCompare(left.deadline))[0] ?? null;
}

/** schema.org Offer.validThrough (the registration window) in JSON-LD. */
export function jsonLdDeadline(html, { now = Date.now() } = {}) {
  const blocks = String(html ?? "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu);
  for (const [, body] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const stack = [parsed];
    while (stack.length) {
      const item = stack.pop();
      if (Array.isArray(item)) {
        stack.push(...item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item["@graph"])) stack.push(...item["@graph"]);
      if (item.offers) stack.push(item.offers);
      const validThrough = typeof item.validThrough === "string" ? item.validThrough : null;
      const time = validThrough ? Date.parse(validThrough) : NaN;
      if (Number.isFinite(time) && time >= now - DAY && /^\d{4}-\d{2}-\d{2}/.test(validThrough)) {
        return {
          deadline: validThrough.slice(0, 10),
          deadline_status: "confirmed",
          evidence: `schema.org validThrough: ${validThrough.slice(0, 25)}`,
          method: "json-ld",
        };
      }
    }
  }
  return null;
}

/**
 * Best deadline a page states for this record: the dated extractor first
 * (confirmed), then structured data, then a year-less closing date
 * (estimated). Past dates are ignored.
 */
export function huntDeadline(page, { title = null, now = Date.now(), accept = () => true } = {}) {
  const text = page?.text ?? "";
  const dated = extractDeadline(text, { now, title });
  if (dated && Date.parse(`${dated.deadline}T23:59:59Z`) >= now - DAY && accept(dated.evidence)) {
    return { deadline: dated.deadline, deadline_status: "confirmed", evidence: dated.evidence, method: "dated" };
  }
  return jsonLdDeadline(page?.html, { now }) ?? inferYearlessDeadline(text, { now, accept });
}

const NAME_STOP = new Set(["film", "films", "festival", "international", "competition", "contest", "challenge", "award", "awards", "call", "open", "the", "and", "for", "short", "shorts", "edition", "annual", "prize", "grant", "fund", "program", "programme"]);

/**
 * On a page that lists several calls, a date belongs to this record only when
 * one of its distinctive name words is printed close to the date.
 */
export function evidenceNearTitle(text, evidence, title, { window = 300, exclude = [], siblings = [] } = {}) {
  const fold = (value) => String(value ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  const body = fold(text);
  const index = body.indexOf(fold(evidence).slice(0, 60));
  if (index < 0) return false;
  // Words of the organizer or site name appear next to every call on the
  // site: only the words that distinguish a call count.
  const common = fold(exclude.join(" "));
  const distinctive = (value) => fold(value).split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !NAME_STOP.has(word) && !/^\d+$/.test(word) && !common.includes(word));
  const mine = distinctive(title);
  // A title that is only the organizer's name is the site's flagship call.
  if (!mine.length) return true;
  const start = Math.max(0, index - window);
  const end = index + String(evidence).length + window;
  // Distance from the date to the closest occurrence of a word; names usually
  // precede their dates, so words after the date count double.
  const distance = (words) => {
    let best = Infinity;
    for (const word of words) {
      for (let at = body.indexOf(word, start); at >= 0 && at < end; at = body.indexOf(word, at + 1)) {
        best = Math.min(best, at <= index ? index - at : (at - index) * 2);
      }
    }
    return best;
  };
  const own = distance(mine);
  if (!Number.isFinite(own)) return false;
  // On a listing page the date belongs to the call named closest to it.
  const mineSet = new Set(mine);
  return siblings
    .map((other) => distinctive(other).filter((word) => !mineSet.has(word)))
    .filter((words) => words.length)
    .every((words) => distance(words) >= own);
}

const APPLY_PATH =/\b(?:submit\w*|apply|application|entry|entries|enter|register|registration|inscri\w*|iscrizion\w*|einreich\w*|candidature)\b/iu;

/** A fetched subpage that is itself the way to apply (for application_url). */
export function isApplyPage(url) {
  try {
    return APPLY_PATH.test(decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " "));
  } catch {
    return false;
  }
}
