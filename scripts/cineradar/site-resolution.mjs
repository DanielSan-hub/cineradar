// Pure helpers for finding a call's own website from its name (used by
// resolve-names.mjs). No network, no database.

import { seriesKey } from "./registry-seeds.mjs";

// Sites that list other people's calls are never a series' own site.
export const RESOLVER_EXCLUDE = Object.freeze([
  "filmfreeway.com", "festhome.com", "shortfilmdepot.com", "clickforfestivals.com", "movibeta.com",
  "submittable.com", "eventival.com", "filmfestplatform.com", "festagent.com", "imdb.com",
  "letterboxd.com", "wikipedia.org", "wikidata.org", "facebook.com", "instagram.com", "x.com",
  "twitter.com", "youtube.com", "linkedin.com", "tiktok.com", "eventbrite.com", "allevents.in",
  "reddit.com", "medium.com", "festivalfocus.org", "filmfestivallife.com", "withoutabox.com",
  "stage32.com", "backstage.com", "festivalreel.com", "filmfestivalguild.com", "stayhappening.com",
  "aifilmcontests.com", "kajimelo.com", "on-the-move.org", "e-flux.com", "artrabbit.com",
  "transartists.org", "resartis.org", "web.archive.org", "wixsite.com",
]);

const GENERIC_NAME = /^(?:unknown(?:\s+organizer)?|submissions?|call for entries|festival|film festival|competition|open call|home)$/iu;

// Aggregators recorded as the organizer of the calls they list.
const AGGREGATOR_ORGANIZER = /^(?:on the move|kajimelo|ai ?film ?contests|e-flux|artrabbit|transartists|res artis|festhome|festagent|filmfreeway)\b/iu;
const NO_PLACE = /^(?:unspecified|unknown|online|worldwide|international|global|remote|various|n\/?a|tbd|tba)$/iu;

/** The name a record is known by: its organizer when it names one, else its title. */
export function resolverName(row) {
  const organizer = String(row.organizer ?? "").trim();
  const title = String(row.title ?? "").trim();
  // "Eyebeam: Democracy Machine Fellowship" listed by an aggregator: the
  // organization named before the colon.
  const aggregator = AGGREGATOR_ORGANIZER.test(organizer);
  const lead = title.split(/\s*[:|]\s+/)[0];
  const name = organizer && !GENERIC_NAME.test(organizer) && !aggregator
    ? organizer
    : aggregator && lead.length >= 4 ? lead : title;
  return name.replace(/\s*[|–—-]\s*(?:home|homepage|official site)$/iu, "").slice(0, 120);
}

/** Search text for a name: the name, what it is, and where. */
export function resolverQuery(name, { category = null, location = null } = {}) {
  const kind = /grant|fund/i.test(category ?? "") ? "film fund"
    : /residen/i.test(category ?? "") ? "artist residency"
      : /AI film/i.test(category ?? "") ? "AI film festival"
        : /platform|challenge/i.test(category ?? "") ? "film challenge" : "film festival";
  const words = new Set(seriesKey(name).split(" "));
  const kindWords = kind.split(" ").filter((word) => !words.has(word) && !name.toLowerCase().includes(word));
  const place = String(location ?? "").trim();
  return [name, kindWords.join(" "), place && !NO_PLACE.test(place) ? place : "", "official website"].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** The fetched homepage names the series in its title, site name or main heading. */
export function pageNamesSeries(page, name) {
  const html = String(page?.html ?? "");
  const title = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html)?.[1] ?? "";
  const site = /<meta\b[^>]*(?:property|name)=["']og:site_name["'][^>]*content=["']([^"']{1,200})["']/i.exec(html)?.[1] ?? "";
  const heading = /<h1\b[^>]*>([\s\S]{1,300}?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, " ") ?? "";
  const haystack = seriesKey(`${title} ${site} ${heading}`);
  const wanted = seriesKey(name).split(" ").filter((token) => token.length >= 3);
  if (!wanted.length) return false;
  const shared = wanted.filter((token) => haystack.includes(token)).length;
  return shared / wanted.length >= 0.5;
}

/** A site registered as a monitored series source (the monitor reads it from now). */
export function resolvedSourceRow({ name, url, category, origin }) {
  const ai = /AI film/i.test(category ?? "");
  const family = /grant|fund/i.test(category ?? "") ? "film-funding"
    : /residen/i.test(category ?? "") ? "media-art-residency"
      : ai ? "ai-creative-tech" : "official-site";
  return {
    name: name.slice(0, 200),
    url,
    tier: 2,
    priority: ai ? 1 : 2,
    source_type: "official",
    source_family: family,
    opportunity_categories: ai ? ["ai-film"] : family === "film-funding" ? ["grant"] : family === "media-art-residency" ? ["residency"] : ["film-festival"],
    adapter: "link-window",
    adapter_config: { checkpoint_key: "default", link_window_size: 6, seed: `resolver:${origin}` },
    min_poll_interval_minutes: 360,
    poll_interval_minutes: 1_440,
    max_poll_interval_minutes: 10_080,
    next_check_at: new Date().toISOString(),
  };
}
