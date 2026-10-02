// Automatic review of pending opportunities (owner decision 2026-09-29):
// the pipeline approves, rejects or archives records it can settle from
// evidence, and escalates to a human only when it cannot evaluate. Pure: the
// caller supplies a fresh check of the official page.

import { publicationBlockers } from "./review-workflow.mjs";

export const AUTO_REVIEW_VERSION = "auto-review-v4";
const DAY = 86_400_000;

// Pages that list or describe many calls, or a finished edition, are sources
// to monitor, not opportunities to publish.
const LISTING_TITLE = /^(?:festival\s+(?:list|directory)|funding\s+(?:overview|deadlines)|get\s+funding(?:\s+and\s+support)?|festival\s+submissions?\s*(?:&|and)\s*deadlines(?:\s+20\d{2})?|open\s+calls\s*[|:–-].*|opportunities|all\s+opportunities|awesome\b.*|.*\bdata\s+api\b.*|.*\bdirectory\b.*|.*\boverview\b.*)$/iu;
const RETROSPECTIVE_TITLE = /\b(?:these\s+are|programme|program\s+schedule|line-?up|winners?|award-winning|highlights|recap|in\s+competition)\b/iu;
// A deadline tier is not the name of an opportunity ("Late Deadline: Jan 10").
const DEADLINE_LABEL_TITLE = /^(?:early\s*-?\s*bird|earlybird|regular|late|final|extended|standard|last)?\s*deadlines?\b/iu;
// Several generic plural nouns describe a list, not one call.
const GENERIC_PLURALS = /\b(?:festivals|events|competitions|contests|awards|grants|residencies|opportunities|calls|deadlines|challenges)\b/giu;
// Things people apply for that are not submitting work as filmmakers.
const NOT_A_FILMMAKER_CALL = /\b(?:accreditations?|jur(?:y|ies)|volunteers?|tickets?|press\s+pass(?:es)?|internships?|jobs?|careers?|vacanc(?:y|ies)|hiring)\b/iu;
// Moving-image relevance: film, video, animation, media art, AI video...
const FILM_RELEVANT = /\b(?:films?|filmmak\w*|cinem\w*|cine|kino|movies?|videos?|moving\s+image|animat\w*|screen\w*|audiovisual|documentar\w*|shorts?|music\s+videos?|media\s+arts?|new\s+media|digital\s+arts?|xr|vr|immersive|cortometr\w*|largometr\w*|court[- ]m[ée]trage|kurzfilm\w*|curta|longa)\b|映像|映画|動画|アニメ|영화|영상|애니메이션|电影|影像|動畫|视频/iu;
// Organizer names or domains that are themselves film institutions.
const FILM_HOST = /film|cine|kino|movie|video|docs$|dox|anim|screen|iff$|filmfest|tfl$|filmlab/iu;
// Other disciplines: out of scope unless film is mentioned too.
const OTHER_DISCIPLINE = /\b(?:illustrat\w*|literature|literary|poetry|painting|sculpture|ceramics|architecture|photograph\w*|comics?|manga)\b|イラスト|文学|絵画|写真/iu;
// An "official page" that is a news list or listing index proves nothing about one call.
const LISTING_URL = /[?&]page=|\/news\/?(?:[?#]|$)|\/(?:opportunities|open-calls|calls|listings?)\/?(?:[?#]|$)/iu;

// Words that name nothing in particular: they cannot tie a page to a call.
const GENERIC_WORDS = new Set([
  "film", "films", "festival", "festivals", "international", "competition", "competitions",
  "contest", "contests", "award", "awards", "call", "calls", "open", "submission", "submissions",
  "short", "shorts", "deadline", "deadlines", "entry", "entries", "the", "for", "and", "grant",
  "grants", "fund", "prize", "program", "programme", "edition", "annual", "new", "world",
  "global", "best", "guide", "every", "apply", "applications", "project", "projects",
]);
// Hosts or organizers that publish about other people's calls.
const PUBLICATION = /mag(?:azine)?\b|magazine|news|blog|journal|press|guide|contests|festivals|opportunit|resource|recursos|directory|listings?|media\b/iu;
// Titles that name only a category of a larger call.
const CATEGORY_ONLY_TITLE = /^(?:(?:international|national|genre|short|feature|student|youth|documentary|animation|animated|music\s+video|experimental|main|official|european|local|regional|online)\s+)*(?:competition|category|section|programme|program|prize|award|selection)s?$/iu;

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** Organizer without HTML entities or a trailing " | site section". */
export function cleanOrganizer(value) {
  return decodeEntities(value).split(" | ")[0].replace(/\s+/g, " ").trim();
}

/** Title without HTML entities, " | site name" suffixes or a trailing " - Organizer". */
export function cleanTitle(value, organizer = "") {
  let title = decodeEntities(value).split(" | ")[0].replace(/\s+/g, " ").trim();
  const org = cleanOrganizer(organizer);
  if (org && org.length > 2) {
    const escaped = org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = title.replace(new RegExp(`\\s+[-–—]\\s+${escaped}$`, "iu"), "").trim();
    if (stripped.length >= 6) title = stripped;
  }
  return title;
}

// Page labels that are not names: "Regulations – X", "Call for Submission - X",
// "Submit", "X Submission". A prefix needs a separator (or to be the whole
// title) so that names such as "Rules of the Game Fest" survive.
const ACTION_PREFIX = /^(?:rules\s+(?:and|&)\s+regulations|regulations?|rules|call\s+for\s+(?:submissions?|entries|applications?|projects)|submissions?|submit(?:\s+your\s+(?:film|work))?|apply(?:\s+now)?|open\s+call|entry\s+form|application\s+form)(?:\s*[-–—:|]\s*|$)/iu;
const ACTION_SUFFIX = /(?:\s*[-–—:|]\s*|\s+)(?:submissions?(?:\s+form)?|call\s+for\s+(?:entries|submissions)|entry\s+form|regulations|rules)$/iu;
// Logo text scraped as letter-spaced capitals: "… G O L D E N D U N E S".
const LETTER_SPACED = /(?:\s+\p{Lu}){4,}$/u;

/**
 * The public name of a record: cleaned, without page labels, and never a bare
 * category or action word ("Submit" becomes the organizer's name, "Main
 * Competition" becomes "goEast Filmfestival – Main Competition").
 * `unresolved` means no usable organizer could name a bare title.
 */
export function publicTitleFor(value, organizerName = "") {
  const cleaned = cleanTitle(value, organizerName).replace(LETTER_SPACED, "").trim();
  const title = cleaned.replace(ACTION_PREFIX, "").replace(ACTION_SUFFIX, "").trim();
  const org = cleanOrganizer(organizerName);
  const orgUsable = org.length > 2 && !/^[\w-]+\.[a-z.]{2,}$/i.test(org) && !/^unknown/i.test(org);
  const bare = !title
    || CATEGORY_ONLY_TITLE.test(title.replace(/\s+(?:19|20)\d\d$/u, ""))
    || !distinctiveTokens(title).length;
  if (!bare) return { title, unresolved: false };
  if (!orgUsable) return { title: title || cleaned, unresolved: true };
  return { title: title ? `${org} – ${title}` : org, unresolved: false };
}

// An AI film event named as such: "AI Cinema Festival", "AI Movie Awards".
const AI_FILM_NAME = /\b(?:AI|A\.I\.|IA|KI)\b[^|]{0,30}?\b(?:film|films|filmfest|cinema|movies?|video|shorts?)\b|\b(?:AI|IA)[- ]?(?:film|cinema|movie)|\bgenerative\s+(?:film|cinema|video)/iu;
const EVENT_NAME = /festival|filmfest|\bfest\b|awards?|contest|competition|challenge|prize|cinema/iu;

/** Category correction a record's own name supports, or null. */
export function categoryFromName(row) {
  const name = `${row.title ?? ""} ${row.organizer ?? ""}`;
  if (!["Traditional festival", "Grant"].includes(row.category)) return null;
  return AI_FILM_NAME.test(name) && EVENT_NAME.test(name) ? "AI film festival" : null;
}

/** Name and category fixes for a published record (empty when nothing changes). */
export function publicNameChanges(row) {
  const organizer = cleanOrganizer(row.organizer);
  const { title, unresolved } = publicTitleFor(row.title, organizer);
  const changes = {};
  if (!unresolved && title && title !== row.title) changes.title = title;
  const category = categoryFromName({ ...row, title: changes.title ?? row.title });
  if (category) changes.category = category;
  return changes;
}

/** A published call whose recorded deadline passed more than a day ago. */
export function isExpiredPublication(row, { now = Date.now() } = {}) {
  if (row.deadline_status === "rolling" || !row.deadline) return false;
  const deadline = Date.parse(row.deadline);
  return Number.isFinite(deadline) && deadline < now - DAY;
}

function distinctiveTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !GENERIC_WORDS.has(token));
}

