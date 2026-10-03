import assert from "node:assert/strict";
import { test } from "node:test";

import { autoReviewDecision, categoryFromName, isExpiredPublication, publicNameChanges, publicTitleFor } from "../lib/auto-review.mjs";

const NOW = Date.parse("2026-09-29T10:00:00Z");
const DAY = 86_400_000;
const live = Object.freeze({
  title: "KINO Athens Submissions",
  summary: "KINO Athens accepts films throughout the year from every genre.",
  category: "Traditional festival",
  organizer: "KINO Athens",
  status: "discovered",
  deadline: new Date(NOW + 60 * DAY).toISOString(),
  deadline_status: "confirmed",
  official_url: "https://kinoathens.example.org/submit",
  official_url_status: "unchecked",
  source_type: "official",
  source_url_status: "verified",
  has_conflict: false,
  confidence: 0.71,
  review_reason: null,
});
const goodPage = Object.freeze({ ok: true, httpStatus: 200, finalUrl: live.official_url, closed: false, callSignal: true, deadlineEvidenceFound: true, organizer: null });

test("a live call re-verified on its official page is approved", () => {
  const result = autoReviewDecision(live, { now: NOW, page: goodPage });
  assert.equal(result.decision, "approve");
  assert.equal(result.targetStatus, "open");
  const soon = autoReviewDecision({ ...live, deadline: new Date(NOW + 10 * DAY).toISOString() }, { now: NOW, page: goodPage });
  assert.equal(soon.targetStatus, "closing-soon");
});

test("organizer comes from page metadata when extraction missed it", () => {
  const result = autoReviewDecision({ ...live, organizer: "Unknown organizer" }, { now: NOW, page: { ...goodPage, organizer: "KINO Athens" } });
  assert.equal(result.decision, "approve");
  assert.deepEqual(result.changes, { organizer: "KINO Athens", title: "KINO Athens" });
  assert.equal(autoReviewDecision({ ...live, organizer: "Unknown organizer" }, { now: NOW, page: goodPage }).decision, "human");
});

test("missing or contradicted proof escalates to a human with reasons", () => {
  const cases = [
    [{ page: { ok: false, httpStatus: 503 } }, /not reachable/],
    [{ page: { ...goodPage, closed: true } }, /closed/],
    [{ page: { ...goodPage, callSignal: false } }, /no longer shows an open call/],
    [{ page: { ...goodPage, deadlineEvidenceFound: false } }, /no longer stated/],
    [{ row: { has_conflict: true } }, /conflict/],
    [{ row: { confidence: 0.4 } }, /Low extraction confidence/],
  ];
  for (const [{ row = {}, page = goodPage }, reason] of cases) {
    const result = autoReviewDecision({ ...live, ...row }, { now: NOW, page });
    assert.equal(result.decision, "human");
    assert.ok(result.reasons.some((text) => reason.test(text)), reason.source);
  }
});

test("listing, programme and past-edition pages are rejected; singular calls are not", () => {
  for (const title of ["Funding Overview", "Festival Directory", "Open Calls | Onassis Foundation", "Festival Submissions & Deadlines 2026", "2019 Feature Competition", "32nd Athens International Film Festival: These Are the Winners"]) {
    assert.equal(autoReviewDecision({ ...live, title }, { now: NOW, page: goodPage }).decision, "reject", title);
  }
  assert.equal(autoReviewDecision({ ...live, title: "OPEN CALL | 25AV Residency Program (2026–2027)" }, { now: NOW, page: goodPage }).decision, "approve");
});

test("duplicates are archived and records without a live deadline are watched", () => {
  assert.equal(autoReviewDecision(live, { now: NOW, page: goodPage, duplicateOf: { id: "047a08b2-aaaa", title: "AIDFF" } }).decision, "archive");
  assert.equal(autoReviewDecision({ ...live, deadline: null, deadline_status: "unknown" }, { now: NOW }).decision, "watch");
  assert.equal(autoReviewDecision({ ...live, deadline: new Date(NOW + DAY).toISOString() }, { now: NOW }).decision, "watch");
  assert.equal(autoReviewDecision({ ...live, deadline: null, deadline_status: "rolling" }, { now: NOW, page: goodPage }).decision, "approve");
});

