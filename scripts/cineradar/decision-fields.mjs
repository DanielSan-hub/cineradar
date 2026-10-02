// Deterministic, source-grounded extraction of the facts a team needs to
// decide on an opportunity: deadline, runtime, fee, AI policy, premiere rule,
// eligibility. Every value comes with the verbatim page snippet it was read
// from; anything not stated stays unknown. Pure: no I/O.

import { MONTH_NUMBERS } from "./call-signal.mjs";

export const DECISION_FIELDS_VERSION = "decision-fields-v1";

/** The sentence (at most ~60 characters either side) containing a match. */
function snippet(text, index, length) {
  const head = text.slice(Math.max(0, index - 60), index);
  const boundary = Math.max(head.lastIndexOf("\n"), head.search(/[.!?;][^.!?;]*$/u));
  const start = index - head.length + (boundary >= 0 ? boundary + 1 : 0);
  const tail = text.slice(index + length, index + length + 60);
  const stop = tail.search(/[\n.!?;]/u);
  const end = index + length + (stop >= 0 ? stop + 1 : tail.length);
  return text.slice(start, end).trim().slice(0, 240);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

// Embedded JSON/script text (including escaped HTML) is not a statement on the page.
const CODE_LIKE = /\\"|"\s*:\s*[[{"]|[{}[\]]{2,}|\\x3c|\\u003c|<\/?[a-z][a-z0-9]*>/iu;
// A line that names a specific call, edition or programme.
const CALL_NAME = /\b20\d{2}\b|\b(?:lab|festival|grant|award|prize|fund|residenc\w*|competition|fellowship|programme|program)\b/iu;
// A rule for one category of a multi-category call is not the call's rule.
const CATEGORY_SCOPED = /\b(?:this|that|each|the\s+\w+)\s+categor(?:y|ies)\b|\bexclusive\s+category\b|\bmusic\s+videos?\s+(?:have|has|pay|are)\b/iu;
const FILM_CONTEXT = /\b(?:films?|shorts?|works?|entr(?:y|ies)|submissions?|runtime|run\s+time|running\s+time|length|duration|videos?|pieces?|projects?|cortometragg\w*|cortometraj\w*|court[- ]m[ée]trage|kurzfilm\w*|durata|duraci\w*|dur[ée]e)\b|作品|영상|단편/iu;

// ---------------------------------------------------------------- runtime
const MINUTES = "(?:minutes?|mins?\\.?|minuti|minutos|minuten|minutes?|분|分)";
const RUNTIME_PATTERNS = [
  // "maximum length of 15 minutes", "max. runtime: 20 min", "durata massima 15 minuti"
  new RegExp(`(?:max(?:imum)?\\.?|maximal[e]?|massima|m[aá]xima|maximale|maximum)\\s+(?:film\\s+)?(?:length|duration|running\\s*time|runtime|durata|duraci[oó]n|dur[ée]e|l[äa]nge|laufzeit)(?:\\s+(?:is|of|de|di|von))?\\s*[:\\-–]?\\s*(\\d{1,3})\\s*${MINUTES}`, "iu"),
  new RegExp(`(?:length|duration|running\\s*time|runtime|durata|duraci[oó]n|dur[ée]e|l[äa]nge)\\s*[:\\-–]?\\s*(?:max(?:imum)?\\.?|up\\s+to|no\\s+(?:longer|more)\\s+than|under|less\\s+than|massim[ao]|m[aá]xim[ao]|jusqu'?[àa])\\s*[:\\-–]?\\s*(\\d{1,3})\\s*${MINUTES}`, "iu"),
  // "must not exceed 10 minutes", "up to 12 minutes", "no longer than 30 minutes"
  new RegExp(`(?:not\\s+(?:to\\s+)?exceed|up\\s+to|no\\s+longer\\s+than|shorter\\s+than|less\\s+than|under|non\\s+superiore\\s+a|no\\s+m[aá]s\\s+de|hasta|ne\\s+d[ée]passant\\s+pas|bis\\s+zu)\\s+(\\d{1,3})\\s*${MINUTES}`, "iu"),
  // "15 minutes maximum", "20 min max", "10 minutes or less"
  new RegExp(`(\\d{1,3})\\s*${MINUTES}\\s*(?:max(?:imum)?\\b|or\\s+(?:less|shorter|under)|in\\s+length\\s+or\\s+less)`, "iu"),
  // "between 3 and 15 minutes", "3–15 min"
  new RegExp(`(?:between\\s+)?(\\d{1,3})\\s*(?:and|to|-|–|—|e|y|et|und)\\s*(\\d{1,3})\\s*${MINUTES}`, "iu"),
  // "최대 15분", "15分以内"
  /최대\s*(\d{1,3})\s*분|(\d{1,3})\s*分以内/u,
];

export function extractRuntime(text) {
  for (const [index, pattern] of RUNTIME_PATTERNS.entries()) {
    const match = firstMatch(text, [pattern]);
    if (!match) continue;
    const numbers = match.slice(1).filter(Boolean).map(Number);
    if (!numbers.length) continue;
    // Range pattern: the upper bound is the maximum; require a sane range.
    const isRange = index === 4;
    if (isRange && !(numbers.length === 2 && numbers[0] < numbers[1])) continue;
    const max = isRange ? numbers[1] : numbers[0];
    if (!(max > 0 && max <= 600)) continue;
    // Generic phrasings ("up to 5 minutes", "3-15 minutes") need film context
    // in the same sentence (not "a 10-15 minutes walk", "episodes up to 5").
    const quote = snippet(text, match.index, match[0].length);
    if (CODE_LIKE.test(quote)) continue;
    if (index >= 2 && index <= 4 && !FILM_CONTEXT.test(quote)) continue;
    return { max_runtime_minutes: max, min_runtime_minutes: isRange ? numbers[0] : null, evidence: quote };
  }
  return null;
}

// ---------------------------------------------------------------------- fee
const CURRENCY_SYMBOLS = { "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY", "₩": "KRW" };
const FREE_PATTERNS = [
  /\b(?:free\s+(?:to\s+enter|entry|submissions?|of\s+charge\s+to\s+(?:enter|submit|apply))|no\s+(?:entry|submission|application)\s+fees?|(?:entry|submission|application)\s+(?:is|are)\s+free|free\s+of\s+charge|gratuit[ae]?\s+(?:la\s+)?(?:partecipazione|inscripci[oó]n|participation)|inscripci[oó]n\s+gratuita|iscrizione\s+gratuita|inscri[çc][ãa]o\s+gratuita|participation\s+gratuite|kostenlos|geb[üu]hrenfrei)\b/iu,
];
const FEE_PATTERN = /(?:entry|submission|application|registration|early|regular|late|standard)?\s*(?:fees?|quota\s+(?:di\s+)?iscrizione|tasa\s+de\s+inscripci[oó]n|frais\s+d'inscription|teilnahmegeb[üu]hr|einreichgeb[üu]hr)\s*[:\-–]?\s*(?:(?:is|of|:|de|di)\s*)?(?:(€|\$|£|¥|₩|EUR|USD|GBP|CAD|AUD)\s?(\d{1,4}(?:[.,]\d{1,2})?)|(\d{1,4}(?:[.,]\d{1,2})?)\s?(€|\$|£|EUR|USD|GBP|CAD|AUD|euros?|dollars?))/iu;

const PARTIAL_WAIVER = /\b(?:free|waived|no\s+fee|gratuit[ae]?|gratis)\s+(?:for|per|para|pour|f[üu]r)\s+/iu;

export function extractFee(text) {
  const free = firstMatch(text, FREE_PATTERNS);
  const paid = FEE_PATTERN.exec(text);
  // A page that states both, or waives the fee for some applicants only, is
  // ambiguous (e.g. "€10, free for students").
  if (paid && (free || PARTIAL_WAIVER.test(text))) return null;
  if (free) return { entry_fee_amount: 0, entry_fee_currency: null, evidence: snippet(text, free.index, free[0].length) };
  if (!paid) return null;
  // Tiered or per-category fees (early/late, shorts/features) have no single
  // answer: several distinct amounts near fee wording stay unknown.
  const amounts = new Set();
  for (const match of text.matchAll(new RegExp(FEE_PATTERN.source, "giu"))) {
    amounts.add(String(match[2] ?? match[3]).replace(",", "."));
  }
  const nearbyAmounts = text.slice(paid.index, paid.index + 300).match(/(?:€|\$|£)\s?\d{1,4}|\d{1,4}\s?(?:€|EUR|USD|euros?)/giu) ?? [];
  if (amounts.size > 1 || new Set(nearbyAmounts.map((value) => value.replace(/\D/g, ""))).size > 1) return null;
  const paidQuote = snippet(text, paid.index, paid[0].length);
  if (CODE_LIKE.test(paidQuote) || CATEGORY_SCOPED.test(paidQuote)) return null;
  const symbol = paid[1] ?? paid[4];
  const amount = Number(String(paid[2] ?? paid[3]).replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const upper = symbol.toUpperCase();
  const currency = CURRENCY_SYMBOLS[symbol]
    ?? (/^EUROS?$/i.test(symbol) ? "EUR" : /^DOLLARS?$/i.test(symbol) ? "USD" : /^[A-Z]{3}$/.test(upper) ? upper : null);
  return { entry_fee_amount: amount, entry_fee_currency: currency, evidence: snippet(text, paid.index, paid[0].length) };
}

// ---------------------------------------------------------------- AI policy
// Word boundaries matter: "ai" occurs inside retaining, mailed, training...
const AI = "(?:\\bai\\b|\\ba\\.i\\.|\\bartificial\\s+intelligence\\b|\\bgenerative\\b|\\bgen[- ]?ai\\b|\\bai[- ]generated\\b|\\bintelligenza\\s+artificiale\\b|\\binteligencia\\s+artificial\\b|\\bintelligence\\s+artificielle\\b|\\bk[üu]nstliche\\s+intelligenz\\b)";
const AI_POLICY_PATTERNS = [
  // "non-AI assets are not permitted" means AI is required, not restricted.
  ["required", new RegExp(`\\b(?:non[- ]ai|without\\s+ai|traditionally\\s+filmed|live[- ]action)\\b[^.\\n]{0,80}\\b(?:not\\s+(?:be\\s+)?(?:accepted|allowed|permitted|eligible)|prohibited)`, "iu")],
  ["restricted", new RegExp(`(?<!non[- ])(?:${AI})[^.\\n]{0,60}\\b(?:not\\s+(?:be\\s+)?(?:accepted|allowed|permitted|eligible)|prohibited|forbidden|banned|disqualif)`, "iu")],
  ["restricted", new RegExp(`\\b(?:no|not\\s+accept(?:ing)?|do\\s+not\\s+accept|does\\s+not\\s+accept|won'?t\\s+accept|exclud(?:e|es|ing))\\b[^.\\n]{0,40}(?:${AI})`, "iu")],
  ["required", new RegExp(`(?:made|created|produced|generated)\\s+(?:entirely|fully|primarily|mainly|predominantly|exclusively)?\\s*(?:with|using|by)\\s+(?:${AI})|(?:fully|entirely|100%)\\s+(?:ai[- ]generated|generated\\s+(?:with|by)\\s+ai\\b)|must\\s+(?:be\\s+created\\s+with|use|incorporate)\\s+(?:${AI})`, "iu")],
  ["allowed", new RegExp(`(?:${AI})[^.\\n]{0,50}\\b(?:accepted|allowed|permitted|welcome|eligible)\\b|\\b(?:accept|welcome|allow)s?\\b[^.\\n]{0,30}(?:${AI})[- ](?:assisted|generated|made)`, "iu")],
];
// "AI film festival" implies AI work only when it names this opportunity,
// not when a general festival merely has an AI category.
const AI_NAMED_CALL = /\bai[- ](?:film|short|video|cinema)\s+(?:festival|competition|contest|challenge|award)/iu;
const AI_TITLE = /\b(?:ai|a\.i\.|artificial\s+intelligence|generative|gen[- ]?ai)\b/iu;

export function extractAiPolicy(text, { title = null } = {}) {
  for (const [policy, pattern] of AI_POLICY_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, "giu"))) {
      const quote = snippet(text, match.index, match[0].length);
      if (!CODE_LIKE.test(quote)) return { ai_policy: policy, evidence: quote };
    }
  }
  if (title && AI_TITLE.test(title)) {
    const match = AI_NAMED_CALL.exec(text);
    if (match) {
      const quote = snippet(text, match.index, match[0].length);
      if (!CODE_LIKE.test(quote)) return { ai_policy: "required", evidence: quote };
    }
  }
  return null;
}

// ------------------------------------------------------------------ premiere
const PREMIERE_PATTERNS = [
  ["none", /\b(?:no\s+premiere\s+(?:status|requirements?)|premiere\s+status\s+(?:is\s+)?not\s+(?:required|necessary)|(?:regardless\s+of|no\s+restrictions?\s+on)\s+premiere)\b/iu],
  ["world", /\b(?:world|international\s+and\s+world)\s+premi[eè]res?\b|\bprima\s+mondiale\b|\bestreno\s+mundial\b|\bpremi[eè]re\s+mondiale\b|\bweltpremiere\b|\buraufführung\b/iu],
  ["international", /\binternational\s+premi[eè]res?\b|\bprima\s+internazionale\b|\bestreno\s+internacional\b|\bpremi[eè]re\s+internationale\b/iu],
  ["european", /\beuropean\s+premi[eè]res?\b|\bprima\s+europea\b|\bestreno\s+europeo\b|\bpremi[eè]re\s+europ[ée]enne\b/iu],
  ["national", /\b(?:national|country|italian|uk|british|french|spanish|german|us|north\s+american|canadian|australian|nordic|asian|latin\s+american)\s+premi[eè]res?\b|\bprima\s+(?:nazionale|italiana)\b|\bestreno\s+nacional\b|\bpremi[eè]re\s+(?:nationale|fran[çc]aise)\b/iu],
];

const PREMIERE_NEGATION = /\b(?:not|no|doesn'?t|don'?t|without|regardless)\b[^.\n]{0,40}premi[eè]re|premi[eè]re[^.\n]{0,30}\b(?:not\s+(?:required|necessary|needed)|optional)\b/iu;

export function extractPremiere(text) {
  const findings = [];
  for (const [rule, pattern] of PREMIERE_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, "giu"))) {
      const quote = snippet(text, match.index, match[0].length);
      if (CODE_LIKE.test(quote) || CATEGORY_SCOPED.test(quote)) continue;
      // "world premiere screening of ..." in a programme is not a requirement.
      if (rule !== "none" && !/(?:requir|must|only|eligib|accept|premi[eè]re\s+status|obbligatori|obligatori|exig|vorausgesetzt)/iu.test(quote)) continue;
      // "does not require world premiere status" states the absence of a rule.
      findings.push({ premiere_requirement: rule !== "none" && PREMIERE_NEGATION.test(quote) ? "none" : rule, evidence: quote });
    }
  }
  if (!findings.length) return null;
  // Pages with different rules per category (features vs shorts) stay unknown.
  const rules = new Set(findings.map((finding) => finding.premiere_requirement));
  return rules.size === 1 ? findings[0] : null;
}

