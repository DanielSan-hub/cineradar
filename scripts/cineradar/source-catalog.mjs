function source(
  name,
  url,
  {
    tier = 2,
    priority = tier,
    enabled = true,
    sourceType = "official",
    sourceFamily = "official-site",
    country = null,
    region = "global",
    language = "en",
    categories = [],
    adapter = "generic",
    adapterConfig = {},
    pollMinutes = 4_320,
    minPollMinutes = 360,
    maxPollMinutes = 43_200,
  } = {},
) {
  return {
    name,
    url,
    tier,
    enabled,
    source_type: sourceType,
    source_family: sourceFamily,
    country,
    region,
    language,
    opportunity_categories: categories,
    priority,
    adapter,
    adapter_config: adapterConfig,
    min_poll_interval_minutes: minPollMinutes,
    poll_interval_minutes: pollMinutes,
    max_poll_interval_minutes: maxPollMinutes,
  };
}

const aiWatch = {
  tier: 1,
  priority: 1,
  sourceFamily: "ai-creative-tech",
  categories: ["ai-film", "platform-challenge"],
  adapter: "link-window",
  adapterConfig: { checkpoint_key: "official-news", link_window_size: 4 },
  pollMinutes: 720,
  minPollMinutes: 360,
  maxPollMinutes: 10_080,
};
const festivalDirectory = {
  tier: 1,
  priority: 1,
  sourceType: "community",
  sourceFamily: "structured-festival",
  categories: ["film-festival", "short-film", "animation", "music-video"],
  adapter: "link-window",
  adapterConfig: { checkpoint_key: "current-listing", link_window_size: 6 },
  pollMinutes: 1_440,
};
const funding = {
  tier: 1,
  priority: 2,
  sourceFamily: "film-funding",
  categories: ["grant", "lab-fellowship"],
  adapter: "link-window",
  adapterConfig: { checkpoint_key: "funding-calls", link_window_size: 4 },
  pollMinutes: 4_320,
};
const mediaArt = {
  tier: 1,
  priority: 2,
  sourceFamily: "media-art-residency",
  categories: ["experimental-new-media", "residency"],
  adapter: "link-window",
  adapterConfig: { checkpoint_key: "open-calls", link_window_size: 4 },
  pollMinutes: 2_880,
};

