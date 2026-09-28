import assert from "node:assert/strict";
import { test } from "node:test";

import { autoReviewDecision } from "../lib/auto-review.mjs";

const NOW = Date.parse("2026-09-29T10:00:00Z");
const DAY = 86_400_000;
const live = Object.freeze({
  title: "KINO Athens Submissions",
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
  assert.deepEqual(result.changes, { organizer: "KINO Athens" });
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
