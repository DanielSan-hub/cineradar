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