// --------------------------------------------------------------- eligibility
const ELIGIBILITY_PATTERNS = [
  /\bopen\s+to\s+(?:all\s+)?(?:filmmakers|artists|applicants|creators|directors|students|anyone|everyone|participants)[^.\n]{0,90}/iu,
  /\b(?:open\s+(?:worldwide|internationally|to\s+all\s+countries|to\s+all\s+nationalities)|(?:filmmakers|artists|applicants|entries)\s+from\s+(?:all\s+over\s+the\s+world|any\s+country|all\s+countries|around\s+the\s+world)|no\s+nationality\s+restrictions?)\b/iu,
  /\b(?:must\s+be|applicants?\s+must\s+be)\s+(?:a\s+)?(?:resident|citizen|national|based|living|registered)s?\b[^.\n]{0,80}/iu,
  /\b(?:aged|ages?|age\s+limit|between\s+the\s+ages\s+of|under\s+the\s+age\s+of|over\s+the\s+age\s+of)\s*[:\-–]?\s*\d{2}[^.\n]{0,40}/iu,
  /\b(?:first|second|debut)\s+(?:and\s+second\s+)?(?:feature|film)s?\s+(?:only|directors?)\b[^.\n]{0,60}/iu,
  /\b(?:completed|produced|made)\s+(?:after|since|in\s+or\s+after|between)\s+[^.\n]{0,40}20\d{2}[^.\n]{0,40}/iu,
];

