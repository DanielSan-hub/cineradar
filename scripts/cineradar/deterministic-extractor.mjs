import { plainText } from "./web-validation.mjs";

const OPPORTUNITY_TERMS = /festival|competition|contest|challenge|grant|fund(?:ing)?|residen(?:cy|ce)|fellowship|\blab\b|open call|call for (?:entries|projects|submissions)|submissions? open|convocatoria|edital|bando|appel (?:a|à) projets|einreichung|wettbewerb|映像.{0,8}(?:公募|募集)|미디어아트.{0,8}공모|影像艺术.{0,8}(?:征集|公開徵集)|دعوة.{0,8}(?:أفلام|مشاريع)/iu;
const APPLICATION_TERMS = /apply|application|submit|submission|enter now|entries|register|inscri(?:ção|ções|coes)|inscripciones?|candidature|bewerbung|応募|申請|신청|제출|报名|提交|التقديم|تقديم/iu;
const DIRECTORY_TERMS = /directory|browse all|all opportunities|all festivals|search festivals|filter by|results found|opportunity directory/iu;
const GENERIC_HEADING = /^(?:open calls?|calls? for (?:entries|projects)|opportunities|applications?|submissions?|grants?|funding|residencies|festivals?|(?:film\s+)?festivals?\s+list(?:ings?)?|(?:film\s+)?festivals?\s+submissions?\s*(?:&|and)\s*deadlines?|get\s+funding\s*(?:&|and)\s*support|competitions?|challenges?|news)(?:\s+20\d{2})?$/iu;

function decodeAttribute(value) {
  return plainText(String(value ?? "").replaceAll("&quot;", '"'));
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(String(html ?? ""));
    const value = decodeAttribute(match?.[1]);
    if (value) return value;
  }
  return null;
}

function pageHeading(page) {
  return firstMatch(page.html, [
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/iu,
    /<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/iu,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/iu,
    /<title\b[^>]*>([\s\S]*?)<\/title>/iu,
  ]);
}

function relevantLinks(page) {
  return (page.linkRecords ?? []).filter((record) =>
    APPLICATION_TERMS.test(`${record.text ?? ""} ${record.url ?? ""}`),
  );
}

function likelyDirectory(page, opportunityLinks) {
  const heading = pageHeading(page) ?? "";
  return opportunityLinks.length > 10
    || (DIRECTORY_TERMS.test(`${heading} ${page.text.slice(0, 2_000)}`) && opportunityLinks.length > 2);
}

function categoryFor(text) {
  if (/advertis|branded|commercial|music video/iu.test(text)) return "Advertising competition";
  if (/residen(?:cy|ce)|artist-in-residence|artist in residence/iu.test(text)) return "Residency";
  if (/grant|fund(?:ing)?|fondo|fomento|edital|commission/iu.test(text)) return "Grant";
  if (/platform|creator challenge|generative video|AI video|artificial intelligence/iu.test(text)) {
    return /festival/iu.test(text) ? "AI film festival" : "Platform challenge";
  }
  return "Traditional festival";
}

function explicitDeadline(text) {
  const localizedDeadline = "deadline|closes?|due date|scadenza|fecha limite|fecha límite|prazo|date limite|bewerbungsschluss|締切|마감|截止|آخر موعد";
  const patterns = [
    new RegExp(`((?:${localizedDeadline})[^\\n.]{0,100}\\b20\\d{2}-\\d{2}-\\d{2}\\b)`, "iu"),
    new RegExp(`((?:${localizedDeadline})[^\\n.]{0,100}\\b(?:[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+20\\d{2}\\b)`, "iu"),
    new RegExp(`((?:${localizedDeadline})[^\\n.]{0,100}\\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+(?:[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?,?\\s+20\\d{2}\\b)`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const date = match[1].match(/20\d{2}-\d{2}-\d{2}|(?:[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,?\s+20\d{2}/iu)?.[0];
    if (date) return { value: date, evidence: match[1].trim() };
  }
  return null;
}

function explicitStatus(text) {
  const sample = String(text ?? "").slice(0, 6_000);
  const closed = /\b(?:applications?|submissions?|entries)\s+(?:are\s+|now\s+)?closed\b|\b(?:no longer|not)\s+accepting\s+(?:applications?|submissions?|entries)\b/iu.exec(sample);
  const open = /\b(?:applications?|submissions?|entries)\s+(?:are\s+|now\s+)?open\b|\bopen\s+for\s+(?:applications?|submissions?|entries)\b/iu.exec(sample);
  if (Boolean(closed) === Boolean(open)) return null;
  const match = closed ?? open;
  return { status: closed ? "closed" : "open", evidence: match[0] };
}

/**
 * Extract one obvious opportunity from visible, structured page content.
 * Directory/listing pages and uncertain cases deliberately fall through to
 * the LLM path; this function never guesses missing facts.
 */
export function deterministicPageExtraction(page, { sourceType = "official" } = {}) {
  const title = pageHeading(page);
  const applicationLinks = relevantLinks(page);
  const signal = `${title ?? ""}\n${page.text.slice(0, 12_000)}`;
  if (!title || GENERIC_HEADING.test(title.trim()) || !OPPORTUNITY_TERMS.test(title)) {
    return { disposition: "ambiguous", records: [], reason: "NO_STRONG_TITLE_SIGNAL" };
  }
  if (likelyDirectory(page, applicationLinks)) {
    return { disposition: "ambiguous", records: [], reason: "MULTI_ITEM_DIRECTORY" };
  }
  const deadline = explicitDeadline(page.text);
  const status = explicitStatus(page.text);
  const application = applicationLinks[0]?.url ?? null;
  if (!application && !deadline && !/(?:open call|submissions? open|call for (?:entries|projects|submissions))/iu.test(signal)) {
    return { disposition: "ambiguous", records: [], reason: "NO_APPLICATION_OR_DEADLINE" };
  }
  const online = /\b(?:online|remote|worldwide)\b/iu.test(page.text.slice(0, 8_000));
  return {
    disposition: "complete",
    reason: "VISIBLE_DETAIL_PAGE",
    records: [{
      relevant: true,
      title,
      organizer: "Unknown organizer",
      category: categoryFor(title),
      ai_policy: "unclear",
      deadline: deadline?.value ?? null,
      deadline_status: deadline ? "confirmed" : "unknown",
      deadline_evidence: deadline?.evidence ?? null,
      observed_status: status?.status ?? null,
      status_evidence: status?.evidence ?? null,
      deadline_source_url: deadline ? page.finalUrl : null,
      opens_at: null,
      prize_amount: null,
      prize_currency: null,
      entry_fee_amount: null,
      entry_fee_currency: null,
      location: online ? "Online" : "Unspecified",
      remote: online,
      max_runtime_minutes: null,
      official_url: sourceType === "official" ? page.finalUrl : null,
      application_url: application,
      source_type: sourceType,
      summary: "",
      eligibility: [],
      formats: [],
      tags: ["deterministic-extraction"],
      field_evidence: {
        title,
        ...(online ? { location: "Online" } : {}),
      },
    }],
  };
}