test("regressions from the first automatic run are rejected or escalated", () => {
  const page = goodPage;
  const decide = (row) => autoReviewDecision({ ...live, ...row }, { now: NOW, page });
  // Deadline tiers, lists, accreditations, juries and other disciplines.
  for (const title of ["Earlybird Deadline: October 25, 2026", "Late Deadline: January 10, 2027", "AI Film Festivals, Events & Competitions", "Accreditation Paris 2026", "2027 Youth Jury applications open"]) {
    assert.equal(decide({ title, summary: "Submit your film" }).decision, "reject", title);
  }
  assert.equal(decide({ title: "Next ILLUST Award 2026", summary: "イラストコンテスト", category: "Grant", organizer: "PIE International", official_url: "https://compe.japandesign.ne.jp/news/2026/09/87728/" }).decision, "reject");
  // No film element stated, or an official page that is a listing: a human decides.
  assert.equal(decide({ title: "viviON CREATOR AWARD", summary: "偏愛をテーマにした公募アワードです。", category: "Grant", organizer: "株式会社viviON", official_url: "https://compe.japandesign.ne.jp/vivion-2026/" }).decision, "human");
  assert.equal(decide({ title: "dot.ateliers: 2027 Artist Residency", summary: "Residency for artists", category: "Residency", organizer: "dot.ateliers", official_url: "https://on-the-move.org/news?page=0" }).decision, "human");
  // Real film calls still pass.
  assert.equal(decide({ title: "2027 Inside Out 2SLGBTQ+ Film Festival", summary: "Submit your film", organizer: "Inside Out", official_url: "https://www.insideout.ca/home/submissions/" }).decision, "approve");
  assert.equal(decide({ title: "The lim² 2027 Call for Projects", summary: "Call for projects for the lim² 2027 program", category: "Grant", organizer: "Le Groupe Ouest", official_url: "https://www.legroupeouest.com/en/" }).decision, "human");
  assert.equal(decide({ title: "AI Movie Awards London", summary: "Submit your AI film, music video, or art.", organizer: "AIMA Productions", official_url: "https://aimovieawards.org/submit/" }).decision, "approve");
});

test("generic headings are rejected before and after ingestion", async () => {
  const { isGenericTitle } = await import("../scripts/cineradar/normalization.mjs");
  for (const title of ["Call For Entries", "Late Deadline: January 10, 2027", "Earlybird Deadline: October 25, 2026", "ワークショップ", "Open Call 2027", "Submissions", "Convocatoria abierta"]) {
    assert.equal(isGenericTitle(title), true, title);
  }
  for (const title of ["Submissions – Call for Entries MONSTRA 2027", "Victoria Film Festival 2027", "KINO Athens Submissions", "Open Call | 25AV Residency Program"]) {
    assert.equal(isGenericTitle(title), false, title);
  }
  assert.equal(autoReviewDecision(live, { now: NOW, page: goodPage, genericTitle: true }).decision, "reject");
});

