import assert from "node:assert/strict";
import { test } from "node:test";

import { TRIAGE_FLAG_LABELS, triageRecord } from "../lib/review-triage.mjs";
import { parseReviewView, reviewViewFilter } from "../lib/review-workflow.mjs";

const NOW = Date.parse("2026-09-29T10:00:00Z");
const DAY = 86_400_000;

const base = Object.freeze({
  title: "Night Owl Shorts 2027",
  organizer: "Night Owl Foundation",
  status: "discovered",
  official_url: "https://nightowlshorts.org/call",
  official_url_status: "verified",
  source_type: "official",
  source_url_status: "verified",
  deadline: null,
  deadline_status: "unknown",
  has_conflict: false,
  max_runtime_minutes: null,
  ai_policy: "unclear",
  entry_fee_amount: null,
  application_url: null,
  eligibility: [],
  confidence: 0.8,
  review_reason: null,
});

test("past deadlines and closed calls are archived after a grace period", () => {
  const past = triageRecord({ ...base, deadline: new Date(NOW - 5 * DAY).toISOString(), deadline_status: "confirmed" }, { now: NOW });
  assert.match(past.archive, /recorded deadline \(2026-09-24\) has passed/);
  // Within the grace period (time zone unknown) nothing is archived.
  const recent = triageRecord({ ...base, deadline: new Date(NOW - 1 * DAY).toISOString(), deadline_status: "confirmed" }, { now: NOW });
  assert.equal(recent.archive, null);
  assert.match(triageRecord({ ...base, status: "closed" }, { now: NOW }).archive, /closed/);
  // Rolling calls never expire.
  assert.equal(triageRecord({ ...base, deadline: new Date(NOW - 30 * DAY).toISOString(), deadline_status: "rolling" }, { now: NOW }).archive, null);
});

test("readiness rewards publishable, soon-closing, complete records", () => {
  const bare = triageRecord(base, { now: NOW });
  assert.ok(bare.flags.includes("publishable"));
  assert.ok(bare.flags.includes("needs-deadline"));
  const soon = triageRecord({
    ...base,
    deadline: new Date(NOW + 10 * DAY).toISOString(),
    deadline_status: "confirmed",
    max_runtime_minutes: 15,
    ai_policy: "allowed",
    entry_fee_amount: 0,
    application_url: "https://nightowlshorts.org/apply",
    eligibility: ["Open worldwide"],
  }, { now: NOW });
  assert.ok(soon.flags.includes("closing-soon"));
  assert.ok(soon.score > bare.score);
  assert.ok(soon.score <= 100);
  assert.equal(soon.archive, null);
});

test("unpublishable and suspicious records sink with explicit flags", () => {
  const noPage = triageRecord({ ...base, official_url: null, source_type: "press" }, { now: NOW });
  assert.ok(noPage.flags.includes("needs-official-url"));
  assert.equal(noPage.flags.includes("publishable"), false);
  const generic = triageRecord({ ...base, review_reason: "False-positive candidate: generic festival submissions landing page" }, { now: NOW });
  assert.ok(generic.flags.includes("generic-page"));
  assert.ok(generic.score < triageRecord(base, { now: NOW }).score);
  const conflict = triageRecord({ ...base, has_conflict: true }, { now: NOW });
  assert.ok(conflict.flags.includes("conflict"));
  assert.equal(conflict.flags.includes("publishable"), false);
  for (const flag of ["publishable", "closing-soon", "needs-official-url", "needs-deadline", "conflict", "generic-page"]) {
    assert.ok(TRIAGE_FLAG_LABELS[flag], flag);
  }
});

test("the default queue shows only what the automatic review escalated", () => {
  assert.equal(parseReviewView(undefined), "human");
  assert.equal(parseReviewView("ready"), "human");
  assert.deepEqual(reviewViewFilter("human", { triage: true }), {
    review_decision: "eq.pending",
    triage_flags: "cs.{needs-human}",
    order: "readiness_score.desc.nullslast,confidence.desc,discovered_at.desc,id.asc",
  });
  assert.equal(reviewViewFilter("pending", { triage: false }).order, "confidence.desc,discovered_at.desc,id.asc");
  // Without triage columns there is no escalation flag: fall back to all pending.
  assert.equal(reviewViewFilter("human", { triage: false }).triage_flags, undefined);
});
