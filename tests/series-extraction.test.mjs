import assert from "node:assert/strict";
import { test } from "node:test";

import { applyUrlValidations, normalizeOpportunity } from "../scripts/cineradar/normalization.mjs";
import { createRunMetrics } from "../scripts/cineradar/telemetry.mjs";
import { processFetchedPage } from "../scripts/cineradar/process-page.mjs";
import {
  combinedSeriesPage,
  festivalPlatformLink,
  isSeriesSource,
  pageHasPlatformLink,
  pageHasSubmissionLink,
  seriesCategory,
  seriesEvidence,
  seriesName,
  seriesRawItem,
} from "../scripts/cineradar/series-extraction.mjs";
import { httpFallbackUrl, isAutomationBlockedUrl, validateUrl } from "../scripts/cineradar/web-validation.mjs";

const NOW = Date.parse("2026-10-03T10:00:00Z");
const source = {
  name: "Brooklyn Film Festival",
  url: "https://www.brooklynfilmfestival.org/",
  source_family: "official-site",
  opportunity_categories: ["film-festival"],
  priority: 3,
  adapter_config: { seed: "wikidata" },
};
function page(overrides = {}) {
  return {
    inputUrl: "https://www.brooklynfilmfestival.org/",
    finalUrl: "https://www.brooklynfilmfestival.org/",
    status: "verified",
    httpStatus: 200,
    checkedAt: "2026-10-03T10:00:00.000Z",
    redirectChain: [],
    html: '<html><head><meta property="og:site_name" content="Brooklyn Film Festival"></head></html>',
    text: "Brooklyn Film Festival 2027. Submit your film.",
    links: [],
    linkRecords: [],
    ...overrides,
  };
}

test("only an organizer's own site is a series source", () => {
  assert.equal(isSeriesSource(source), true);
  assert.equal(isSeriesSource({ ...source, source_family: "opportunity-directory" }), false);
  assert.equal(isSeriesSource({ ...source, adapter_config: { seed: "dataset-channel" } }), false);
  assert.equal(isSeriesSource(null), false);
});

test("platform links count only when they point at one festival", () => {
  assert.deepEqual(festivalPlatformLink("https://filmfreeway.com/BrooklynFilmFestival"), { url: "https://filmfreeway.com/BrooklynFilmFestival", platform: "FilmFreeway" });
  assert.equal(festivalPlatformLink("https://filmfreeway.com/"), null);
  assert.equal(festivalPlatformLink("https://filmfreeway.com/festivals"), null);
  assert.equal(festivalPlatformLink("https://filmmakers.festhome.com/en/festival/brooklyn").platform, "Festhome");
  assert.equal(festivalPlatformLink("https://example.org/submit"), null);
  assert.equal(pageHasPlatformLink(page({ linkRecords: [{ url: "https://filmfreeway.com/BrooklynFilmFestival", text: "Submit" }] })), true);
});

test("a festival site linking FilmFreeway becomes a mapped call without opening FilmFreeway", async () => {
  const home = page({
    links: ["https://filmfreeway.com/BrooklynFilmFestival"],
    linkRecords: [{ url: "https://filmfreeway.com/BrooklynFilmFestival", text: "Submit via FilmFreeway" }],
  });
  const evidence = seriesEvidence([home], { title: source.name, now: NOW });
  assert.equal(evidence.platformLink.platform, "FilmFreeway");
  const raw = seriesRawItem({ source, home, pages: [home], evidence, now: NOW });
  assert.equal(raw.title, "Brooklyn Film Festival");
  assert.equal(raw.application_url, "https://filmfreeway.com/BrooklynFilmFestival");
  assert.ok(raw.tags.includes("via-filmfreeway"));

  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response("", { status: 200 });
  };
  const records = await processFetchedPage({
    page: combinedSeriesPage(home, []),
    title: source.name,
    sourceType: "official",
    metrics: createRunMetrics("test"),
    presetItems: [raw],
    fetchImpl,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].application_url, "https://filmfreeway.com/BrooklynFilmFestival");
  assert.equal(records[0].application_url_status, "unchecked");
  assert.equal(records[0].official_url_status, "verified");
  assert.ok(!requested.some((url) => url.includes("filmfreeway")), "FilmFreeway must never be requested");
});

