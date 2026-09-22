// Discovery/monitoring entry points, not prebuilt opportunity rows. Keep only
// URLs that were actually found as publisher, programme or submission pages.
export const sourceCatalog = [
  ["Runway News", "https://runway.com/news", 1, "official"],
  ["Higgsfield", "https://higgsfield.ai", 1, "official"],
  ["Luma AI News", "https://lumalabs.ai/news", 1, "official"],
  ["Adobe Creative Cloud Blog", "https://blog.adobe.com/", 2, "official"],
  ["Google Arts & Culture", "https://artsandculture.google.com/", 2, "official"],
  // Exa can index FilmFreeway, but its directory returns 403 to the monitor bot.
  ["FilmFreeway Festivals", "https://filmfreeway.com/festivals", 2, "community", false],
  ["Festhome Festivals", "https://festhome.com/festivals", 2, "community"],
  ["Shortfilmdepot", "https://shortfilmdepot.com/en", 2, "community"],
  ["Ars Electronica", "https://ars.electronica.art/news/en/", 1, "official"],
  ["Sundance Submit", "https://www.sundance.org/festivals/sundance-film-festival/submit/", 1, "official"],
  ["Tribeca Submissions", "https://tribecafilm.com/festival/submissions", 1, "official"],
  ["BFI Funding", "https://www.bfi.org.uk/get-funding-support", 1, "official"],
  ["Screen Australia Funding", "https://www.screenaustralia.gov.au/funding-overview/", 1, "official"],
  ["Canada Council Grants", "https://canadacouncil.ca/funding/grants", 1, "official"],
  ["SFFILM Opportunities", "https://sffilm.org/artist-development/fund-your-film/", 1, "official"],
  ["TorinoFilmLab Labs", "https://www.torinofilmlab.it/labs", 1, "official"],
  ["Onassis Open Calls", "https://www.onassis.org/open-calls", 1, "official"],
  // Athens, Greece; intentionally separate from same-name festivals in the US.
  ["Athens International Film Festival Greece", "https://en.aiff.gr/", 1, "official"],
  ["Athens International Digital Film Festival", "https://aidff.com/en/teleftaia-nea/252-15o-festival-psifiakoy-kinimatografou-athinas-aidff/428-15th-athens-international-digital-film-festival-aidff-3-9-december-2026-athens-greece-film-and-screenplay-submissions-close-on-1-october-2026", 1, "official"],
  ["AI Filmfest Athens", "https://www.aifilmfestathens.gr/en", 1, "official"],
  ["KINO Athens Submissions", "https://kinoathens.org/submissions/", 1, "official"],
  ["Athens Short Film Festival", "https://www.athensshortfilmfest.com/", 1, "official"],
  ["Athens Animfest", "https://athensanimfest.eu/", 1, "official"],
  ["Athens Digital Arts Festival", "https://www.adaf.gr/", 1, "official"],
  // Disambiguation controls: Athens, Ohio and Athens, Georgia.
  ["Athens International Film and Video Festival Ohio", "https://athensfilmfest.org/submit/", 1, "official"],
  ["Athens Film Festival Georgia", "https://athensfilm.com/submissions", 1, "official"],
].map(([name, url, tier, source_type, enabled = true]) => ({
  name,
  url,
  tier,
  enabled,
  source_type,
}));
