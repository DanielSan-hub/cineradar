import assert from "node:assert/strict";
import { test } from "node:test";

import { futureDateMentions, scoreCallSignal } from "../scripts/cineradar/call-signal.mjs";
import { createRobotsChecker, isPathAllowed, parseRobots } from "../scripts/cineradar/robots.mjs";
import {
  chapman,
  datasetCategories,
  hostOf,
  isHeldOut,
  isPlatformHost,
  mergeSeedSources,
  seriesKey,
  sourceFromDatasetRow,
  sourceFromPortalRow,
  sourceFromWikidata,
  staggeredFirstCheck,
} from "../scripts/cineradar/registry-seeds.mjs";

const NOW = Date.parse("2026-09-28T10:00:00Z");

test("call signal passes real calls in several languages", () => {
  const pages = [
    "Call for entries: submit your short film. Final deadline: October 15, 2026.",
    "Bando 2027 – iscrizioni aperte fino al 30 novembre 2026. Regolamento completo.",
    "Convocatoria abierta. Fecha límite: 15 de diciembre de 2026.",
    "Appel à films 2027 : date limite le 10 janvier 2027.",
    "Ausschreibung für Kurzfilme. Einreichschluss: 15. Dezember 2026.",
    "2027年度 映像作品 公募 締切 2026年12月1日",
    "2026 단편영화 공모 마감 2026년 11월 30일",
    "Инсайт: приём заявок до 01.12.2026",
  ];
  for (const text of pages) {
    const signal = scoreCallSignal(text, { now: NOW });
    assert.equal(signal.pass, true, text);
    assert.ok(signal.futureDates >= 1, text);
  }
});

test("call signal discards pages without a current call", () => {
  const pages = [
    "Welcome to our festival. Watch the 2019 winners and read our history.",
    "Our programme and tickets. © 2026 Example Festival. All rights reserved.",
    "Submission deadline was March 3, 2024. See you next time.",
    "About us – contact – privacy policy",
  ];
  for (const text of pages) assert.equal(scoreCallSignal(text, { now: NOW }).pass, false, text);
});

test("call signal flags closed calls and ignores out-of-window dates", () => {
  const closed = scoreCallSignal("Submissions are now closed. Deadline: 1 November 2026.", { now: NOW });
  assert.equal(closed.closed, true);
  assert.ok(closed.score < scoreCallSignal("Submissions are now open. Deadline: 1 November 2026.", { now: NOW }).score);
  assert.deepEqual(futureDateMentions("Deadline 2020-01-01 and 2031-01-01", { now: NOW }), []);
  assert.equal(futureDateMentions("deadline 2026-02-30", { now: NOW }).length, 0);
  // Ambiguous numeric dates keep both readings; one in-window reading counts.
  assert.equal(futureDateMentions("closes 11/10/2026", { now: NOW }).length, 2);
});

test("robots parsing follows RFC 9309 group and longest-match rules", () => {
  const robots = parseRobots([
    "User-agent: *",
    "Disallow: /private",
    "Allow: /private/calls",
    "Disallow: /*.pdf$",
    "Crawl-delay: 20",
    "",
    "User-agent: OtherBot",
    "Disallow: /",
  ].join("\n"));
  assert.equal(robots.crawlDelay, 20);
  assert.equal(isPathAllowed(robots, "/festival/submit"), true);
  assert.equal(isPathAllowed(robots, "/private/team"), false);
  assert.equal(isPathAllowed(robots, "/private/calls/2027"), true);
  assert.equal(isPathAllowed(robots, "/rules.pdf"), false);
  assert.equal(isPathAllowed(robots, "/rules.pdf?x=1"), true);
  const own = parseRobots("User-agent: CineRadarBot\nDisallow: /\n\nUser-agent: *\nAllow: /");
  assert.equal(isPathAllowed(own, "/"), false);
});

test("robots checker caches per origin and fails closed on server errors", async () => {
  const calls = [];
  const responses = {
    "https://a.test/robots.txt": new Response("User-agent: *\nDisallow: /no", { status: 200 }),
    "https://b.test/robots.txt": new Response("missing", { status: 404 }),
    "https://c.test/robots.txt": new Response("oops", { status: 503 }),
  };
  const check = createRobotsChecker({
    fetchImpl: async (url) => {
      calls.push(url);
      return responses[url].clone();
    },
  });
  assert.equal((await check("https://a.test/yes")).allowed, true);
  assert.equal((await check("https://a.test/no/x")).allowed, false);
  assert.equal((await check("https://b.test/anything")).allowed, true);
  assert.deepEqual(await check("https://c.test/"), { allowed: false, reason: "ROBOTS_UNREACHABLE" });
  assert.equal(calls.filter((url) => url.startsWith("https://a.test")).length, 1);
});

test("series keys are edition-agnostic", () => {
  assert.equal(seriesKey("15th Athens International Digital Film Festival – AIDFF"), seriesKey("Athens Digital Film Festival AIDFF 2027"));
  assert.equal(seriesKey("FeatureLab 2027"), seriesKey("FeatureLab"));
  assert.notEqual(seriesKey("Tribeca Festival"), seriesKey("Sundance Film Festival"));
});

test("hold-out is deterministic and close to 20%", () => {
  const keys = Array.from({ length: 5000 }, (_, index) => `series ${index}`);
  const held = keys.filter((key) => isHeldOut(key));
  assert.ok(held.length > 900 && held.length < 1100, `held out ${held.length}`);
  assert.deepEqual(keys.filter((key) => isHeldOut(key)), held);
  assert.equal(isHeldOut(""), false);
});

