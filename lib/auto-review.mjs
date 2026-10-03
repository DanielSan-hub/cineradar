// Automatic review of pending opportunities (owner decision 2026-09-29):
// the pipeline approves, rejects or archives records it can settle from
// evidence, and escalates to a human only when it cannot evaluate. Pure: the
// caller supplies a fresh check of the official page.

import { publicationBlockers } from "./review-workflow.mjs";

export const AUTO_REVIEW_VERSION = "auto-review-v5";
const DAY = 86_400_000;

// Pages that list or describe many calls, or a finished edition, are sources
// to monitor, not opportunities to publish.
const LISTING_TITLE = /^(?:festival\s+(?:list|directory)|funding\s+(?:overview|deadlines)|get\s+funding(?:\s+and\s+support)?|festival\s+submissions?\s*(?:&|and)\s*deadlines(?:\s+20\d{2})?|open\s+calls\s*[|:–-].*|opportunities|all\s+opportunities|awesome\b.*|.*\bdata\s+api\b.*|.*\bdirectory\b.*|.*\boverview\b.*)$/iu;
const RETROSPECTIVE_TITLE = /\b(?:these\s+are|programme|program\s+schedule|line-?up|winners?|award-winning|highlights|recap|in\s+competition|(?:semi[- ]?|quarter[- ]?)?finalists?|official\s+selection|selected\s+(?:films|projects)|shortlist(?:ed)?|laureates?)\b/iu;
// Performing-arts calls ("Short+Sweet Theatre") are not film calls even when
// a word such as "short" looks like one; film words in the title override.
const PERFORMING_TITLE = /\b(?:theatre|theater|dance|choreograph\w*|opera|musical|cabaret|circus|teatro|danza|th[ée][âa]tre|tanz)\b/iu;
const FILM_CORE_TITLE = /\b(?:films?|filmmak\w*|cinema\w*|movies?|videos?|animat\w*|documentar\w*|screen\w*|cine|kino|tvc)\b/iu;
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
// Calls open to every discipline include filmmakers.
export const ALL_DISCIPLINES = /\b(?:all|any|every)\s+(?:artistic\s+)?(?:disciplines?|media|mediums|art\s+forms?|fields)\b|\b(?:inter|multi|trans|cross)[- ]?disciplinary\b|\bartists?\s+(?:of|from|working\s+in)\s+(?:all|any)\s+(?:disciplines?|media|fields)\b|\btutte\s+le\s+discipline\b|\btodas\s+las\s+disciplinas\b|\btoutes\s+(?:les\s+)?disciplines\b|\balle\s+(?:künstlerischen\s+)?(?:disziplinen|sparten)\b/iu;
// Official-page checks: the film words, and other disciplines without them.
// A whole page mentions "video" or "screen" for unrelated reasons (embedded
// clips, screen readers): page-level film context uses unambiguous words.
const PAGE_FILM = /\b(?:films?|filmmak\w*|cinema\w*|moving[- ]images?|audiovisual|documentar(?:y|ies)|animation|animated|video[- ]?art\w*|media[- ]arts?|screenwrit\w*|short\s+films?|cortometr\w*|largometr\w*|court[- ]m[ée]trage\w*|kurzfilm\w*|documentaire|documental)\b|映像|映画|영화|영상|电影|影像/iu;

export function pageDisciplineContext(text) {
  const body = typeof text === "string" ? text.slice(0, 200_000) : "";
  const filmContext = PAGE_FILM.test(body);
  const allDisciplines = ALL_DISCIPLINES.test(body);
  return { filmContext, allDisciplines, otherDisciplineOnly: !filmContext && !allDisciplines && OTHER_DISCIPLINE.test(body) };
}
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
const CATEGORY_ONLY_TITLE = /^(?:(?:international|national|genre|short|feature|student|youth|documentary|animation|animated|music\s+video|experimental|main|official|european|local|regional|online|screenplay|screenwriting|script|pitch(?:ing)?|vertical|ai|short\s+film|poster|trailer)\s+)*(?:competition|contest|category|section|programme|program|prize|award|selection)s?$/iu;
// Website section headings picked up as names ("The festival in numbers",
// "Facts and figures", "About us"): the call takes its organizer's name.
const SECTION_HEADING = /^(?:the\s+)?(?:(?:festival|event|edition|year)\s+)?(?:in\s+(?:numbers|figures|brief)|at\s+a\s+glance|facts\s+(?:and|&)\s+figures|key\s+(?:facts|figures|numbers)|statistics|highlights|about(?:\s+us)?|our\s+(?:history|story|team|mission)|history|team|partners|sponsors|press(?:\s+room)?|newsletter|contacts?|faqs?|news)$/iu;

const NAMED_ENTITIES = { mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»", middot: "·", bull: "•", eacute: "é", egrave: "è", agrave: "à", ntilde: "ñ", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä", oacute: "ó", iacute: "í", aacute: "á", deg: "°" };

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&([a-z]+);/gi, (entity, name) => NAMED_ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

