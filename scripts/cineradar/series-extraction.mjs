// Series-anchored extraction. A page from the official site of a series we
// already know (Wikidata, the owner's datasets as sources, directory harvest)
// does not need an LLM: the series is named by the registry, and the call is
// read with rules — a dated deadline, a submission link to a platform, an
// explicit "submissions open" or "closed" statement. The result is a raw item
// in the LLM's output shape, so it goes through the same normalization,
// grounding checks, URL validation, deduplication and review as any record.
// Pure: no network, no database.

import { isAiFilmText } from "./call-signal.mjs";
import { huntDeadline, isApplyPage, NOT_A_SUBMISSION } from "./deadline-hunt.mjs";
import { hostOf } from "./registry-seeds.mjs";

// Families whose sources are one organizer's own site (not listings).
export const SERIES_FAMILIES = Object.freeze(new Set([
  "official-site", "ai-creative-tech", "film-funding", "media-art-residency", "platform-company", "arts-institution",
]));

export function isSeriesSource(source) {
  return Boolean(source)
    && SERIES_FAMILIES.has(source.source_family)
    && source.adapter_config?.seed !== "dataset-channel";
}

// Submission platforms: a link to one of them on an official page is the
// call's application route. FilmFreeway is linked, never fetched.
const PLATFORMS = Object.freeze({
  "filmfreeway.com": "FilmFreeway",
  "festhome.com": "Festhome",
  "shortfilmdepot.com": "ShortFilmDepot",
  "movibeta.com": "Movibeta",
  "clickforfestivals.com": "Click for Festivals",
  "filmfestplatform.com": "FilmFestPlatform",
  "submittable.com": "Submittable",
  "filmchief.com": "FilmChief",
  "festagent.com": "FestAgent",
});

export function platformOf(url) {
  const host = hostOf(url);
  if (!host) return null;
  const match = Object.keys(PLATFORMS).find((platform) => host === platform || host.endsWith(`.${platform}`));
  return match ? PLATFORMS[match] : null;
}

/** A platform link that points at one festival, not at the platform's home or search. */
export function festivalPlatformLink(url) {
  const platform = platformOf(url);
  if (!platform) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (!path || /^\/(?:[a-z]{2}\/)?(?:festivals?|festivales|search|login|signup|register|about|faq|help|pricing|blog)?$/i.test(path)) return null;
    if (/\/(?:submissions?|account|dashboard|cart)\b/i.test(path) && !/\/festival/i.test(path) && platform !== "Submittable") return null;
    return { url: parsed.href, platform };
  } catch {
    return null;
  }
}

/** True when a page links one festival's page on a submission platform. */
export function pageHasPlatformLink(page) {
  return (page?.linkRecords ?? []).some((link) => festivalPlatformLink(link.url));
}

// Links to a call's own pages on a festival site ("Submit", "Call for
// entries", "Rules", "Bases", "Regolamento"): the call is often stated there
// while the homepage says nothing about it.
const SUBMISSION_LINK = /\b(?:submit\w*|submissions?|call[\s_-]+for[\s_-]+(?:entries|submissions|films|projects|works|applications)|open[\s_-]+call|entry[\s_-]+form|enter[\s_-]+your[\s_-]+film|how[\s_-]+to[\s_-]+(?:submit|apply|enter)|rules|regulations?|reglamento|bases|convocatoria|inscripci\w*|iscrizion\w*|bando|regolamento|einreich\w*|ausschreibung|r[eè]glement|appel[\s_-]+(?:[àa][\s_-]+)?(?:films|candidatures|projets)|edital|inscri[cç][oõ]es)\b|応募|募集|공모/iu;
const NOT_SUBMISSION_LINK = /\b(?:winners?|jury|tickets?|press|news|blog|shop|volunteer\w*|sponsor\w*|privacy|cookies?|login|newsletter|accreditation|job\w*)\b/iu;

/** True when a series' own page links a submission page of the same site (or a platform). */
export function pageHasSubmissionLink(page) {
  const site = hostOf(page?.finalUrl ?? page?.inputUrl ?? "")?.replace(/^www\./, "");
  if (!site) return false;
  return (page?.linkRecords ?? []).some((link) => {
    const host = hostOf(link.url)?.replace(/^www\./, "");
    if (!host || (host !== site && !host.endsWith(`.${site}`) && !site.endsWith(`.${host}`))) return Boolean(festivalPlatformLink(link.url));
    let path = "";
    try {
      path = decodeURIComponent(new URL(link.url).pathname);
    } catch {
      return false;
    }
    const label = `${link.text ?? ""} ${path}`;
    return SUBMISSION_LINK.test(label) && !NOT_SUBMISSION_LINK.test(label);
  });
}