export function extractEligibility(text) {
  const items = [];
  for (const pattern of ELIGIBILITY_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const phrase = match[0].trim().replace(/\s+/g, " ").slice(0, 160);
    if (phrase.length >= 12 && !items.includes(phrase)) items.push(phrase);
  }
  return items.length ? { eligibility: items.slice(0, 4), evidence: items[0] } : null;
}

// ------------------------------------------------------------------ deadline
const CLOSING_WORDS = "(?:final\\s+)?deadline|submission\\s+deadline|entries\\s+close|submissions?\\s+close|applications?\\s+close|closing\\s+date|due\\s+date|apply\\s+by|submit\\s+by|scadenza|termine\\s+(?:ultimo|di\\s+presentazione)|fecha\\s+l[ií]mite|cierre\\s+de\\s+(?:la\\s+)?convocatoria|plazo|prazo(?:\\s+final)?|date\\s+limite|cl[ôo]ture|einsendeschluss|einreichschluss|bewerbungsschluss|anmeldeschluss|締切|締め切り|마감|截止";
const ENGLISH_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_NAMES = [...MONTH_NUMBERS.keys()].sort((a, b) => b.length - a.length).join("|");
const DATE_FORMS = [
  [/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/u, (m) => [+m[1], +m[2], +m[3]]],
  [/(20\d{2})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]?/u, (m) => [+m[1], +m[2], +m[3]]],
  [new RegExp(`(\\d{1,2})(?:st|nd|rd|th|er|º|°)?\\.?\\s+(?:de\\s+)?(${MONTH_NAMES})\\.?,?\\s+(?:de\\s+)?(20\\d{2})`, "iu"), (m) => [+m[3], MONTH_NUMBERS.get(m[2].toLowerCase()), +m[1]]],
  [new RegExp(`(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`, "iu"), (m) => [+m[3], MONTH_NUMBERS.get(m[1].toLowerCase()), +m[2]]],
  // Numeric day/month only when unambiguous (day > 12).
  [/(\d{1,2})[/.](\d{1,2})[/.](20\d{2})/u, (m) => (+m[1] > 12 ? [+m[3], +m[2], +m[1]] : +m[2] > 12 ? [+m[3], +m[1], +m[2]] : null)],
];

