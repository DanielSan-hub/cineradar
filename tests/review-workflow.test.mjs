import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  BLOCKER_MESSAGES,
  diffReviewFields,
  EDITABLE_FIELDS,
  isUuid,
  parseReviewPage,
  parseReviewView,
  publicationBlockers,
  reviewViewFilter,
  timestampInputValue,
  validateReviewIntent,
} from "../lib/review-workflow.mjs";

const NOW = Date.parse("2026-09-26T10:00:00Z");

const baseRow = Object.freeze({
  title: "Example Lab 2027",
  organizer: "Example Foundation",
  category: "Residency",
  ai_policy: "unclear",
  summary: "",
  location: "Online",
  remote: true,
  deadline: "2026-11-01T22:59:00+00:00",
  deadline_status: "confirmed",
  deadline_source_url: null,
  opens_at: null,
  edition_year: 2027,
  prize_amount: null,
  prize_currency: null,
  entry_fee_amount: 25,
  entry_fee_currency: "EUR",
  max_runtime_minutes: null,
  official_url: "https://lab.example.org/call",
  official_url_status: "verified",
  application_url: null,
  source_type: "press",
  source_url_status: "verified",
  eligibility: ["Emerging filmmakers"],
  formats: [],
  tags: [],
  has_conflict: false,
  status: "open",
});

function formFor(row) {
  return {
    title: row.title,
    organizer: row.organizer,
    category: row.category,
    ai_policy: row.ai_policy,
    summary: row.summary,
    location: row.location,
    remote: String(row.remote),
    deadline: timestampInputValue(row.deadline),
    deadline_status: row.deadline_status,
    deadline_source_url: row.deadline_source_url ?? "",
    opens_at: timestampInputValue(row.opens_at),
    edition_year: String(row.edition_year ?? ""),
    prize_amount: row.prize_amount === null ? "" : String(row.prize_amount),
    prize_currency: row.prize_currency ?? "",
    entry_fee_amount: row.entry_fee_amount === null ? "" : String(row.entry_fee_amount),
    entry_fee_currency: row.entry_fee_currency ?? "",
    max_runtime_minutes: "",
    official_url: row.official_url ?? "",
    application_url: row.application_url ?? "",
    eligibility: row.eligibility.join("\n"),
    formats: row.formats.join("\n"),
    tags: row.tags.join("\n"),
  };
}

test("an unchanged review form produces no changes", () => {
  const { changes, errors } = diffReviewFields(baseRow, formFor(baseRow));
  assert.deepEqual(errors, {});
  assert.deepEqual(changes, {});
});

test("only edited fields are returned, normalized to column types", () => {
  const form = {
    ...formFor(baseRow),
    title: "  Example Lab 2027 (Second call) ",
    deadline: "2026-11-15T23:59:00+01:00",
    entry_fee_amount: "30.5",
    prize_currency: "jpy",
    prize_amount: "100000",
    remote: "false",
    eligibility: "Emerging filmmakers\nUnder 35\nUnder 35\n",
  };
  const { changes, errors } = diffReviewFields(baseRow, form);
  assert.deepEqual(errors, {});
  assert.deepEqual(changes, {
    title: "Example Lab 2027 (Second call)",
    deadline: "2026-11-15T22:59:00.000Z",
    entry_fee_amount: 30.5,
    prize_amount: 100000,
    prize_currency: "JPY",
    remote: false,
    eligibility: ["Emerging filmmakers", "Under 35"],
  });
});

test("equivalent timestamps in another offset are not a change", () => {
  const { changes } = diffReviewFields(baseRow, {
    deadline: "2026-11-01T23:59:00+01:00",
  });
  assert.deepEqual(changes, {});
});

test("deadlines without an explicit timezone are rejected, not guessed", () => {
  for (const deadline of ["2026-11-01", "2026-11-01T23:59", "1 Nov 2026"]) {
    const { changes, errors } = diffReviewFields(baseRow, { deadline });
    assert.ok(errors.deadline, deadline);
    assert.equal(changes.deadline, undefined);
  }
  assert.deepEqual(diffReviewFields(baseRow, { deadline: "" }).changes, { deadline: null });
});