// Website chrome around a name: "Home - Glasgow Short Film Festival",
// "Welcome to X", "X – Deadline Today (Top 100 …)".
const SITE_CHROME_PREFIX = /^(?:home|homepage|accueil|inicio|startseite)\s*[-–—|:»]\s*|^welcome\s+to\s+(?:the\s+)?/iu;
const SITE_CHROME_SUFFIX = /\s*[-–—|:»]\s*(?:home|homepage|accueil|inicio|startseite)$|\s*[-–—|:]\s*(?:(?:final|last|early|late)\s+)?deadline\b.*$/iu;
// Whole-sentence announcements that carry no name: "Call for Entries 2027 is
// now open!", "Inscripciones abiertas para el 41° Festival …" (prefix only).
const ANNOUNCEMENT_TITLE = /^(?:(?:the\s+)?(?:call\s+for\s+(?:entries|submissions|applications|projects)|submissions?|entries|applications?|registrations?)(?:\s+(?:for\s+)?(?:19|20)\d\d)?\s+(?:is|are)\s+(?:now\s+)?open(?:ed)?\s*[!.]*)$/iu;
const ANNOUNCEMENT_PREFIX = /^(?:(?:inscripciones|convocatoria)\s+abiertas?\s+(?:para|del?)\s+(?:el|la|los|las)?\s*|iscrizioni\s+aperte\s+(?:per|al|alla)?\s*(?:il|la)?\s*|inscriptions?\s+ouvertes?\s+(?:pour|au|à\s+la)?\s*(?:le|la)?\s*|(?:submissions?|entries|applications?)\s+(?:are\s+)?(?:now\s+)?open\s+(?:for|to)\s+(?:the\s+)?|call\s+for\s+(?:entries|submissions)\s+)/iu;
// A title that announces the end of a call.
const CLOSED_TITLE = /\b(?:are|is)\s+(?:now\s+)?closed\b|\b(?:submissions?|applications?|entries|registrations?|call)\s+(?:now\s+)?closed\b|\bclosed\s+for\s+(?:submissions?|entries|applications?)\b|\b(?:inscripciones|convocatoria)\s+cerradas?\b|\biscrizioni\s+chiuse\b|\binscriptions?\s+(?:sont\s+)?(?:closes|fermées)\b/iu;
// Calls announced but not open yet: watched, never published.
export const NOT_YET_OPEN = /\b(?:stay\s+tuned|coming\s+(?:soon|up)|will\s+open|opens?\s+(?:on|in|soon)|save\s+the\s+date|pr[oó]ximamente|prossimamente|bient[oô]t)\b/iu;

/** Organizer without HTML entities or a trailing " | site section". */
export function cleanOrganizer(value) {
  return decodeEntities(value).split(" | ")[0].replace(/\s+/g, " ").trim();
}

/** Title without HTML entities, " | site name" suffixes or a trailing " - Organizer". */
export function cleanTitle(value, organizer = "") {
  let title = decodeEntities(value).replace(/\s+/g, " ").trim().replace(SITE_CHROME_PREFIX, "");
  title = title.split(" | ")[0].trim().replace(SITE_CHROME_SUFFIX, "").trim();
  if (ANNOUNCEMENT_TITLE.test(title)) title = "";
  else {
    // "Submissions for the 2027 Episodic Lab are now open" -> "2027 Episodic Lab".
    const wrapped = /^(?:submissions?|entries|applications?|registrations?)\s+(?:for|to)\s+(?:the\s+)?(.+?)\s+(?:is|are)\s+(?:now\s+)?open(?:ed)?\s*[!.]*$/iu.exec(title);
    title = (wrapped ? wrapped[1] : title.replace(ANNOUNCEMENT_PREFIX, "")).trim();
  }
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
const ACTION_PREFIX = /^(?:rules\s+(?:and|&)\s+regulations|regulations?|rules|call\s+for\s+(?:submissions?|entries|applications?|projects)|submissions?|submit(?:\s+your\s+(?:film|work))?|apply(?:\s+now)?|open\s+call|entry\s+form|application\s+form)(?:\s*[-–—:|]\s*|$)|^(?:submit|apply)\s+(?:to|for)\s+|^submit\s+your\s+(?=\S)/iu;
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
  // "Submit your screenplay" -> "Screenplay" names nothing on its own: when a
  // page label was removed, the organizer's name leads unless already there.
  const raw = decodeEntities(value).replace(/\s+/g, " ").trim().split(" | ")[0].trim();
  // Only a removed leading label ("Submit your …", "Submissions for …")
  // leaves a fragment; a removed trailing label leaves the name intact.
  const labelRemoved = title !== raw && !raw.toLowerCase().startsWith(title.toLowerCase());
  const namesOrganizer = distinctiveTokens(org).some((token) => title.toLowerCase().includes(token));
  if (SECTION_HEADING.test(title)) return orgUsable ? { title: org, unresolved: false } : { title, unresolved: true };
  if (!bare && labelRemoved && orgUsable && !namesOrganizer) return { title: `${org} – ${title}`, unresolved: false };
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

/** The open-call statement the series extractor quoted from the organizer's own page. */
export function openStatementOf(row) {
  return row.raw_payload?.extraction?.series_evidence?.open_quote ?? null;
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
 *            callSignal?: boolean, deadlineEvidenceFound?: boolean, openStatementFound?: boolean,
 *            organizer?: string | null } | null,
 * }} context
 */