test("a dated deadline on a Rules subpage is read with its quote", () => {
  const home = page();
  const rules = page({ inputUrl: "https://www.brooklynfilmfestival.org/rules", finalUrl: "https://www.brooklynfilmfestival.org/rules", text: "Rules. Final deadline: February 14, 2027." });
  const evidence = seriesEvidence([rules, home], { title: source.name, now: NOW });
  assert.equal(evidence.deadline.deadline, "2027-02-14");
  const raw = seriesRawItem({ source, home, pages: [rules, home], evidence, now: NOW });
  assert.equal(raw.deadline_status, "confirmed");
  assert.equal(raw.deadline_source_url, "https://www.brooklynfilmfestival.org/rules");
  assert.equal(raw.opportunity_year, 2027);
});

test("explicit open or closed statements map the call; silence does not", () => {
  const open = seriesEvidence([page({ text: "Brooklyn Film Festival 2027. Submissions are now open for shorts." })], { now: NOW });
  assert.match(open.open, /Submissions are now open/);
  const closed = seriesEvidence([page({ text: "Brooklyn Film Festival 2026. Submissions are closed. See you next year." })], { now: NOW });
  assert.match(closed.closed, /Submissions are closed/);
  const silent = seriesEvidence([page({ text: "Brooklyn Film Festival. Our history, our team, our venues." })], { now: NOW });
  assert.equal(seriesRawItem({ source, home: page(), pages: [page()], evidence: silent, now: NOW }), null);
});

test("names come from the registry unless it only holds a host; categories from the source", () => {
  assert.equal(seriesName(source, page()), "Brooklyn Film Festival");
  assert.equal(seriesName({ name: "aifilmfest.ae" }, page({ html: '<meta property="og:site_name" content="Expo AI Film Festival">' })), "Expo AI Film Festival");
  assert.equal(seriesCategory({ source_family: "film-funding" }, "Media Fund"), "Grant");
  assert.equal(seriesCategory({ source_family: "official-site", opportunity_categories: ["ai-film"] }, "X"), "AI film festival");
  assert.equal(seriesCategory({ source_family: "official-site" }, "Brooklyn Film Festival"), "Traditional festival");
});

test("a year-less closing date survives normalization only from the year rule", () => {
  const context = {
    sourceUrl: "https://refuge.example/holiday",
    sourceFinalUrl: "https://refuge.example/holiday",
    sourceLinks: [],
    sourceText: "2026 AI Holiday Film Competition. Submissions are now open. You have until December 6th to submit.",
    sourceTitle: "AI Holiday Film Competition",
    sourceType: "official",
    checkedAt: "2026-10-03T10:00:00.000Z",
  };
  const raw = {
    relevant: true,
    title: "AI Holiday Film Competition",
    organizer: "Unknown organizer",
    category: "AI film festival",
    deadline: "2026-12-06",
    deadline_status: "estimated",
    deadline_evidence: "You have until December 6th",
    field_evidence: { title: "AI Holiday Film Competition" },
  };
  const inferred = normalizeOpportunity({ ...raw, series_evidence: { deadline_method: "year-inferred" } }, context);
  assert.equal(inferred.deadline.slice(0, 10), "2026-12-06");
  assert.equal(inferred.deadline_status, "estimated");
  const unflagged = normalizeOpportunity(raw, context);
  assert.equal(unflagged.deadline, null);
});

test("FilmFreeway is never requested, even to validate a link or follow a redirect", async () => {
  assert.equal(isAutomationBlockedUrl("https://filmfreeway.com/X"), true);
  assert.equal(isAutomationBlockedUrl("https://www.filmfreeway.com/X"), true);
  assert.equal(isAutomationBlockedUrl("https://festhome.com/x"), false);
  const requested = [];
  const result = await validateUrl("https://filmfreeway.com/BrooklynFilmFestival", {
    fetchImpl: async (url) => { requested.push(url); return new Response("", { status: 200 }); },
  });
  assert.equal(result.status, "unchecked");
  assert.equal(result.reason, "HOST_BLOCKS_AUTOMATION");
  assert.equal(requested.length, 0);
  const redirected = await validateUrl("https://festival.example/submit", {
    fetchImpl: async (url) => {
      requested.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://filmfreeway.com/Festival" } });
    },
  });
  assert.equal(redirected.reason, "HOST_BLOCKS_AUTOMATION");
  assert.deepEqual(requested, ["https://festival.example/submit"]);
  const kept = applyUrlValidations({ application_url: "https://filmfreeway.com/X", raw_payload: {} }, { source: null, official: null, application: { status: "unchecked", reason: "HOST_BLOCKS_AUTOMATION" } });
  assert.equal(kept.application_url, "https://filmfreeway.com/X");
});