function validDate([year, month, day]) {
  if (!month || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 ? date : null;
}

// Between a closing word and its date, these mean the date belongs to
// something else ("Last updated September 26", "notifications 19 October").
const FOREIGN_DATE_LABEL = /\b(?:updated|posted|published|modified|notif\w*|results?|announce\w*|ceremony|screenings?|winners?|festival\s+dates?)\b/iu;
const TITLE_STOP_WORDS = new Set(["film", "films", "festival", "international", "call", "entries", "submissions", "submission", "open", "deadline", "deadlines", "competition", "award", "awards", "grant", "fund", "the", "for", "and", "global", "short", "shorts"]);

function titleTokens(title) {
  return String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4 && !/^\d+$/.test(token) && !TITLE_STOP_WORDS.has(token));
}

function readDate(value) {
  for (const [pattern, reader] of DATE_FORMS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const parts = reader(match);
    const date = parts && validDate(parts);
    if (date) return { date, match };
  }
  return null;
}

// A deadline calendar printed as tiers under one heading ("DEADLINES: Super
// Earlybird: May 31, 2026 Earlybird: July 31, 2026 ... Extended: December 31,
// 2026"): each tier is a closing date of the same call. A tier label alone,
// without the heading, is not enough.
const TIER_HEADING = /\b(?:deadlines|entry\s+deadlines|submission\s+deadlines|key\s+dates|important\s+dates|fechas\s+l[ií]mite|plazos|scadenze|fristen|dates\s+limites)\b\s*:?/giu;
const TIER_LABEL = /\s*[•·*\-–]?\s*((?:super\s+|very\s+|ultra\s+)?(?:early[\s-]?bird|early|regular|standard|official|late|extended|final|last|first|second|third)(?:\s+(?:deadline|call|entry|entries|submissions?))?)\s*[:\-–]\s*/iuy;

