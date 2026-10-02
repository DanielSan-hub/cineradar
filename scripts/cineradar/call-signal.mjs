// Cheap, multilingual "is there an actionable call on this page?" gate. It runs
// on text the monitor has already fetched, so pages without a call never reach
// paid extraction. Pure: no network, filesystem or database access.

export const CALL_SIGNAL_VERSION = "call-signal-v2";

// Phrases that announce a call, submission window or application process.
const CALL_TERMS = [
  ["en", /\bcall (?:for|to) (?:entr|submission|film|work|project|application|artist|proposal)/i],
  ["en", /\bopen[- ]?call\b/i],
  ["en", /\bsubmissions? (?:are |is )?(?:now )?open\b|\bsubmit (?:your|a) (?:film|work|project|short)|\bnow accepting (?:submissions|entries|applications)/i],
  ["en", /\b(?:submission|entry|application|final|early|regular|late|extended) deadlines?\b|\bdeadline\s*[:\-–]/i],
  ["en", /\bapplications? (?:are |is )?(?:now )?open\b|\bapply (?:now|by|before|until)\b|\bhow to (?:apply|submit|enter)\b/i],
  ["en", /\bentry fees?\b|\brules (?:and|&) regulations\b|\beligibility\b/i],
  ["it", /\bbando\b|\bscadenza\b|\biscrizion[ei] (?:aperte|entro)|\bcandidature (?:aperte|entro)|\bregolamento\b/i],
  ["es", /\bconvocatoria\b|\bfecha l[ií]mite\b|\binscripci(?:ón|ones) (?:abiertas|hasta)|\bbases (?:de|del) (?:concurso|festival|convocatoria)/i],
  ["pt", /\binscri(?:ç|c)(?:õ|o)es (?:abertas|até)|\bprazo (?:de|final)|\bedital\b|\bchamada (?:aberta|p[uú]blica)/i],
  ["fr", /\bappel (?:à|a) (?:films|projets|candidatures|courts)|\bdate limite\b|\binscriptions? (?:ouvertes|jusqu)|\br[eè]glement\b/i],
  ["de", /\bausschreibung\b|\beinreich(?:ung|frist|schluss)|\bbewerbungs(?:schluss|frist)|\banmeldeschluss\b/i],
  ["nl", /\binzend(?:ing|en|termijn)|\baanmelden (?:kan|tot)|\bopen oproep\b/i],
  ["pl", /\bnab[oó]r (?:film|zgłosze|wniosk)|\btermin (?:nadsyłania|zgłosze)|\bzgłoszenia\b/i],
  ["tr", /\bbaşvuru(?:lar)? (?:açık|tarihi)|\bson başvuru\b/i],
  // JS \b is ASCII-only, so non-Latin scripts match without word boundaries.
  ["ru", /при[её]м заявок|дедлайн|крайний срок/iu],
  ["el", /προθεσμία|υποβολή (?:ταινιών|αιτήσεων)|πρόσκληση/iu],
  ["en", /\bsubmissions?\b|\bentry form\b|\benter your (?:film|work)/i],
  // Contest and challenge sites announce calls with buttons, not prose.
  ["en", /\bsubmit (?:now|here|today|your entry)\b|\benter (?:now|here|the (?:contest|competition|challenge))\b|\bregister (?:now|your film)\b|\bjoin the (?:contest|challenge|competition)\b|\bprize pool\b|\bcash prizes?\b/i],
  ["es", /\bpostulaci(?:ón|on|ones)\b|\bplazo de (?:inscripci|presentaci)/i],
  ["pt", /\bcandidaturas?\b|\bsubmiss(?:ã|a)o de (?:filmes|obras)/i],
  ["ca", /\bconvocat(?:ò|o)ria\b|\binscripcions\b|\bdata l(?:í|i)mit\b/i],
  ["hu", /\bnevez(?:é|e)s|\bp(?:á|a)ly(?:á|a)zat|\bjelentkez(?:é|e)si/i],
  ["cs", /\bp(?:ř|r)ihl(?:á|a)(?:š|s)k|\buz(?:á|a)v(?:ě|e)rka/i],
  ["ro", /(?:î|i)nscrieri|termen(?:ul)? limit/i],
  ["nordic", /\bans(?:ö|o)kan|\bans(?:ø|o)gning|\bs(?:ø|o)knad|\btilmelding|\bp(?:å|a)melding|\bhakuaika|\bhaku (?:on )?auki/i],
  ["id", /\bpendaftaran\b|\bbatas waktu\b|\bpanggilan terbuka/i],
  ["vi", /hạn chót|hạn nộp|kêu gọi (?:tác phẩm|dự án)/iu],
  ["th", /รับสมัคร|ส่งผลงาน/u],
  ["he", /הגשת|מועד אחרון|קול קורא/u],
  ["hi", /आवेदन|अंतिम तिथि/u],
  ["ja", /募集|応募|締切|締め切り|公募/u],
  ["ko", /공모|출품|마감|접수 ?기간/u],
  ["zh", /征集|征片|报名|截止|投稿/u],
  ["ar", /آخر موعد|باب التقديم|التقديم مفتوح|دعوة مفتوحة/u],
];