export function autoReviewDecision(row, { now = Date.now(), duplicateOf = null, page = null, genericTitle = false, published = false } = {}) {
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
  // Residencies, labs and grants often name no medium at all: the official
  // page counts too, and a call open to all disciplines includes filmmakers.
  const filmRelevant = FILM_RELEVANT.test(topic)
    || /AI film festival/i.test(String(row.category ?? ""))
    || FILM_RELEVANT.test(String(row.organizer ?? ""))
    || FILM_HOST.test(registrableHost(row.official_url ?? row.source_url ?? ""))
    || Boolean(page?.filmContext)
    || ALL_DISCIPLINES.test(topic)
    || Boolean(page?.allDisciplines);
  if (!filmRelevant && (OTHER_DISCIPLINE.test(topic) || page?.otherDisciplineOnly)) {
    return { decision: "reject", reasons: ["Out of scope: a call for another discipline with no film or moving-image component stated."] };
  }
  if (PERFORMING_TITLE.test(title) && !FILM_CORE_TITLE.test(title)) {
    return { decision: "reject", reasons: ["Out of scope: a performing-arts call (theatre, dance or music), not a film call."] };
  }
  const years = titleYears(title);
  const currentYear = new Date(now).getUTCFullYear();
  if (RETROSPECTIVE_TITLE.test(title) || (years.length && Math.max(...years) < currentYear)) {
    return { decision: "reject", reasons: ["Programme, results or past-edition page, not an open call."] };
  }

  // A page run by an aggregator (registered as a directory source) lists other
  // people's calls: the call's own site is found through the harvest.
  if (page?.directoryPage) {
    return { decision: "reject", reasons: ["The page belongs to an opportunity directory, not to the call's organizer; the call is tracked through its own site."] };
  }
  if (CLOSED_TITLE.test(title)) {
    return { decision: "reject", reasons: ["The title says the call is closed."] };
  }
  if (NOT_YET_OPEN.test(title)) {
    return { decision: "watch", reasons: ["Announced but not open yet."] };
  }
  const deadline = row.deadline ? Date.parse(String(row.deadline)) : NaN;
  const rolling = row.deadline_status === "rolling";
  // An estimated deadline (a quoted day and month whose year is inferred, or
  // a date the page calls approximate) publishes as "verified" and is shown
  // as "About <date>"; only confirmed dates make a call "open".
  const estimated = row.deadline_status === "estimated";
  // A new approval needs two days of the call left; a published call stays
  // public until its deadline (it leaves the day after, see isExpiredPublication).
  const hasFutureDeadline = Number.isFinite(deadline) && deadline > now + (published ? 0 : 2 * DAY)
    && (row.deadline_status === "confirmed" || estimated);
  // A call its organizer says is open now ("Submissions are open", "Now
  // accepting entries") on its own site, with a submission link and the
  // deadline published only on that platform: public as "verified" without a
  // date, never as a dated open call.
  const openUndated = !Number.isFinite(deadline) && !rolling && !estimated
    && Boolean(openStatementOf(row) && row.application_url);
  if (!hasFutureDeadline && !rolling && !openUndated) {
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
  if (page?.ok && !rolling && !openUndated && !page.deadlineEvidenceFound) reasons.push("The deadline is no longer stated on the official page.");
  if (page?.ok && openUndated && !page.openStatementFound) reasons.push("The official page no longer says submissions are open.");
  if (page?.ok && rolling && page.mentionsCurrentYear === false) reasons.push("A rolling call whose page does not mention the current or next year (possibly a past contest).");
  if (page?.ok && openUndated && page.mentionsCurrentYear === false) reasons.push("An open-call statement on a page that does not mention the current or next year (possibly out of date).");

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
  const targetStatus = estimated || openUndated ? "verified" : !rolling && days <= 14 ? "closing-soon" : "open";
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
      rolling
        ? "rolling deadline"
        : openUndated
          ? "the page says submissions are open; the deadline is published on the submission platform it links to"
          : `deadline ${new Date(deadline).toISOString().slice(0, 10)} confirmed on the page`,
      organizerPatch.organizer ? `organizer "${organizerPatch.organizer}" from the page metadata` : null,
      "no conflicts",
    ].filter(Boolean),
  };
}