function tierListDates(text) {
  const tiers = [];
  for (const heading of text.matchAll(TIER_HEADING)) {
    let position = heading.index + heading[0].length;
    const list = [];
    for (let count = 0; count < 8; count += 1) {
      TIER_LABEL.lastIndex = position;
      const label = TIER_LABEL.exec(text);
      if (!label) break;
      const dateStart = label.index + label[0].length;
      // A short window: the date must follow the label directly.
      const hit = readDate(text.slice(dateStart, dateStart + 26));
      if (!hit || hit.match.index > 0) break;
      const end = dateStart + hit.match[0].length;
      list.push({ date: hit.date, start: label.index, end, evidence: text.slice(label.index, end).replace(/\s+/g, " ").trim() });
      position = end;
    }
    // The tiers of one list share its position (heading to last tier).
    for (const tier of list) tiers.push({ ...tier, listStart: heading.index, listEnd: list.at(-1).end });
  }
  return tiers;
}

/**
 * A closing date needs a closing word right next to it: "Deadline: 15 Oct
 * 2026" or "15 Oct 2026 · Late deadline". When a title is given, one of its
 * distinctive words must appear nearby, so site-wide banners announcing a
 * different call are not attributed to this record.
 */
export function extractDeadline(text, { now = Date.now(), title = null } = {}) {
  const closing = new RegExp(`(${CLOSING_WORDS})`, "giu");
  const closingWord = new RegExp(`(?:${CLOSING_WORDS})`, "iu");
  const wanted = titleTokens(title);
  const found = [];
  for (const keyword of text.matchAll(closing)) {
    // Romance-language sentences put the date far from the verb ("plazo de
    // inscripción ... finalizará el 27 de septiembre"): allow a long window
    // but never cross a line break.
    const rawAfter = text.slice(keyword.index + keyword[0].length, keyword.index + keyword[0].length + 110);
    const newline = rawAfter.indexOf("\n");
    const after = newline >= 0 ? rawAfter.slice(0, newline) : rawAfter;
    let hit = readDate(after);
    let start = keyword.index;
    let end = hit ? keyword.index + keyword[0].length + hit.match.index + hit.match[0].length : null;
    if (hit) {
      const between = after.slice(0, hit.match.index);
      const label = after.slice(hit.match.index + hit.match[0].length, hit.match.index + hit.match[0].length + 16);
      if (FOREIGN_DATE_LABEL.test(between) || FOREIGN_DATE_LABEL.test(label)) hit = null;
    }
    if (!hit) {
      // "October 15, 2026 · Late deadline": the date directly precedes its label.
      const before = text.slice(Math.max(0, keyword.index - 40), keyword.index);
      const candidate = readDate(before);
      const gap = candidate ? before.slice(candidate.match.index + candidate.match[0].length) : "";
      if (candidate && gap.replace(/[\s·•|:\-–—()]/gu, "").length <= 6) {
        hit = candidate;
        start = keyword.index - before.length + candidate.match.index;
        end = keyword.index + keyword[0].length;
      }
    }
    if (!hit) continue;
    const evidence = text.slice(start, end).replace(/\s+/g, " ").trim();
    if (CODE_LIKE.test(evidence)) continue;
    const fold = (value) => value.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
    const lineEnd = text.indexOf("\n", end);
    const context = fold(text.slice(Math.max(0, start - 150), lineEnd < 0 ? text.length : lineEnd));
    // A date announced right under another call's name ("Call for
    // applications open / FeatureLab 2027 / Deadline ...") belongs to that call.
    const previousLines = text.slice(Math.max(0, start - 150), start).split("\n").map((line) => line.trim()).filter(Boolean).slice(-2);
    // Only short name-like lines count; ordinary sentences mention years too.
    const underForeignName = wanted.length > 0 && previousLines.some((line) => line.length <= 60
      && CALL_NAME.test(line)
      && !closingWord.test(line)
      && !wanted.some((token) => fold(line).includes(token)));
    if (underForeignName) continue;
    found.push({
      date: hit.date,
      start,
      nearTitle: wanted.some((token) => context.includes(token)),
      evidence,
    });
  }
  for (const tier of tierListDates(text)) {
    const fold = (value) => value.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
    const context = fold(text.slice(Math.max(0, tier.listStart - 150), tier.listEnd + 50));
    found.push({ date: tier.date, start: tier.start, nearTitle: wanted.some((token) => context.includes(token)), evidence: tier.evidence });
  }
  if (!found.length) return null;
  // Prefer dates stated near this record's title when there are several.
  const near = found.filter((item) => item.nearTitle);
  if (near.length) found.splice(0, found.length, ...near);
  // Several closing dates (early/regular/late): keep the latest upcoming one.
  const upcoming = found.filter((item) => item.date.getTime() >= now - 86_400_000);
  const chosen = (upcoming.length ? upcoming : found).sort((a, b) => b.date - a.date)[0];
  return {
    deadline: chosen.date.toISOString().slice(0, 10),
    deadline_status: "confirmed",
    evidence: chosen.evidence,
    month_name: ENGLISH_MONTH_NAMES[chosen.date.getUTCMonth()],
    several_dates: found.length > 1,
  };
}