// AI filmmaking context: specific phrases only, so a festival that merely
// mentions "AI" once is not treated as an AI contest site.
const AI_FILM_TEXT = /\bAI[- ](?:film|movie|video|short|cinema|generated|filmmak|animation|music video|creators?|storytell|ad\b|advert)|\bgenerative (?:AI|video|film|cinema)|\bAI[- ]assisted\b|\bmade with AI\b|\bartificial intelligence (?:film|cinema|video)|\b(?:cine|cortos?|cortometrajes?|película|festival)\b[^.\n]{0,40}\b(?:IA|inteligencia artificial)\b|\bintelligenza artificiale\b|\bintelligence artificielle\b|\bKI[- ](?:Film|Kurzfilm)|AI映画|AI영화|AI 영화|AI电影|AI短片/iu;

export function isAiFilmText(text) {
  return AI_FILM_TEXT.test(typeof text === "string" ? text.slice(0, 200_000) : "");
}

/** Registry sources dedicated to AI film / creative tech. */
export function isAiSource(source) {
  if (!source) return false;
  return source.source_family === "ai-creative-tech"
    || (Array.isArray(source.opportunity_categories) && source.opportunity_categories.includes("ai-film"));
}

const CLOSED_TERMS =/\b(?:submissions?|applications?|entries|call) (?:are |is )?(?:now )?closed\b|\bno longer accepting\b|\bbando scaduto\b|\bconvocatoria cerrada\b|\binscri(?:ç|c)(?:õ|o)es encerradas\b|\bappel clos\b|\bbewerbungsfrist (?:ist )?abgelaufen\b|募集は終了|마감되었습니다|已截止/iu;

const MONTHS = new Map(Object.entries({
  january: 1, jan: 1, gennaio: 1, enero: 1, janvier: 1, januar: 1, janeiro: 1, januari: 1,
  february: 2, feb: 2, febbraio: 2, febrero: 2, février: 2, fevrier: 2, februar: 2, fevereiro: 2, februari: 2,
  march: 3, mar: 3, marzo: 3, mars: 3, märz: 3, marz: 3, março: 3, marco: 3, maart: 3,
  april: 4, apr: 4, aprile: 4, abril: 4, avril: 4,
  may: 5, maggio: 5, mayo: 5, mai: 5, maio: 5, mei: 5,
  june: 6, jun: 6, giugno: 6, junio: 6, juin: 6, juni: 6, junho: 6,
  july: 7, jul: 7, luglio: 7, julio: 7, juillet: 7, juli: 7, julho: 7,
  august: 8, aug: 8, agosto: 8, août: 8, aout: 8, augustus: 8,
  september: 9, sep: 9, sept: 9, settembre: 9, septiembre: 9, septembre: 9, setembro: 9,
  october: 10, oct: 10, ottobre: 10, octubre: 10, octobre: 10, oktober: 10, outubro: 10,
  november: 11, nov: 11, novembre: 11, noviembre: 11, novembro: 11,
  december: 12, dec: 12, dicembre: 12, diciembre: 12, décembre: 12, decembre: 12, dezember: 12, dezembro: 12,
}));
/** Month names (en/it/es/fr/de/pt/nl, full and short) mapped to 1-12. */
export const MONTH_NUMBERS = MONTHS;
const MONTH_NAMES = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join("|");