const EXPLICIT_OPEN =/\b(?:submissions?|entries|applications?|call\s+for\s+(?:entries|submissions|films|projects))\s+(?:are\s+|is\s+)?(?:now\s+)?open\b|\bopen\s+for\s+(?:submissions?|entries|applications?)\b|\bnow\s+accepting\s+(?:submissions?|entries|films|applications?)\b|\binscripciones\s+abiertas\b|\bconvocatoria\s+abierta\b|\biscrizioni\s+aperte\b|\binscriptions?\s+(?:sont\s+)?ouvertes?\b|\beinreichung(?:en)?\s+(?:ist|sind)?\s*(?:ge)?öffnet\b|\binscri(?:ç|c)(?:õ|o)es\s+abertas\b/iu;
const EXPLICIT_CLOSED = /\b(?:submissions?|applications?|entries|call)\s+(?:are\s+|is\s+)?(?:now\s+)?closed\b|\b(?:submissions?|applications?|entries|registrations?)\s+(?:for|to)\s+[^.\n]{1,80}?\s+(?:are|is)\s+(?:now\s+)?closed\b|\bno\s+longer\s+accepting\b|\bconvocatoria\s+cerrada\b|\binscripciones\s+cerradas\b|\biscrizioni\s+chiuse\b|\bbando\s+scaduto\b|\binscriptions?\s+(?:sont\s+)?(?:closes|ferm[ée]es)\b|\bbewerbungsfrist\s+(?:ist\s+)?abgelaufen\b|\binscri(?:ç|c)(?:õ|o)es\s+encerradas\b/iu;

function quoteAround(text, match) {
  if (!match) return null;
  return text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40).replace(/\s+/g, " ").trim().slice(0, 180);
}

/**
 * Evidence of a call across a series' pages (subpages first: a Rules page
 * states this call's own dates). `accept` filters deadline evidence (used on
 * sites with several calls).
 */
export function seriesEvidence(pages, { title = null, now = Date.now(), accept = () => true } = {}) {
  const evidence = { deadline: null, deadlinePage: null, platformLink: null, applyPage: null, open: null, closed: null };
  for (const page of pages) {
    const hit = huntDeadline(page, { title, now, accept });
    if (hit) {
      evidence.deadline = hit;
      evidence.deadlinePage = page;
      break;
    }
  }
  for (const page of pages) {
    for (const link of page.linkRecords ?? []) {
      const platform = festivalPlatformLink(link.url);
      if (platform) {
        evidence.platformLink = { ...platform, text: String(link.text ?? "").slice(0, 120) };
        break;
      }
    }
    if (evidence.platformLink) break;
  }
  evidence.applyPage = pages.find((page) => page !== pages.at(-1) && isApplyPage(page.finalUrl)) ?? null;
  const text = pages.map((page) => page.text ?? "").join("\n");
  // An "open"/"closed" statement counts only when it is about submitting
  // work, not about a workshop, volunteers or tickets on the same site.
  const filmStatement = (pattern) => {
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) {
      const around = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60);
      if (!NOT_A_SUBMISSION.test(around)) return match;
    }
    return null;
  };
  const openMatch = filmStatement(EXPLICIT_OPEN);
  const closedMatch = filmStatement(EXPLICIT_CLOSED);
  if (openMatch) evidence.open = quoteAround(text, openMatch);
  if (closedMatch && !openMatch) evidence.closed = quoteAround(text, closedMatch);
  return evidence;
}

export function hasCallEvidence(evidence) {
  return Boolean(evidence?.deadline || evidence?.platformLink || evidence?.open || evidence?.closed);
}

function metaContent(html, name) {
  const pattern = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${name}["'][^>]*content=["']([^"']{2,200})["']`, "iu");
  const reverse = new RegExp(`<meta\\b[^>]*content=["']([^"']{2,200})["'][^>]*(?:property|name)=["']${name}["']`, "iu");
  return (pattern.exec(html ?? "") ?? reverse.exec(html ?? ""))?.[1]?.replace(/&amp;/g, "&").trim() ?? null;
}

const HOST_LIKE = /^[\w-]+(?:\.[\w-]+)+$/;
// Registry names taken from a link's text ("Entry forms", "Submit") name a
// page, not the series.
const LABEL_WORDS = new Set(["entry", "entries", "form", "forms", "submit", "submission", "submissions", "apply", "now", "application", "applications", "registration", "register", "home", "homepage", "call", "calls", "for", "open", "rules", "and", "regulations", "regulation", "guidelines", "faq", "faqs", "news", "contact", "about", "us", "info", "information", "page", "deadlines", "deadline", "your", "a", "film", "films", "work", "festival", "competition", "en", "eng", "english", "the", "&", "how", "to", "terms", "conditions"]);
// A name made only of page-label words ("Entry forms", "Submissions FAQ").
const PAGE_LABEL_NAME = {
  test(value) {
    const words = String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
    return words.length > 0 && words.every((word) => LABEL_WORDS.has(word));
  },
};