test("unsafe or placeholder URLs are rejected", () => {
  for (const url of [
    "javascript:alert(1)",
    "ftp://lab.example.org",
    "https://example.com/call",
    "https://user:pass@lab.example.org",
    "http://localhost:3000",
    "not a url",
  ]) {
    assert.ok(diffReviewFields(baseRow, { official_url: url }).errors.official_url, url);
  }
  assert.deepEqual(
    diffReviewFields(baseRow, { application_url: "https://lab.example.org/apply" }).changes,
    { application_url: "https://lab.example.org/apply" },
  );
});

test("required text, enums and numbers are validated", () => {
  const { errors } = diffReviewFields(baseRow, {
    title: "   ",
    category: "Music video",
    ai_policy: "maybe",
    remote: "on",
    entry_fee_amount: "-5",
    edition_year: "1999",
    max_runtime_minutes: "0",
    prize_currency: "EURO",
  });
  assert.deepEqual(Object.keys(errors).sort(), [
    "ai_policy", "category", "edition_year", "entry_fee_amount",
    "max_runtime_minutes", "prize_currency", "remote", "title",
  ]);
});

test("fields that are not editable are ignored by the diff", () => {
  const { changes } = diffReviewFields(baseRow, {
    status: "open",
    verified_at: "2026-09-26T00:00:00Z",
    review_decision: "approved",
    source_url: "https://attacker.example.net",
  });
  assert.deepEqual(changes, {});
  assert.equal("source_url" in EDITABLE_FIELDS, false);
  assert.equal("status" in EDITABLE_FIELDS, false);
});

test("review intent requires a reason and a public target for approval", () => {
  assert.deepEqual(validateReviewIntent({ action: "approve", reason: " checked ", targetStatus: "open" }), { reason: "checked", errors: {} });
  assert.ok(validateReviewIntent({ action: "approve", reason: "checked", targetStatus: "closed" }).errors.targetStatus);
  assert.ok(validateReviewIntent({ action: "reject", reason: " ", targetStatus: null }).errors.reason);
  assert.ok(validateReviewIntent({ action: "delete", reason: "gone", targetStatus: null }).errors.action);
  assert.deepEqual(validateReviewIntent({ action: "reject", reason: "duplicate", targetStatus: null }).errors, {});
});

test("a well-evidenced open call passes the publication gate", () => {
  assert.deepEqual(publicationBlockers(baseRow, { now: NOW }), []);
});

test("publication gate blocks missing or contradictory evidence", () => {
  const cases = [
    [{ status: "discovered" }, "status-not-public"],
    [{ organizer: "Unknown organizer" }, "missing-organizer"],
    [{ official_url_status: "unchecked" }, "no-verified-official-page"],
    [{ official_url: null }, "no-verified-official-page"],
    [{ has_conflict: true }, "unresolved-conflict"],
    [{ deadline_status: "estimated" }, "deadline-not-confirmed"],
    [{ deadline: null, deadline_status: "unknown" }, "deadline-not-confirmed"],
    [{ deadline: "2026-09-01T00:00:00Z" }, "deadline-passed"],
    [{ status: "closing-soon", deadline: null, deadline_status: "rolling" }, "closing-soon-without-deadline"],
  ];
  for (const [override, code] of cases) {
    assert.ok(publicationBlockers({ ...baseRow, ...override }, { now: NOW }).includes(code), code);
    assert.ok(BLOCKER_MESSAGES[code], `message for ${code}`);
  }
});

test("a past deadline blocks every public status", () => {
  for (const status of ["verified", "open", "closing-soon"]) {
    for (const deadlineStatus of ["confirmed", "unknown", "estimated"]) {
      const blockers = publicationBlockers(
        { ...baseRow, status, deadline: "2026-09-15T00:00:00Z", deadline_status: deadlineStatus },
        { now: NOW },
      );
      assert.ok(blockers.includes("deadline-passed"), `${status}/${deadlineStatus}`);
      assert.equal(blockers.includes("deadline-not-confirmed"), false);
    }
  }
});

test("publication gate accepts rolling calls, official sources and acknowledged conflicts", () => {
  assert.deepEqual(publicationBlockers({ ...baseRow, deadline: null, deadline_status: "rolling" }, { now: NOW }), []);
  assert.deepEqual(publicationBlockers({ ...baseRow, official_url: null, source_type: "official" }, { now: NOW }), []);
  assert.deepEqual(publicationBlockers({ ...baseRow, has_conflict: true }, { acknowledgeConflict: true, now: NOW }), []);
  assert.deepEqual(publicationBlockers({ ...baseRow, status: "verified", deadline: null, deadline_status: "unknown" }, { now: NOW }), []);
});