const DATE_PATTERNS = [
  // 2026-10-15, 2026.10.15, 2026/10/15
  [/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/g, (m) => [[+m[1], +m[2], +m[3]]]],
  // 2026年10月15日, 2026년 10월 15일
  [/(20\d{2})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]?/gu, (m) => [[+m[1], +m[2], +m[3]]]],
  // 15 October 2026, 15 de octubre de 2026, 15. Oktober 2026
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er|º|°)?\\.?\\s+(?:de\\s+)?(${MONTH_NAMES})\\.?,?\\s+(?:de\\s+)?(20\\d{2})\\b`, "giu"),
    (m) => [[+m[3], MONTHS.get(m[2].toLowerCase()), +m[1]]]],
  // October 15, 2026
  [new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "giu"),
    (m) => [[+m[3], MONTHS.get(m[1].toLowerCase()), +m[2]]]],
  // 15/10/2026 or 10/15/2026: keep both readings, the window check decides.
  [/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g, (m) => [[+m[3], +m[2], +m[1]], [+m[3], +m[1], +m[2]]]],
];

function validDate(year, month, day) {
  if (!month || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = Date.UTC(year, month - 1, day);
  const check = new Date(date);
  return check.getUTCMonth() === month - 1 ? date : null;
}

/** Dates mentioned in the text that fall inside the actionable window. */
export function futureDateMentions(text, { now = Date.now(), pastDays = 3, futureDays = 548 } = {}) {
  const from = now - pastDays * 86_400_000;
  const to = now + futureDays * 86_400_000;
  const found = new Set();
  for (const [pattern, readings] of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      for (const [year, month, day] of readings(match)) {
        const date = validDate(year, month, day);
        if (date !== null && date >= from && date <= to) found.add(date);
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Current/next-year mentions, ignoring copyright footers. */
function mentionsUpcomingYear(text, now) {
  const year = new Date(now).getUTCFullYear();
  const pattern = /(20\d{2})/g;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (value !== year && value !== year + 1) continue;
    const before = text.slice(Math.max(0, match.index - 14), match.index);
    if (/©|\(c\)|copyright|&copy;/i.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * Score a page for an actionable call. `pass` favours recall: one call term
 * plus either an in-window date or an upcoming-year mention, or three
 * distinct call terms on their own.
 *
 * @param {string} text plain page text
 * @param {{ now?: number }} [options]
 */
export function scoreCallSignal(text, { now = Date.now(), lenient = false } = {}) {
  const body = typeof text === "string" ? text.slice(0, 200_000) : "";
  const terms = [...new Set(CALL_TERMS.filter(([, pattern]) => pattern.test(body)).map(([lang, pattern]) => `${lang}:${pattern.source.slice(0, 24)}`))];
  const dates = futureDateMentions(body, { now });
  const upcomingYear = mentionsUpcomingYear(body, now);
  const closed = CLOSED_TERMS.test(body);
  const score = Math.min(terms.length, 4) * 2
    + (dates.length ? 3 : 0)
    + (upcomingYear ? 1 : 0)
    - (closed ? 1 : 0);
  const strict = (terms.length >= 1 && (dates.length > 0 || upcomingYear)) || terms.length >= 3;
  return {
    version: CALL_SIGNAL_VERSION,
    // Several distinct call phrases are enough even when no date is printed.
    // AI-film sources are few and mostly contests: one call phrase, an
    // in-window date or an upcoming-year mention is enough there.
    pass: strict || (lenient && (terms.length >= 1 || dates.length > 0 || upcomingYear)),
    score,
    termCount: terms.length,
    futureDates: dates.length,
    nextDate: dates.length ? new Date(dates[0]).toISOString().slice(0, 10) : null,
    upcomingYear,
    closed,
  };
}