test("dataset rows become sources for the series' own site, never platforms", () => {
  const row = {
    event_series: "Example Shorts",
    category_primary: "Short film festival / competition",
    status_at_2026_09_25: "OPEN",
    official_url: "https://filmfreeway.com/ExampleShorts",
    source_url: "https://exampleshorts.org/call",
    source_language: "English",
  };
  const source = sourceFromDatasetRow(row, { dataset: "census#Dataset", now: NOW });
  assert.equal(source.url, "https://exampleshorts.org/call");
  assert.equal(source.priority, 1);
  assert.equal(source.language, "en");
  assert.ok(source.opportunity_categories.includes("short-film"));
  assert.ok(Date.parse(source.next_check_at) - NOW <= 86_400_000);
  assert.equal(sourceFromDatasetRow({ official_url: "https://filmfreeway.com/X" }, { now: NOW }), null);
  assert.ok(isPlatformHost("filmfreeway.com") && isPlatformHost("app.submittable.com"));
  assert.equal(hostOf("https://www.Example.org/a"), "example.org");
});

test("wikidata and portal rows respect poll interval constraints", () => {
  const rows = [
    sourceFromWikidata({ id: "Q1", site: "https://fest.example.net", label: "Fest", country: "IT" }, { now: NOW }),
    sourceFromPortalRow({ portal_or_board: "Arts portal", url: "https://portal.example.net/calls", language: "ja", what_it_surfaces: "open calls board" }, { dataset: "hidden#Local channels", now: NOW }),
  ];
  for (const row of rows) {
    assert.ok(row.min_poll_interval_minutes >= 15);
    assert.ok(row.min_poll_interval_minutes <= row.poll_interval_minutes);
    assert.ok(row.poll_interval_minutes <= row.max_poll_interval_minutes);
    assert.ok(row.tier >= 1 && row.tier <= 3 && row.priority >= 1 && row.priority <= 5);
  }
  assert.equal(rows[1].source_family, "opportunity-directory");
  // Every seed row must share one key set for PostgREST bulk upserts.
  const dataset = sourceFromDatasetRow({ event_series: "X", source_url: "https://x.example.net" }, { now: NOW });
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(dataset).sort());
  assert.deepEqual(Object.keys(rows[1]).sort(), Object.keys(dataset).sort());
});

test("merging seeds keeps the strongest schedule and unions categories", () => {
  const a = sourceFromWikidata({ id: "Q2", site: "https://same.example.net/", label: "Same" }, { now: NOW });
  const b = sourceFromDatasetRow({ event_series: "Same", category_primary: "Animation festival", status_at_2026_09_25: "OPEN", official_url: "https://same.example.net/" }, { now: NOW });
  const [merged] = mergeSeedSources([a, b, null]);
  assert.equal(merged.priority, 1);
  assert.ok(merged.opportunity_categories.includes("animation") && merged.opportunity_categories.includes("film-festival"));
  assert.ok(merged.min_poll_interval_minutes <= merged.poll_interval_minutes && merged.poll_interval_minutes <= merged.max_poll_interval_minutes);
});

test("first checks are spread and categories map from dataset labels", () => {
  const times = new Set(Array.from({ length: 50 }, (_, index) => staggeredFirstCheck(`https://s${index}.example.net`, { now: NOW, spreadDays: 14 })));
  assert.ok(times.size > 40);
  assert.deepEqual(datasetCategories("AI film festival / genAI competition").slice(0, 1), ["ai-film"]);
  assert.ok(datasetCategories("production_grant").includes("grant"));
  assert.ok(datasetCategories("residency").includes("residency"));
  assert.equal(chapman(100, 100, 50), 199);
});

test("official-site picking skips platforms and requires a name match", async () => {
  const { pickOfficialSite } = await import("../scripts/cineradar/registry-seeds.mjs");
  const results = [
    { url: "https://filmfreeway.com/NightOwlShorts", title: "Night Owl Shorts - FilmFreeway" },
    { url: "https://www.imdb.com/event/ev123", title: "Night Owl Shorts Festival - IMDb" },
    { url: "https://example-news.com/article", title: "Ten festivals to submit to" },
    { url: "https://nightowlshorts.org/submit", title: "Submit | Night Owl Shorts" },
  ];
  assert.equal(pickOfficialSite("Night Owl Shorts 2026", results), "https://nightowlshorts.org/submit");
  assert.equal(pickOfficialSite("Night Owl Shorts", results.slice(0, 3)), null);
  assert.equal(pickOfficialSite("Tribeca", [{ url: "https://news.example.org/tribeca", title: "Tribeca news" }]), null);
  assert.equal(pickOfficialSite("Tribeca", [{ url: "https://tribecafilm.com/festival", title: "Festival" }]), "https://tribecafilm.com/festival");
  // Listings, news and similarly named organisations are rejected by the host rule.
  const british = [
    { url: "https://www.festivalreel.com/british-documentary-film-festival", title: "British Documentary Film Festival" },
    { url: "https://www.bifa.film/", title: "British Independent Film Awards" },
  ];
  assert.equal(pickOfficialSite("British Independent Film Festival", british), null);
  assert.equal(pickOfficialSite("Entre Deux Cannes", [{ url: "https://www.nicematin.com/culture/entre-deux-cannes", title: "Entre Deux Cannes le festival" }]), null);
  // Acronym domains are accepted.
  assert.equal(pickOfficialSite("Burano Artificial Intelligence Film Festival", [{ url: "https://baiff.eu/", title: "Burano Artificial Intelligence Film Festival" }]), "https://baiff.eu/");
  assert.equal(pickOfficialSite("Amsterdam Lift-Off Film Festival", [{ url: "https://liftoff.network/amsterdam/", title: "Amsterdam Lift-Off Film Festival" }]), "https://liftoff.network/amsterdam/");
});