test("review views, pages and ids are parsed defensively", () => {
  assert.equal(parseReviewView("approved"), "approved");
  assert.equal(parseReviewView("everything"), "human");
  assert.equal(parseReviewView(undefined), "human");
  assert.equal(parseReviewPage("3"), 3);
  assert.equal(parseReviewPage("0"), 1);
  assert.equal(parseReviewPage("-2"), 1);
  assert.equal(parseReviewPage("1e9"), 1);
  assert.equal(reviewViewFilter("rejected").review_decision, "in.(rejected,archived)");
  assert.equal(reviewViewFilter("bogus").review_decision, "eq.pending");
  assert.ok(isUuid("0435a5f7-1909-4b39-8033-e451e5726714"));
  assert.equal(isUuid("0435a5f7-1909-4b39-8033-e451e5726714&select=*"), false);
});

test("review migration keeps the gate human-only and the audit append-only", async () => {
  const sql = await readFile("supabase/migrations/202609260001_review_workflow.sql", "utf8");
  assert.match(sql, /review_decision = 'approved'\s+and verified_at is not null/);
  assert.match(sql, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/);
  assert.match(sql, /before update or delete on public\.opportunity_review_events/);
  assert.match(sql, /revoke all on public\.opportunity_review_events from anon, authenticated/);
  assert.match(sql, /for update;/);
  assert.match(sql, /p_expected_updated_at is distinct from before_row\.updated_at/);
  // The editable allowlist must match the client-side one exactly.
  const allowlist = sql.match(/editable constant text\[\] := array\[([\s\S]*?)\];/)[1]
    .match(/'([a-z_]+)'/g).map((item) => item.slice(1, -1)).sort();
  assert.deepEqual(allowlist, Object.keys(EDITABLE_FIELDS).sort());
  // Blocker codes emitted by the latest SQL definition must all have UI messages.
  const gate = await readFile("supabase/migrations/202609280001_publication_gate_past_deadline.sql", "utf8");
  const sqlCodes = [...gate.matchAll(/array_append\(blockers, '([a-z-]+)'\)/g)].map((match) => match[1]);
  // "team-only-source" is enforced by the app (form and server action), not
  // by the SQL gate: Festhome data never reaches the review RPC as an approval.
  const appOnly = new Set(["team-only-source"]);
  assert.deepEqual([...new Set(sqlCodes)].sort(), Object.keys(BLOCKER_MESSAGES).filter((code) => !appOnly.has(code)).sort());
});

test("Festhome data is team-only: flagged for the team tab and never publishable", async () => {
  const { isTeamOnlyRecord, publicationBlockers, reviewViewFilter } = await import("../lib/review-workflow.mjs");
  const { triageRecord } = await import("../lib/review-triage.mjs");
  const { autoReviewDecision } = await import("../lib/auto-review.mjs");
  const row = {
    title: "Prague Film Festival", organizer: "Prague Film Festival", status: "verified", deadline: "2027-01-28T23:59:59Z", deadline_status: "confirmed",
    official_url: "https://prahafilmfestival.com/", official_url_status: "verified", source_type: "community",
    source_url: "https://filmmakers.festhome.com/festival/1", deadline_source_url: "https://filmmakers.festhome.com/festival/1", tags: ["platform:festhome"],
  };
  assert.equal(isTeamOnlyRecord(row), true);
  assert.ok(publicationBlockers(row, { now: Date.parse("2026-10-03T10:00:00Z") }).includes("team-only-source"));
  assert.ok(triageRecord(row, { now: Date.parse("2026-10-03T10:00:00Z") }).flags.includes("team-only"));
  assert.ok(!triageRecord(row, { now: Date.parse("2026-10-03T10:00:00Z") }).flags.includes("publishable"));
  assert.equal(autoReviewDecision(row, { now: Date.parse("2026-10-03T10:00:00Z"), page: { ok: true, callSignal: true, deadlineEvidenceFound: true } }).decision, "watch");
  assert.equal(reviewViewFilter("team", { triage: true }).triage_flags, "cs.{team-only}");
  assert.equal(isTeamOnlyRecord({ ...row, source_url: "https://prahafilmfestival.com/", deadline_source_url: null, tags: [] }), false);
});