// Persistent discovery entry points only. These are directories, official
// calendars, programme pages and company newsrooms; they are never seeded as
// opportunity rows. New productive sources are added at runtime on probation.
export const sourceCatalog = [
  source("Runway News", "https://runway.com/news", aiWatch),
  source("Higgsfield", "https://higgsfield.ai", aiWatch),
  source("Luma AI News", "https://lumalabs.ai/news", aiWatch),
  source("Kling AI Blog", "https://kling.ai/blog", aiWatch),
  source("Adobe Creative Cloud Blog", "https://blog.adobe.com/", { ...aiWatch, priority: 2 }),
  source("Google Arts & Culture", "https://artsandculture.google.com/", { ...aiWatch, priority: 2 }),

  // FilmFreeway blocks the normal HTTP monitor (403). Keep the known source
  // disabled; never bypass its access controls.
  source("FilmFreeway Festivals", "https://filmfreeway.com/festivals", {
    ...festivalDirectory,
    enabled: false,
  }),
  source("Festhome Festivals", "https://festhome.com/festivals", festivalDirectory),
  source("Shortfilmdepot", "https://shortfilmdepot.com/en", festivalDirectory),

  source("On the Move Open Calls", "https://on-the-move.org/news", {
    ...mediaArt,
    priority: 1,
    region: "global",
    sourceFamily: "opportunity-directory",
    categories: ["experimental-new-media", "residency", "grant"],
    adapterConfig: {
      checkpoint_key: "open-calls",
      cursor_kind: "page",
      page_param: "page",
      page_base: 0,
      max_pages: 50,
      link_window_size: 8,
    },
    pollMinutes: 1_440,
  }),
  source("AIR_J Residency Directory", "https://air-j.info/", {
    ...mediaArt,
    country: "Japan",
    region: "asia",
    language: "ja",
    sourceFamily: "opportunity-directory",
    categories: ["residency", "experimental-new-media"],
    pollMinutes: 1_440,
  }),
  source("European Media Art Platform", "https://emare.eu/", {
    ...mediaArt,
    region: "europe",
    categories: ["experimental-new-media", "residency"],
  }),
  source("RIXC News", "https://rixc.org/en/home___/", {
    ...mediaArt,
    country: "Latvia",
    region: "europe",
  }),
  source("Frame Finland Open Calls", "https://frame-finland.fi/en/category/open-call/", {
    ...mediaArt,
    country: "Finland",
    region: "europe",
    categories: ["experimental-new-media", "grant", "residency"],
    pollMinutes: 4_320,
  }),
  source("Tokyo Arts and Space Open Calls", "https://tokyoartsandspace.jp/application/index.html", {
    ...mediaArt,
    country: "Japan",
    region: "asia",
    language: "ja",
    priority: 1,
    pollMinutes: 1_440,
  }),
  source("Kyoto Art Center Open Calls", "https://www.kac.or.jp/en/open_call/", {
    ...mediaArt,
    country: "Japan",
    region: "asia",
    language: "ja",
  }),
  source("Asia Culture Center Open Calls", "https://www.acc.go.kr/en/board/board.do?PID=1001", {
    ...mediaArt,
    country: "South Korea",
    region: "asia",
    language: "ko",
    priority: 1,
    pollMinutes: 1_440,
  }),

  source("Ars Electronica News", "https://ars.electronica.art/news/en/", mediaArt),
  source("Sundance Submit", "https://www.sundance.org/festivals/sundance-film-festival/submit/", {
    tier: 1, priority: 1, sourceFamily: "official-site", region: "usa-canada",
    country: "United States", categories: ["film-festival", "lab-fellowship"], pollMinutes: 2_880,
  }),
  source("Tribeca Submissions", "https://tribecafilm.com/festival/submissions", {
    tier: 1, priority: 1, sourceFamily: "official-site", region: "usa-canada",
    country: "United States", categories: ["film-festival", "short-film", "experimental-new-media"], pollMinutes: 2_880,
  }),
  source("BFI Funding", "https://www.bfi.org.uk/get-funding-support", {
    ...funding, country: "United Kingdom", region: "europe",
  }),
  source("Screen Australia Funding", "https://www.screenaustralia.gov.au/funding-overview/", {
    ...funding, country: "Australia", region: "oceania",
  }),
  source("New Zealand Film Commission Funding", "https://www.nzfilm.co.nz/funding-support-nz-filmmakers/funding", {
    ...funding, country: "New Zealand", region: "oceania",
  }),
  source("Canada Council Grants", "https://canadacouncil.ca/funding/grants", {
    ...funding, country: "Canada", region: "usa-canada",
  }),
  source("SFFILM Opportunities", "https://sffilm.org/artist-development/fund-your-film/", {
    ...funding, country: "United States", region: "usa-canada",
  }),
  source("TorinoFilmLab Labs", "https://www.torinofilmlab.it/labs", {
    ...funding, country: "Italy", region: "europe", categories: ["lab-fellowship"],
  }),
  source("Onassis Open Calls", "https://www.onassis.org/open-calls", {
    ...mediaArt, country: "Greece", region: "europe",
  }),
  source("Annecy Film Submissions", "https://www.annecyfestival.com/take-part/submit-a-film", {
    tier: 1, priority: 1, sourceFamily: "official-site", country: "France", region: "europe",
    categories: ["animation", "film-festival"], pollMinutes: 2_880,
  }),
  source("Doha Film Institute Grants", "https://www.dohafilminstitute.com/financing/grants/", {
    ...funding, country: "Qatar", region: "middle-east", priority: 1,
  }),
  source("Singapore IMDA Media Grants", "https://www.imda.gov.sg/how-we-can-help/media-manpower-plan/grants-and-schemes", {
    ...funding, country: "Singapore", region: "asia",
  }),
  source("Programa Ibermedia Calls", "https://www.programaibermedia.com/convocatorias/", {
    ...funding, region: "latin-america", language: "es", priority: 1,
  }),

  // Existing geographically disambiguated learned sources. They remain
  // registry entries; query construction never receives their event names.
  source("Athens International Film Festival Greece", "https://en.aiff.gr/", {
    tier: 1, priority: 2, sourceFamily: "official-site", country: "Greece", region: "europe", categories: ["film-festival"],
  }),
  source("Athens International Digital Film Festival", "https://aidff.com/en/teleftaia-nea/252-15o-festival-psifiakoy-kinimatografou-athinas-aidff/428-15th-athens-international-digital-film-festival-aidff-3-9-december-2026-athens-greece-film-and-screenplay-submissions-close-on-1-october-2026", {
    tier: 1, priority: 2, sourceFamily: "official-site", country: "Greece", region: "europe", categories: ["film-festival", "experimental-new-media"],
  }),
  source("AI Filmfest Athens", "https://www.aifilmfestathens.gr/en", {
    tier: 1, priority: 2, sourceFamily: "ai-creative-tech", country: "Greece", region: "europe", categories: ["ai-film", "film-festival"],
  }),
  source("KINO Athens Submissions", "https://kinoathens.org/submissions/", {
    tier: 1, priority: 2, sourceFamily: "official-site", country: "Greece", region: "europe", categories: ["film-festival", "short-film"],
  }),
  source("Athens Short Film Festival", "https://www.athensshortfilmfest.com/", {
    tier: 1, priority: 2, sourceFamily: "official-site", country: "Greece", region: "europe", categories: ["short-film"],
  }),
  source("Athens Animfest", "https://athensanimfest.eu/", {
    tier: 1, priority: 2, sourceFamily: "official-site", country: "Greece", region: "europe", categories: ["animation"],
  }),
  source("Athens Digital Arts Festival", "https://www.adaf.gr/", {
    ...mediaArt, country: "Greece", region: "europe",
  }),
  source("Athens International Film and Video Festival Ohio", "https://athensfilmfest.org/submit/", {
    tier: 1, priority: 2, sourceFamily: "official-site", country: "United States", region: "usa-canada", categories: ["film-festival", "experimental-new-media"],
  }),
  source("Athens Film Festival Georgia", "https://athensfilm.com/submissions", {
    tier: 1, priority: 2, sourceFamily: "official-site", country: "United States", region: "usa-canada", categories: ["film-festival"],
  }),
];
