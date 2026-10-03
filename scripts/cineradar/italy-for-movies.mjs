// Italy for Movies (Cinecittà / Ministry of Culture): the national portal of
// Italian film funds and incentives. Each grant page ("Scheda bando") states
// the opening and closing dates of its sessions, whether it is open, the
// funding body and a "Link al bando" to the funder's own page. Records keep
// the funder's page as official page (auto-review confirms the date there);
// the portal is credited as the source. Pure helpers: no network.

export const IFM_SITEMAP = "https://www.italyformovies.it/sitemap.xml";
export const IFM_HOST = "www.italyformovies.it";

/** Grant pages listed in the portal's sitemap. */
export function ifmGrantUrls(xml) {
  // The sitemap lists them on the bare domain; the site serves them on www.
  return [...new Set([...String(xml ?? "").matchAll(/https?:\/\/(?:www\.)?italyformovies\.it(\/bandi\/detail\/\d+\/[a-z0-9-]+)/g)]
    .map((match) => `https://www.italyformovies.it${match[1]}`))];
}

function isoFromItalian(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return date.getUTCMonth() === Number(match[2]) - 1 ? date.toISOString().slice(0, 10) : null;
}

const ORGANIZATION = /\b(?:film\s+commission|regione|fondazione|ministero|mic|comune|provincia|fondo|istituto|camera|commission|agenzia|universit[aà]|cinecitt[aà]|direzione|dipartimento|assessorato|siae|rai|ente)\b/iu;

/** Facts printed on a grant page (plain text and link records). */
export function parseIfmGrant(page) {
  const text = String(page?.text ?? "").replace(/\s+/g, " ");
  const start = text.indexOf("Scheda bando");
  const head = start >= 0 ? text.slice(start, start + 600) : text.slice(0, 600);
  const opening = /Apertura sessioni:\s*(\d{1,2}\.\d{1,2}\.\d{4})/.exec(head);
  const closing = /Scadenza sessioni:\s*(\d{1,2}\.\d{1,2}\.\d{4})/.exec(head);
  const status = /\b(Aperto|Chiuso|In arrivo|Prossimamente)\b/.exec(head)?.[1] ?? null;
  const title = String(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(page?.html ?? "")?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim()
    || String(/<title>([^<|]+)/i.exec(page?.html ?? "")?.[1] ?? "").trim();
  const contact = /Contatti dell'ente\s+(.{2,120}?)\s+(?:Responsabile|Telefono|Email|E-mail|Link al bando|Sito)/.exec(text)?.[1]?.trim() ?? null;
  const link = (page?.linkRecords ?? []).find((record) => /link al bando/i.test(record.text ?? ""))?.url ?? null;
  return {
    title: title || null,
    opening: opening ? isoFromItalian(opening[1]) : null,
    closing: closing ? isoFromItalian(closing[1]) : null,
    closingQuote: closing ? `Scadenza sessioni: ${closing[1]}` : null,
    openingQuote: opening ? `Apertura sessioni: ${opening[1]}` : null,
    status,
    funder: contact && ORGANIZATION.test(contact) ? contact : null,
    link: link && !/italyformovies\./i.test(link) ? link : null,
  };
}

/** Raw item for an open grant with a future closing date, or null. */
export function ifmRawItem(page, { now = Date.now() } = {}) {
  const grant = parseIfmGrant(page);
  if (!grant.title || !grant.closing || grant.status !== "Aperto" || !grant.link) return null;
  if (Date.parse(`${grant.closing}T23:59:59Z`) < now) return null;
  return {
    relevant: true,
    title: grant.title,
    canonical_name: grant.title,
    organizer: grant.funder ?? "Unknown organizer",
    category: "Grant",
    ai_policy: "unclear",
    deadline: grant.closing,
    deadline_status: "confirmed",
    deadline_evidence: grant.closingQuote,
    observed_status: null,
    status_evidence: null,
    deadline_source_url: page.finalUrl,
    opens_at: grant.opening,
    prize_amount: null,
    prize_currency: null,
    entry_fee_amount: null,
    entry_fee_currency: null,
    location: null,
    remote: false,
    max_runtime_minutes: null,
    official_url: grant.link,
    application_url: null,
    source_type: "community",
    confidence: 0.7,
    summary: "",
    eligibility: [],
    formats: [],
    tags: ["platform:italyformovies"],
    opportunity_year: Number(grant.closing.slice(0, 4)),
    edition: null,
    field_evidence: { title: grant.title, organizer: grant.funder, opens_at: grant.openingQuote, prize: null, entry_fee: null, location: null, max_runtime: null, ai_policy: null, eligibility: null, formats: null },
    series_evidence: { method: "italy-for-movies-v1", deadline_method: "portal-page", platform: "Italy for Movies" },
  };
}