test("broken HTTPS certificates fall back to HTTP; other failures do not", () => {
  assert.equal(httpFallbackUrl("https://fest.example/", { reason: "FETCH_FAILED", error_code: "CERT_HAS_EXPIRED" }), "http://fest.example/");
  assert.equal(httpFallbackUrl("https://fest.example/", { reason: "FETCH_FAILED", error_code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "http://fest.example/");
  assert.equal(httpFallbackUrl("https://fest.example/", { reason: "FETCH_FAILED", error_code: "ECONNREFUSED" }), null);
  assert.equal(httpFallbackUrl("http://fest.example/", { reason: "FETCH_FAILED", error_code: "CERT_HAS_EXPIRED" }), null);
});

test("dry-run regressions: volunteers, workshops and page-label names", async () => {
  const { inferYearlessDeadline } = await import("../scripts/cineradar/deadline-hunt.mjs");
  assert.equal(inferYearlessDeadline("Festival 2026. Call for volunteers. Apply by October 11.", { now: NOW }), null);
  assert.equal(inferYearlessDeadline("Festival 2026. Film submissions: apply by October 31.", { now: NOW }).deadline, "2026-10-31");
  const workshop = seriesEvidence([page({ text: "Zagreb Film Festival 2026. Applications open for the trailer editing workshop." })], { now: NOW });
  assert.equal(workshop.open, null);
  assert.equal(seriesName({ name: "Entry forms" }, page({ html: '<meta property="og:site_name" content="European Media Art Festival">' })), "European Media Art Festival");
  assert.equal(seriesName({ name: "Entry forms" }, page({ html: "<title>Entry forms</title>" })), null);
});

test("past-tense dates and label-only names are not used", async () => {
  const { inferYearlessDeadline } = await import("../scripts/cineradar/deadline-hunt.mjs");
  assert.equal(inferYearlessDeadline("Biennale College 2026. The call opened on January 15 and closed on April 13.", { now: NOW }), null);
  // Present tense counts, but the inferred year (2027) must be printed on the page.
  assert.equal(inferYearlessDeadline("2026 edition. The call closes on April 13.", { now: NOW }), null);
  assert.equal(inferYearlessDeadline("Edition 2027. The call closes on April 13.", { now: NOW }).deadline, "2027-04-13");
  assert.equal(seriesName({ name: "Submissions FAQ" }, page({ html: '<meta property="og:site_name" content="Nashville Film Festival">' })), "Nashville Film Festival");
  assert.equal(seriesName({ name: "Rules of the Game Film Fest" }, page()), "Rules of the Game Film Fest");
});

test("a series homepage that links its own Submit/Rules page passes the call gate", () => {
  const page = (links) => ({ finalUrl: "https://www.kinofest.example.org/", linkRecords: links });
  assert.equal(pageHasSubmissionLink(page([{ url: "https://www.kinofest.example.org/submissions/", text: "Submissions" }])), true);
  assert.equal(pageHasSubmissionLink(page([{ url: "https://kinofest.example.org/reglamento", text: "Bases" }])), true);
  assert.equal(pageHasSubmissionLink(page([{ url: "https://filmfreeway.com/Kinofest", text: "Submit" }])), true);
  // Other sites, news, tickets and volunteers are not the call's pages.
  assert.equal(pageHasSubmissionLink(page([{ url: "https://other.example.com/submit", text: "Submit" }])), false);
  assert.equal(pageHasSubmissionLink(page([{ url: "https://kinofest.example.org/news/submissions-closed", text: "News" }])), false);
  assert.equal(pageHasSubmissionLink(page([{ url: "https://kinofest.example.org/volunteer", text: "Apply to volunteer" }])), false);
  assert.equal(pageHasSubmissionLink(page([{ url: "https://kinofest.example.org/programme", text: "Programme" }])), false);
});