test("v3: the official page must belong to the call; names are cleaned", async () => {
  const { cleanTitle, cleanOrganizer, pageBelongsToCall } = await import("../lib/auto-review.mjs");
  // Own sites pass; articles, aggregators and listings do not.
  assert.equal(pageBelongsToCall({ url: "https://kinoathens.org/en/submissions/", title: "KINO Athens Submissions", organizer: "KINO Athens" }), true);
  assert.equal(pageBelongsToCall({ url: "https://www.legroupeouest.com/en/", title: "The lim² 2027 Call for Projects", organizer: "Le Groupe Ouest" }), true);
  assert.equal(pageBelongsToCall({ url: "https://indieshortsmag.com/2026/08/cairo", title: "Cairo International Short Film Festival Confirms December 2026", organizer: "Indie Shorts Mag" }), false);
  assert.equal(pageBelongsToCall({ url: "https://aifilmcontests.com/guide/october", title: "AI Film Festival Deadlines in October 2026: Every Contest Closing", organizer: "AI Film Contests" }), false);
  assert.equal(pageBelongsToCall({ url: "https://www.recursosculturales.com/festival-transcinema/", title: "Festival Transcinema", organizer: "Transcinema" }), false);
  // Clean-up of entities, site suffixes and trailing organizer names.
  assert.equal(cleanOrganizer("Maker &amp; Smith | Craft & Design"), "Maker & Smith");
  assert.equal(cleanTitle("Makers Film Festival Submission - Maker & Smith | Craft & Design", "Maker &amp; Smith | Craft"), "Makers Film Festival Submission");
  // A bare category takes the organizer's name.
  const tampere = autoReviewDecision({ ...live, title: "International Competition", organizer: "Tampere Film Festival", official_url: "https://tamperefilmfestival.fi/en/industry/competition" }, { now: NOW, page: goodPage });
  assert.equal(tampere.decision, "approve");
  assert.equal(tampere.changes.title, "Tampere Film Festival – International Competition");
  const article = autoReviewDecision({ ...live, title: "Cairo International Short Film Festival Confirms December 2026 Dates", organizer: "Indie Shorts Mag", official_url: "https://indieshortsmag.com/2026/08/cairo" }, { now: NOW, page: goodPage });
  assert.equal(article.decision, "human");
});

test("public names drop page labels and never stay a bare category or action word", () => {
  const cases = [
    ["Submit", "Rochester International Film Festival", "Rochester International Film Festival"],
    ["Makers Film Festival Submission", "Maker & Smith", "Makers Film Festival"],
    ["KINO Athens Submissions", "KINO Athens", "KINO Athens"],
    ["Call For Submission - Main Competition", "goEast Filmfestival", "goEast Filmfestival – Main Competition"],
    ["Regulations – International Competition 2027", "Tampere Film Festival", "Tampere Film Festival – International Competition 2027"],
    ["Golden Dunes — Dubai International Film Festival G O L D E N D U N E S", "Golden Dunes", "Golden Dunes — Dubai International Film Festival"],
    ["Rules of the Game Film Fest", "Rules Collective", "Rules of the Game Film Fest"],
    ["AI Filmfest Athens 2026", "AI Filmfest Athens", "AI Filmfest Athens 2026"],
  ];
  for (const [title, organizer, expected] of cases) {
    assert.equal(publicTitleFor(title, organizer).title, expected, title);
  }
  assert.equal(publicTitleFor("Submit", "Unknown organizer").unresolved, true);
});

test("AI film events named as such get the AI category; funds and unrelated names do not", () => {
  assert.equal(categoryFromName({ title: "AI Cinema Festival Canada — Ottawa", organizer: "AI Cinema Festival", category: "Traditional festival" }), "AI film festival");
  assert.equal(categoryFromName({ title: "AI Movie Awards London", organizer: "AIMA Productions", category: "Grant" }), "AI film festival");
  assert.equal(categoryFromName({ title: "AI Film Fund 2027", organizer: "Studio", category: "Grant" }), null);
  assert.equal(categoryFromName({ title: "Thai Film Festival", organizer: "Thai Film Foundation", category: "Traditional festival" }), null);
  assert.equal(categoryFromName({ title: "AI Cinema Festival", organizer: "X", category: "Residency" }), null);
  assert.deepEqual(publicNameChanges({ title: "Submit", organizer: "Rochester International Film Festival", category: "Traditional festival" }), { title: "Rochester International Film Festival" });
  assert.deepEqual(publicNameChanges({ title: "AI Filmfest Athens 2026", organizer: "AI Filmfest Athens", category: "AI film festival" }), {});
});

test("published calls expire a day after a recorded deadline; rolling calls never do", () => {
  const now = Date.parse("2026-10-02T10:00:00Z");
  assert.equal(isExpiredPublication({ deadline: "2026-10-01T23:59:59Z", deadline_status: "estimated" }, { now }), false);
  assert.equal(isExpiredPublication({ deadline: "2026-09-30T00:00:00Z", deadline_status: "confirmed" }, { now }), true);
  assert.equal(isExpiredPublication({ deadline: "2026-09-01T00:00:00Z", deadline_status: "rolling" }, { now }), false);
  assert.equal(isExpiredPublication({ deadline: null, deadline_status: "unknown" }, { now }), false);
});

