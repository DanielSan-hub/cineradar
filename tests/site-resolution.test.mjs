import assert from "node:assert/strict";
import { test } from "node:test";

import { exaListPriceUsd, estimateExaReservation, estimateExaSearch } from "../scripts/cineradar/cost-control.mjs";
import { EXA_NO_CHARGE } from "../scripts/cineradar/exa.mjs";
import { pickOfficialSite } from "../scripts/cineradar/registry-seeds.mjs";
import { pageNamesSeries, RESOLVER_EXCLUDE, resolvedSourceRow, resolverName, resolverQuery } from "../scripts/cineradar/site-resolution.mjs";
import { tavilyCredits } from "../scripts/cineradar/tavily.mjs";

test("Exa is priced by request shape and its refusals are never billed", () => {
  assert.equal(exaListPriceUsd({ type: "instant", numResults: 10 }), 0.004);
  assert.equal(exaListPriceUsd({ type: "auto", numResults: 10 }), 0.007);
  assert.equal(exaListPriceUsd({ type: "auto", numResults: 20 }), 0.017);
  assert.throws(() => exaListPriceUsd({ type: "neural" }));
  assert.equal(estimateExaSearch({}, { type: "instant" }).cost_usd, 0.004);
  assert.equal(estimateExaSearch({ costDollars: { total: 0.005 } }).cost_usd, 0.005);
  // The reservation never falls below the historical flat amount.
  assert.equal(estimateExaReservation({ type: "instant" }).cost_usd, 0.01);
  assert.equal(estimateExaReservation({ type: "deep" }).cost_usd, 0.012);
  for (const status of [400, 401, 402, 403, 422, 429]) assert.ok(EXA_NO_CHARGE.has(status), String(status));
  assert.ok(!EXA_NO_CHARGE.has(500));
});

test("Tavily basic searches cost one credit, advanced two", () => {
  assert.equal(tavilyCredits("basic"), 1);
  assert.equal(tavilyCredits("advanced"), 2);
});

test("a record is searched by its organizer, or by the organization an aggregator names", () => {
  assert.equal(resolverName({ organizer: "Kinofest Lünen", title: "Kinofest 2027 Call" }), "Kinofest Lünen");
  assert.equal(resolverName({ organizer: "Unknown organizer", title: "Patagonia Screen" }), "Patagonia Screen");
  assert.equal(resolverName({ organizer: "On the Move", title: "Eyebeam: Democracy Machine Fellowship Open Call" }), "Eyebeam");
  assert.equal(resolverQuery("SINISTER Horror Film Festival", { location: "Unspecified" }), "SINISTER Horror Film Festival official website");
  assert.equal(resolverQuery("Bagri Foundation", { category: "Grant", location: "London, UK" }), "Bagri Foundation film fund London, UK official website");
  assert.ok(RESOLVER_EXCLUDE.includes("filmfreeway.com"));
});

test("a found site counts only when its domain and its own page name the series", () => {
  const results = [
    { url: "https://www.imdb.com/event/kinofest", title: "Kinofest Lünen" },
    { url: "https://news.example.com/kinofest-2026", title: "Kinofest Lünen opens" },
    { url: "https://www.kinofest-luenen.de/", title: "Kinofest Lünen" },
  ];
  assert.equal(pickOfficialSite("Kinofest Lünen", results), "https://www.kinofest-luenen.de/");
  assert.equal(pageNamesSeries({ html: "<title>Kinofest Lünen – Festival für deutsches Kino</title>" }, "Kinofest Lünen"), true);
  assert.equal(pageNamesSeries({ html: "<title>Domain for sale</title>" }, "Kinofest Lünen"), false);
  const row = resolvedSourceRow({ name: "Kinofest Lünen", url: "https://www.kinofest-luenen.de/", category: "Traditional festival", origin: "tavily" });
  assert.equal(row.adapter_config.seed, "resolver:tavily");
  assert.equal(row.source_family, "official-site");
  assert.equal(resolvedSourceRow({ name: "X", url: "https://x.ai/", category: "AI film festival", origin: "exa" }).priority, 1);
});

test("resolver precision: aggregators and generic words never tie a domain to a name", async () => {
  const { hostNamesSeries, siteRoot } = await import("../scripts/cineradar/site-resolution.mjs");
  assert.equal(hostNamesSeries("A4 Residency Art Center", "https://www.artconnect.com/opportunity/x"), false);
  assert.equal(hostNamesSeries("Kinofest Lünen", "https://www.kinofest-luenen.de/"), true);
  assert.equal(hostNamesSeries("Sedona International Film Festival", "https://sedonafilmfestival.com/"), true);
  // The page must name the series, not merely share one word with it.
  assert.equal(pageNamesSeries({ html: "<title>Sinister Creature Con</title>" }, "SINISTER Horror Film Festival"), false);
  assert.equal(pageNamesSeries({ html: "<title>Sinister Horror Film Festival 2026</title>" }, "SINISTER Horror Film Festival"), true);
  assert.equal(siteRoot("https://www.asymmetryart.org/public-programme/schedule"), "https://www.asymmetryart.org/");
});

test("lead feeds give only names of film, video and AI calls; the call page may sit on the organizer's site", async () => {
  const { leadCallPage, leadName, parseRssItems, relevantLead } = await import("../scripts/cineradar/lead-feeds.mjs");
  const items = parseRssItems(`<rss><channel><item><title>Concorso artistico sull&#8217;intelligenza artificiale &#8220;AI Horizons&#8221;: 6.000 euro di premi</title><link>https://www.ticonsiglio.com/ai-horizons/</link></item><item><title>Concorso fotografico Raccont&#8217;Arti 2026, premi fino a 3mila euro</title><link>https://www.ticonsiglio.com/x/</link></item><item><title>Accordi Disaccordi, Concorso internazionale di cortometraggi</title><link>https://www.ticonsiglio.com/y/</link></item></channel></rss>`);
  assert.deepEqual(items.filter((item) => relevantLead(item.title)).map((item) => leadName(item.title)), ["AI Horizons", "Accordi Disaccordi"]);
  assert.equal(leadCallPage("AI Horizons", { url: "https://parma360festival.it/wp-content/uploads/2026/05/Call-AI-HORIZONS.-Call-for-Artists-eng.pdf", title: "CALL FOR ARTISTS: AI Horizons" }), true);
  // News articles and the lead's own site never count.
  assert.equal(leadCallPage("AI Horizons", { url: "https://www.initaly.it/en/articolo/ai-horizons-call", title: "AI Horizons" }), false);
  assert.equal(leadCallPage("AI Horizons", { url: "https://www.ticonsiglio.com/wp-content/uploads/2026/08/bando-call-ai-horizon.pdf", title: "bando" }, { exclude: ["ticonsiglio.com"] }), false);
});