// ---------------------------------------------------------------- aggregate
export function extractDecisionFields(text, { now = Date.now(), title = null } = {}) {
  const body = typeof text === "string" ? text.slice(0, 200_000) : "";
  return {
    version: DECISION_FIELDS_VERSION,
    deadline: extractDeadline(body, { now, title }),
    runtime: extractRuntime(body),
    fee: extractFee(body),
    ai_policy: extractAiPolicy(body, { title }),
    premiere: extractPremiere(body),
    eligibility: extractEligibility(body),
  };
}

const empty = (value) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * Fill only the facts a raw extraction left empty, attaching the verbatim
 * evidence normalization requires. Existing grounded facts are never replaced.
 */
export function enrichRawOpportunity(raw, facts) {
  const next = { ...raw, field_evidence: { ...(raw.field_evidence ?? {}) } };
  const filled = [];
  if (facts.deadline && empty(raw.deadline) && raw.deadline_status !== "rolling") {
    next.deadline = facts.deadline.deadline;
    next.deadline_status = "confirmed";
    next.deadline_evidence = facts.deadline.evidence;
    filled.push("deadline");
  }
  if (facts.runtime && empty(raw.max_runtime_minutes)) {
    next.max_runtime_minutes = facts.runtime.max_runtime_minutes;
    next.field_evidence.max_runtime = facts.runtime.evidence;
    filled.push("max_runtime_minutes");
  }
  if (facts.fee && empty(raw.entry_fee_amount)) {
    next.entry_fee_amount = facts.fee.entry_fee_amount;
    next.entry_fee_currency = facts.fee.entry_fee_currency;
    next.field_evidence.entry_fee = facts.fee.evidence;
    filled.push("entry_fee_amount");
  }
  if (facts.ai_policy && (empty(raw.ai_policy) || raw.ai_policy === "unclear")) {
    next.ai_policy = facts.ai_policy.ai_policy;
    next.field_evidence.ai_policy = facts.ai_policy.evidence;
    filled.push("ai_policy");
  }
  if (facts.eligibility && empty(raw.eligibility)) {
    next.eligibility = facts.eligibility.eligibility;
    next.field_evidence.eligibility = facts.eligibility.evidence;
    filled.push("eligibility");
  }
  if (facts.premiere && empty(raw.premiere_requirement)) {
    next.premiere_requirement = facts.premiere.premiere_requirement;
    next.field_evidence.premiere = facts.premiere.evidence;
    filled.push("premiere_requirement");
  }
  if (filled.length) next.decision_fields = { version: DECISION_FIELDS_VERSION, filled };
  return next;
}