function registrableHost(url) {
  try {
    const parts = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "").split(".");
    return parts.slice(0, Math.max(1, parts.length - 1)).join("").replace(/[^a-z0-9]/g, "");
  } catch {
    return "";
  }
}

/**
 * Does the official page's domain belong to this opportunity? True when the
 * domain carries a distinctive word of the title, or of an organizer that is
 * not a publication/aggregator writing about someone else's call.
 */
export function pageBelongsToCall({ url, title, organizer }) {
  const host = registrableHost(url);
  if (!host) return false;
  const hostHas = (tokens) => tokens.some((token) => host.includes(token));
  if (hostHas(distinctiveTokens(title))) return true;
  const org = cleanOrganizer(organizer);
  return hostHas(distinctiveTokens(org)) && !PUBLICATION.test(`${org} ${host}`);
}

function titleYears(title) {
  return [...String(title ?? "").matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
}

/**
 * @param {Record<string, any>} row pending opportunity
 * @param {{
 *   now?: number,
 *   duplicateOf?: { id: string, title: string } | null,
 *   page?: { ok: boolean, httpStatus?: number, finalUrl?: string, closed?: boolean,
 *            callSignal?: boolean, deadlineEvidenceFound?: boolean, organizer?: string | null } | null,
 * }} context
 */
export function autoReviewDecision(row, { now = Date.now(), duplicateOf = null, page = null, genericTitle = false } = {}) {
  const reasons = [];
  const title = String(row.title ?? "").trim();

  if (genericTitle) {
    return { decision: "reject", reasons: ["The title is a section heading or deadline tier, not the name of an opportunity; the named call is tracked separately."] };
  }

  if (duplicateOf) {
    return { decision: "archive", reasons: [`Duplicate of "${duplicateOf.title}" (${duplicateOf.id.slice(0, 8)}).`] };
  }
  if (LISTING_TITLE.test(title) || (title.match(GENERIC_PLURALS) ?? []).length >= 2) {
    return { decision: "reject", reasons: ["Listing or overview page, not a single call; its calls are found through the source registry."] };
  }
  if (DEADLINE_LABEL_TITLE.test(title)) {
    return { decision: "reject", reasons: ["The title is a deadline label, not the name of an opportunity; the call itself is tracked under its own record."] };
  }
  if (NOT_A_FILMMAKER_CALL.test(title)) {
    return { decision: "reject", reasons: ["Not an opportunity to submit work (accreditation, jury, job or similar)."] };
  }
  const topic = `${title} ${row.summary ?? ""} ${row.category ?? ""}`;
  // Film organizations often name calls without the word "film" (CPH:DOX,
  // Hot Docs, Red Sea Fund): their name or domain counts as the film context.
  const filmRelevant = FILM_RELEVANT.test(topic)
    || /AI film festival/i.test(String(row.category ?? ""))
    || FILM_RELEVANT.test(String(row.organizer ?? ""))
    || FILM_HOST.test(registrableHost(row.official_url ?? row.source_url ?? ""));
  if (!filmRelevant && OTHER_DISCIPLINE.test(topic)) {
    return { decision: "reject", reasons: ["Out of scope: a call for another discipline with no film or moving-image component stated."] };
  }
  const years = titleYears(title);
  const currentYear = new Date(now).getUTCFullYear();
  if (RETROSPECTIVE_TITLE.test(title) || (years.length && Math.max(...years) < currentYear)) {
    return { decision: "reject", reasons: ["Programme, results or past-edition page, not an open call."] };
  }

  const deadline = row.deadline ? Date.parse(String(row.deadline)) : NaN;
  const rolling = row.deadline_status === "rolling";
  const hasFutureDeadline = Number.isFinite(deadline) && deadline > now + 2 * DAY && row.deadline_status === "confirmed";
  if (!hasFutureDeadline && !rolling) {
    // Nothing to decide yet: re-evaluated automatically as sources change.
    return { decision: "watch", reasons: [Number.isFinite(deadline) ? "Deadline too close or unconfirmed." : "No confirmed deadline published yet."] };
  }

  // From here the record looks like a live call: approve only on fresh proof.
  if (!filmRelevant) reasons.push("No film or moving-image element stated in the title or summary.");
  if (LISTING_URL.test(String(row.official_url ?? page?.finalUrl ?? ""))) {
    reasons.push("The official page is a news list or listing, not the call's own page.");
  }
  if (row.has_conflict) reasons.push("Sources conflict on status or deadline.");
  if (/false-positive candidate/i.test(String(row.review_reason ?? ""))) reasons.push("Flagged as a possible generic page.");
  // Confidence is a completeness heuristic; the fresh page checks below are the
  // real proof, so only very weak extractions are escalated.
  if (Number(row.confidence ?? 0) < 0.5) reasons.push(`Low extraction confidence (${Number(row.confidence ?? 0).toFixed(2)}).`);
  if (!page?.ok) reasons.push(`Official page not reachable now${page?.httpStatus ? ` (HTTP ${page.httpStatus})` : ""}.`);
  if (page?.ok && page.closed) reasons.push("The official page now says the call is closed.");
  if (page?.ok && !page.callSignal) reasons.push("The official page no longer shows an open call.");
  if (page?.ok && !rolling && !page.deadlineEvidenceFound) reasons.push("The deadline is no longer stated on the official page.");

  const organizer = String(row.organizer ?? "").trim();
  const organizerKnown = organizer && !/^unknown(?:\s+organizer)?$/i.test(organizer);
  const organizerPatch = !organizerKnown && page?.organizer ? { organizer: cleanOrganizer(page.organizer) } : {};
  if (!organizerKnown && !page?.organizer) reasons.push("Organizer not stated on the page.");

  // Names shown publicly: decoded, without site suffixes, and never a bare
  // category ("International Competition" becomes "Tampere Film Festival –
  // International Competition", using the organizer stated on the page).
  const organizerName = cleanOrganizer(organizerPatch.organizer ?? organizer);
  if (organizerKnown && organizerName !== organizer) organizerPatch.organizer = organizerName;
  const named = publicTitleFor(title, organizerName);
  if (named.unresolved) reasons.push("The title names only a category, not the opportunity.");
  const publicTitle = named.title;
  const titlePatch = publicTitle !== title ? { title: publicTitle } : {};
  const category = categoryFromName({ ...row, title: publicTitle, organizer: organizerName });
  if (category) titlePatch.category = category;
  const officialUrl = row.official_url ?? page?.finalUrl ?? null;
  if (!pageBelongsToCall({ url: officialUrl, title: publicTitle, organizer: organizerName })) {
    reasons.push("The page's domain does not belong to this opportunity's organizer (an article, aggregator or listing).");
  }

  const days = Number.isFinite(deadline) ? (deadline - now) / DAY : Infinity;
  const targetStatus = !rolling && days <= 14 ? "closing-soon" : "open";
  const candidate = {
    ...row,
    ...organizerPatch,
    status: targetStatus,
    official_url_status: page?.ok ? "verified" : row.official_url_status,
    official_url: row.official_url ?? page?.finalUrl ?? null,
  };
  const blockers = publicationBlockers(candidate, { now });
  for (const blocker of blockers) {
    if (blocker !== "missing-organizer") reasons.push(`Publication gate: ${blocker}.`);
  }

  if (reasons.length) return { decision: "human", reasons };
  return {
    decision: "approve",
    targetStatus,
    changes: { ...organizerPatch, ...titlePatch },
    reasons: [
      `Official page reachable (HTTP ${page.httpStatus ?? 200}) and shows an open call`,
      rolling ? "rolling deadline" : `deadline ${new Date(deadline).toISOString().slice(0, 10)} confirmed on the page`,
      organizerPatch.organizer ? `organizer "${organizerPatch.organizer}" from the page metadata` : null,
      "no conflicts",
    ].filter(Boolean),
  };
}