/** The series' public name: the registry name, unless it is only a host or a page label. */
export function seriesName(source, home) {
  const registry = String(source?.name ?? "").replace(/\s+/g, " ").trim();
  if (registry && !HOST_LIKE.test(registry) && !PAGE_LABEL_NAME.test(registry)) return registry.slice(0, 200);
  const site = metaContent(home?.html, "og:site_name");
  if (site && !/^(?:home|homepage|welcome|index)$/i.test(site)) return site.slice(0, 200);
  const title = /<title[^>]*>([\s\S]{2,200}?)<\/title>/i.exec(home?.html ?? "")?.[1]?.replace(/\s+/g, " ").split(/\s[|–—-]\s/)[0].trim();
  if (title && !PAGE_LABEL_NAME.test(title)) return title;
  return registry && !PAGE_LABEL_NAME.test(registry) ? registry : null;
}

const CATEGORY_BY_TAG = [
  ["ai-film", "AI film festival"],
  ["grant", "Grant"],
  ["residency", "Residency"],
  ["branded-open-call", "Advertising competition"],
  ["platform-challenge", "Platform challenge"],
];
const CATEGORY_BY_FAMILY = {
  "ai-creative-tech": "AI film festival",
  "film-funding": "Grant",
  "media-art-residency": "Residency",
  "platform-company": "Platform challenge",
};

export function seriesCategory(source, name, text = "") {
  const tags = source?.opportunity_categories ?? [];
  for (const [tag, category] of CATEGORY_BY_TAG) if (tags.includes(tag)) return category;
  if (CATEGORY_BY_FAMILY[source?.source_family]) return CATEGORY_BY_FAMILY[source.source_family];
  if (isAiFilmText(`${name} ${text.slice(0, 3000)}`)) return "AI film festival";
  if (/\b(?:fund|grant|bursary|financement|finanziament|subvenci|f[öo]rderung)\b/i.test(name)) return "Grant";
  if (/\bresiden/i.test(name)) return "Residency";
  return "Traditional festival";
}

/**
 * Raw item for a series page with call evidence, or null when the page shows
 * none (no record is created; the page is re-read when it changes).
 */
export function seriesRawItem({ source, home, pages, evidence, now = Date.now() }) {
  if (!hasCallEvidence(evidence)) return null;
  const name = seriesName(source, home);
  if (!name) return null;
  const organizer = metaContent(home?.html, "og:site_name") ?? name;
  const deadline = evidence.deadline;
  const text = pages.map((page) => page.text ?? "").join("\n");
  const summary = metaContent(home?.html, "og:description") ?? metaContent(home?.html, "description") ?? "";
  const applicationUrl = evidence.platformLink?.url ?? evidence.applyPage?.finalUrl ?? null;
  const year = deadline ? Number(deadline.deadline.slice(0, 4)) : null;
  return {
    relevant: true,
    title: name,
    canonical_name: name,
    organizer,
    category: seriesCategory(source, name, text),
    ai_policy: "unclear",
    deadline: deadline?.deadline ?? null,
    deadline_status: deadline?.deadline_status ?? "unknown",
    deadline_evidence: deadline?.evidence ?? null,
    observed_status: evidence.open ? "open" : evidence.closed ? "closed" : null,
    status_evidence: evidence.open ?? evidence.closed ?? null,
    deadline_source_url: evidence.deadlinePage?.finalUrl ?? null,
    opens_at: null,
    prize_amount: null,
    prize_currency: null,
    entry_fee_amount: null,
    entry_fee_currency: null,
    location: null,
    remote: false,
    max_runtime_minutes: null,
    official_url: home.finalUrl,
    application_url: applicationUrl,
    source_type: "official",
    confidence: 0.7,
    summary: String(summary).slice(0, 300),
    eligibility: [],
    formats: [],
    tags: ["series-anchored", ...(evidence.platformLink ? [`via-${evidence.platformLink.platform.toLowerCase().replace(/\s+/g, "-")}`] : [])],
    opportunity_year: year && year >= new Date(now).getUTCFullYear() ? year : null,
    edition: null,
    field_evidence: {
      title: name,
      organizer,
      opens_at: null,
      prize: null,
      entry_fee: null,
      location: null,
      max_runtime: null,
      ai_policy: null,
      eligibility: null,
      formats: null,
    },
    series_evidence: {
      method: "series-anchored-v1",
      deadline_method: deadline?.method ?? null,
      platform: evidence.platformLink?.platform ?? null,
      platform_link_text: evidence.platformLink?.text ?? null,
      open_quote: evidence.open,
      closed_quote: evidence.closed,
    },
  };
}

/** One page made of the series' pages, so every quote and link is grounded. */
export function combinedSeriesPage(home, pages) {
  const ordered = [home, ...pages.filter((page) => page !== home)];
  const links = [...new Set(ordered.flatMap((page) => page.links ?? []))];
  return {
    ...home,
    text: ordered.map((page) => page.text ?? "").join("\n\n").slice(0, 200_000),
    links,
    linkRecords: ordered.flatMap((page) => page.linkRecords ?? []),
  };
}