test("v5: an organizer's own 'submissions are open' with a platform link publishes as verified without a date", () => {
  const undated = {
    ...live,
    deadline: null,
    deadline_status: "unknown",
    application_url: "https://filmfreeway.com/KinoAthens",
    raw_payload: { extraction: { series_evidence: { method: "series-anchored-v1", open_quote: "SUBMIT Submissions are now open for KINO Athens 2027" } } },
  };
  const page = { ...goodPage, deadlineEvidenceFound: false, openStatementFound: true, mentionsCurrentYear: true };
  const result = autoReviewDecision(undated, { now: NOW, page });
  assert.equal(result.decision, "approve");
  assert.equal(result.targetStatus, "verified");
  assert.ok(result.reasons.some((text) => /submission platform/.test(text)));
  // The statement must still be on the page, with the current or next year.
  assert.equal(autoReviewDecision(undated, { now: NOW, page: { ...page, openStatementFound: false } }).decision, "human");
  assert.equal(autoReviewDecision(undated, { now: NOW, page: { ...page, mentionsCurrentYear: false } }).decision, "human");
  // Without a quoted statement or without a submission link: nothing to publish yet.
  assert.equal(autoReviewDecision({ ...undated, raw_payload: {} }, { now: NOW, page }).decision, "watch");
  assert.equal(autoReviewDecision({ ...undated, application_url: null }, { now: NOW, page }).decision, "watch");
});

test("v5: section headings take the organizer's name; craft categories are named after it", () => {
  assert.equal(publicTitleFor("THE FESTIVAL IN NUMBERS", "DOK.fest München").title, "DOK.fest München");
  assert.equal(publicTitleFor("About us", "Unknown organizer").unresolved, true);
  assert.equal(publicTitleFor("Screenplay Competition", "Sedona International Film Festival").title, "Sedona International Film Festival – Screenplay Competition");
  assert.equal(publicTitleFor("Euroscript Screenwriting Competition", "Euroscript").title, "Euroscript Screenwriting Competition");
});

test("a published call stays public until its deadline; a new one needs two days left", () => {
  const tomorrow = { ...live, deadline: new Date(NOW + 1 * DAY).toISOString() };
  assert.equal(autoReviewDecision(tomorrow, { now: NOW, page: goodPage }).decision, "watch");
  const kept = autoReviewDecision(tomorrow, { now: NOW, page: goodPage, published: true });
  assert.equal(kept.decision, "approve");
  assert.equal(kept.targetStatus, "closing-soon");
});

test("a news or blog post about something else is not a call's own page", () => {
  const post = { ...live, official_url: "https://kinoathens.example.org/blog/festival-photos-2026" };
  const result = autoReviewDecision(post, { now: NOW, page: { ...goodPage, finalUrl: post.official_url } });
  assert.equal(result.decision, "human");
  assert.ok(result.reasons.some((text) => /news or blog post/.test(text)));
});

test("an organizer's own post announcing its call is its page; an aggregator's post is not", () => {
  const own = { ...live, title: "Kaboom Animation Festival", organizer: "Kaboom Animation Festival", official_url: "https://www.kaboomfestival.nl/news/call-for-entries-2027-is-now-open/" };
  assert.equal(autoReviewDecision(own, { now: NOW, page: { ...goodPage, finalUrl: own.official_url } }).decision, "approve");
  const aggregator = { ...live, title: "Eyebeam: Democracy Machine Fellowship Open Call", organizer: "On the Move", official_url: "https://on-the-move.org/news/eyebeam-democracy-machine-fellowship-open-call-online-usa" };
  assert.equal(autoReviewDecision(aggregator, { now: NOW, page: { ...goodPage, finalUrl: aggregator.official_url } }).decision, "human");
});
