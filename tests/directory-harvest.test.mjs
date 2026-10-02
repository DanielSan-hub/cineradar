import assert from "node:assert/strict";
import { test } from "node:test";

import { isAiFilmText, isAiSource, scoreCallSignal } from "../scripts/cineradar/call-signal.mjs";
import {
  baseDomain,
  detailUrls,
  harvestedSource,
  jsonLdOfficialLinks,
  officialCandidates,
  parseSitemapLocs,
} from "../scripts/cineradar/directory-harvest.mjs";
import { cloudflareThrottle } from "../scripts/cineradar/llm.mjs";
import { selectSourceOpportunityLinks } from "../scripts/cineradar/web-validation.mjs";

const NOW = Date.parse("2026-10-02T10:00:00Z");

test("sitemap detail pages exclude listings and other hosts", () => {
  const locs = parseSitemapLocs(`<urlset>
    <url><loc>https://aifilmcontests.com/contests/festiav-valencia-2026</loc></url>
    <url><loc>https://aifilmcontests.com/contests/closing-soon</loc></url>
    <url><loc>https://aifilmcontests.com/guide/how-to-enter</loc></url>
    <url><loc>https://aifilmcontests.com/contests</loc></url>
    <url><loc>https://other.example/contests/x</loc></url>
  </urlset>`);
  assert.equal(locs.length, 5);
  assert.deepEqual(detailUrls(locs, "aifilmcontests.com"), [
    "https://aifilmcontests.com/contests/festiav-valencia-2026",
  ]);
});

test("official candidates come from JSON-LD first, never from FilmFreeway or social hosts", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Event",
    "name":"FESTIAV 2026","url":"https://www.festiav.com/",
    "organizer":{"@type":"Organization","name":"Galaxia","url":"https://www.festiav.com/"}}</script>`;
  assert.equal(jsonLdOfficialLinks(html).length, 2);
  const { candidates, platformOnly } = officialCandidates({
    html,
    linkRecords: [
      { url: "https://www.instagram.com/festiav", text: "Official Instagram" },
      { url: "https://aifilmcontests.com/contests/free", text: "Visit more contests" },
    ],
    pageUrl: "https://aifilmcontests.com/contests/festiav-valencia-2026",
    directoryHost: "aifilmcontests.com",
    directoryHosts: new Set(["aifilmcontests.com"]),
  });
  assert.deepEqual(candidates.map((item) => item.url), ["https://www.festiav.com/"]);
  assert.equal(platformOnly, false);

  const filmFreewayOnly = officialCandidates({
    html: `<script type="application/ld+json">{"@type":"Event","name":"AI Toronto Shorts","url":"https://filmfreeway.com/AIToronto"}</script>`,
    linkRecords: [],
    pageUrl: "https://aifilmcontests.com/contests/ai-toronto",
    directoryHost: "aifilmcontests.com",
    directoryHosts: new Set(),
  });
  assert.deepEqual(filmFreewayOnly.candidates, []);
  assert.equal(filmFreewayOnly.platformOnly, true);

  const pdf = officialCandidates({
    html: "",
    linkRecords: [{ url: "https://animac.example/media/GUIDELINES-2026.pdf", text: "Submit: guidelines" }],
    pageUrl: "https://asianfilmfestivals.com/festival/animac",
    directoryHost: "asianfilmfestivals.com",
  });
  assert.deepEqual(pdf.candidates, []);
});

test("one candidate per registrable domain, and harvested sources are monitored at once", () => {
  assert.equal(baseDomain("filmmakers.festhome.com"), "festhome.com");
  assert.equal(baseDomain("www.bfi.org.uk"), "bfi.org.uk");
  const { candidates } = officialCandidates({
    html: `<script type="application/ld+json">{"@type":"Event","name":"LifeArt",
      "url":"https://filmmakers.festhome.com/en/festival/lifeart",
      "organizer":{"name":"Festhome","url":"https://festhome.com/en/festival/lifeart"}}</script>`,
    linkRecords: [],
    pageUrl: "https://aifilmcontests.com/contests/lifeart",
    directoryHost: "aifilmcontests.com",
  });
  assert.equal(candidates.length, 1);
  const row = harvestedSource(candidates[0], { ai: true, directoryHost: "aifilmcontests.com", now: NOW });
  assert.equal(row.source_family, "ai-creative-tech");
  assert.deepEqual(row.opportunity_categories, ["ai-film"]);
  assert.equal(row.next_check_at, new Date(NOW).toISOString());
  assert.equal(row.adapter_config.found_via, "aifilmcontests.com");
});

test("AI film context is recognised from specific phrases only", () => {
  assert.ok(isAiFilmText("FESTIAV 2026 – The Number One AI Film Festival"));
  assert.ok(isAiFilmText("Sin Cámara - Festival de Cortos IA en Español"));
  assert.ok(!isAiFilmText("We use AI chatbots for customer service at our film festival."));
  assert.ok(isAiSource({ source_family: "ai-creative-tech" }));
  assert.ok(isAiSource({ source_family: "official-site", opportunity_categories: ["ai-film"] }));
  assert.ok(!isAiSource({ source_family: "official-site", opportunity_categories: [] }));
});

test("AI sources pass the call gate on a button-style call; others stay strict", () => {
  // Button wording is a call phrase now, for every source.
  assert.equal(scoreCallSignal("MetaMorph AI Award\nSUBMIT NOW\nCategories 2027", { now: NOW }).pass, true);
  const text = "MetaMorph AI Award\nJudges\nCategories 2027";
  assert.equal(scoreCallSignal(text, { now: NOW }).pass, false);
  assert.equal(scoreCallSignal(text, { now: NOW, lenient: true }).pass, true);
  assert.equal(scoreCallSignal("About us. Our team. Contact.", { now: NOW, lenient: true }).pass, false);
});

test("AI sources follow loosely labelled contest links, judged by path and text only", () => {
  const records = [
    { url: "https://www.metamorph-award.com/categories2026", text: "Categories 2027" },
    { url: "https://www.metamorph-award.com/prizes", text: "2026 PRIZES" },
    { url: "https://www.metamorph-award.com/about", text: "About" },
    { url: "https://vigloostudio.com/en/contests/2026-short-drama-festival", text: "See the festival" },
  ];
  const strict = selectSourceOpportunityLinks({ source_family: "official-site" }, records, { sourceUrl: "https://www.metamorph-award.com/", limit: 10 });
  const lenient = selectSourceOpportunityLinks({ source_family: "ai-creative-tech" }, records, { sourceUrl: "https://www.metamorph-award.com/", limit: 10 });
  assert.ok(lenient.length > strict.length);
  assert.ok(lenient.some((link) => link.url.endsWith("/categories2026")));
  assert.ok(!lenient.some((link) => link.url.endsWith("/about")));
});

test("Cloudflare 429 bodies distinguish daily allocation from transient throttling", () => {
  assert.equal(cloudflareThrottle({ errors: [{ code: 3036, message: "Account limited: you have used up your daily free allocation of 10,000 neurons" }] }).exhausted, true);
  assert.equal(cloudflareThrottle({ errors: [{ code: 3040, message: "Capacity temporarily exceeded, please try again." }] }).exhausted, false);
  assert.equal(cloudflareThrottle(null).exhausted, false);
});
