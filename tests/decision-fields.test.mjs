import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enrichRawOpportunity,
  extractAiPolicy,
  extractDeadline,
  extractDecisionFields,
  extractEligibility,
  extractFee,
  extractPremiere,
  extractRuntime,
} from "../scripts/cineradar/decision-fields.mjs";
import { normalizeOpportunity } from "../scripts/cineradar/normalization.mjs";

const NOW = Date.parse("2026-09-28T10:00:00Z");

test("runtime limits are read with their evidence", () => {
  const cases = [
    ["Films must have a maximum length of 15 minutes including credits.", 15],
    ["Runtime: up to 20 min.", 20],
    ["Works must not exceed 10 minutes.", 10],
    ["Short films 30 minutes or less are eligible.", 30],
    ["We accept AI shorts between 3 and 15 minutes.", 15],
    ["Durata massima 12 minuti, titoli inclusi.", 12],
    ["Duración máxima: 25 minutos.", 25],
    ["출품작 러닝타임 최대 15분", 15],
    ["作品は10分以内", 10],
  ];
  for (const [text, minutes] of cases) {
    const result = extractRuntime(text);
    assert.equal(result?.max_runtime_minutes, minutes, text);
    assert.ok(text.includes(result.evidence) || result.evidence.length > 0);
  }
  assert.equal(extractRuntime("The venue is a 10-15 minutes walk from the station."), null);
  assert.equal(extractRuntime("Our festival lasts five days."), null);
});

test("fees: explicit amounts, free entry, and ambiguity", () => {
  assert.deepEqual(
    (({ entry_fee_amount, entry_fee_currency }) => ({ entry_fee_amount, entry_fee_currency }))(extractFee("Entry fee: €20 for short films.")),
    { entry_fee_amount: 20, entry_fee_currency: "EUR" },
  );
  assert.equal(extractFee("Submission fee $35 (regular deadline)").entry_fee_currency, "USD");
  assert.equal(extractFee("Regular fee: 15 euros").entry_fee_amount, 15);
  assert.equal(extractFee("The competition is free to enter.").entry_fee_amount, 0);
  assert.equal(extractFee("Iscrizione gratuita per tutti i cortometraggi").entry_fee_amount, 0);
  assert.equal(extractFee("Entry fee: €10. Free for students."), null);
  assert.equal(extractFee("Tickets cost €10 at the door."), null);
});

test("AI policy distinguishes restrictions, requirements and permissions", () => {
  assert.equal(extractAiPolicy("AI-generated films will not be accepted.").ai_policy, "restricted");
  assert.equal(extractAiPolicy("We do not accept works made with generative AI.").ai_policy, "restricted");
  assert.equal(extractAiPolicy("Films must be created entirely with AI tools.").ai_policy, "required");
  // A named AI festival implies AI work only when the record itself is that call.
  assert.equal(extractAiPolicy("The AI Film Festival celebrates new voices.", { title: "AI Film Festival 2027" }).ai_policy, "required");
  assert.equal(extractAiPolicy("Categories include the World AI Cinema Competition.", { title: "Jaipur International Film Festival" }), null);
  assert.equal(extractAiPolicy("AI-assisted works are welcome.").ai_policy, "allowed");
  assert.equal(extractAiPolicy("A festival of documentary cinema."), null);
});

test("premiere rules need requirement language", () => {
  assert.equal(extractPremiere("Feature films must be a world premiere.").premiere_requirement, "world");
  assert.equal(extractPremiere("Only international premieres are eligible.").premiere_requirement, "international");
  assert.equal(extractPremiere("Films must be an Italian premiere (prima nazionale).").premiere_requirement, "national");
  assert.equal(extractPremiere("There is no premiere requirement.").premiere_requirement, "none");
  assert.equal(extractPremiere("Join us for the world premiere of our opening film."), null);
});

test("eligibility phrases are copied verbatim", () => {
  const result = extractEligibility("The call is open to filmmakers from all over the world. Applicants must be aged 18 to 35.");
  assert.ok(result.eligibility.some((item) => item.startsWith("open to filmmakers from all over the world")));
  assert.ok(result.eligibility.some((item) => /aged 18 to 35/.test(item)));
  assert.equal(extractEligibility("Welcome to our festival."), null);
});

test("deadlines need a closing word next to the date, in several languages", () => {
  assert.equal(extractDeadline("Final deadline: October 15, 2026", { now: NOW }).deadline, "2026-10-15");
  assert.equal(extractDeadline("Scadenza: 30 novembre 2026", { now: NOW }).deadline, "2026-11-30");
  assert.equal(extractDeadline("Fecha límite: 15 de diciembre de 2026", { now: NOW }).deadline, "2026-12-15");
  assert.equal(extractDeadline("締切 2026年12月1日", { now: NOW }).deadline, "2026-12-01");
  assert.equal(extractDeadline("Deadline 31/10/2026", { now: NOW }).deadline, "2026-10-31");
  // Ambiguous numeric dates and dates with no closing word are skipped.
  assert.equal(extractDeadline("Deadline 03/04/2027", { now: NOW }), null);
  assert.equal(extractDeadline("The festival runs 12 November 2026 in Rome.", { now: NOW }), null);
  // Early/regular/late: the latest upcoming closing date is kept with its text.
  const tiers = extractDeadline("Early deadline: 1 October 2026. Late deadline: 30 November 2026.", { now: NOW });
  assert.equal(tiers.deadline, "2026-11-30");
  assert.equal(tiers.several_dates, true);
});

test("enrichment only fills gaps and survives normalization grounding", () => {
  const page = [
    "Night Owl Shorts 2027 - call for entries",
    "Final deadline: 15 November 2026.",
    "Films must not exceed 15 minutes.",
    "Entry fee: €12.",
    "AI-generated films will not be accepted.",
    "Open to filmmakers from all over the world.",
    "Scadenza: 15 novembre 2026",
  ].join("\n");
  const raw = {
    relevant: true,
    title: "Night Owl Shorts 2027",
    organizer: null,
    category: "Traditional festival",
    ai_policy: "unclear",
    deadline: null,
    deadline_status: "unknown",
    max_runtime_minutes: 20,
    field_evidence: { title: "Night Owl Shorts 2027", max_runtime: "not a real quote" },
    eligibility: [],
    formats: [],
  };
  const enriched = enrichRawOpportunity(raw, extractDecisionFields(page, { now: NOW }));
  // An existing value is never replaced, even if its evidence is weak.
  assert.equal(enriched.max_runtime_minutes, 20);
  assert.deepEqual(enriched.decision_fields.filled.sort(), ["ai_policy", "deadline", "eligibility", "entry_fee_amount"]);
  const normalized = normalizeOpportunity(enriched, {
    sourceUrl: "https://nightowlshorts.org/call",
    sourceFinalUrl: "https://nightowlshorts.org/call",
    sourceLinks: [],
    sourceText: page,
    sourceTitle: "Night Owl Shorts 2027",
    sourceType: "official",
    checkedAt: "2026-09-28T10:00:00Z",
  });
  assert.equal(normalized.deadline, "2026-11-15T23:59:59.000Z");
  assert.equal(normalized.deadline_status, "confirmed");
  assert.equal(normalized.ai_policy, "restricted");
  assert.equal(normalized.entry_fee_amount, 12);
  assert.equal(normalized.entry_fee_currency, "EUR");
  assert.ok(normalized.eligibility.length >= 1);
  // The weak pre-existing runtime evidence is still rejected by normalization.
  assert.equal(normalized.max_runtime_minutes, null);
});

test("localized deadline evidence passes normalization", () => {
  const page = "Bando Corti 2027\nScadenza: 30 novembre 2026, ore 23:59";
  const raw = enrichRawOpportunity({
    relevant: true, title: "Bando Corti 2027", category: "Grant", ai_policy: "unclear",
    deadline: null, deadline_status: "unknown", field_evidence: { title: "Bando Corti 2027" }, eligibility: [], formats: [],
  }, extractDecisionFields(page, { now: NOW }));
  const normalized = normalizeOpportunity(raw, {
    sourceUrl: "https://example.org/bando", sourceFinalUrl: "https://example.org/bando", sourceLinks: [],
    sourceText: page, sourceTitle: "Bando Corti 2027", sourceType: "official", checkedAt: "2026-09-28T10:00:00Z",
  });
  assert.equal(normalized.deadline, "2026-11-30T23:59:59.000Z");
});

test("regressions found on real pages stay fixed", () => {
  // "ai" inside ordinary words is not an AI policy.
  for (const text of [
    "Films retaining world premiere status remain eligible to apply.",
    "We do not accept mailed in screeners.",
    "No fine-tuning or additional training required.",
    "Welcome to the Thai film festival.",
  ]) assert.equal(extractAiPolicy(text), null, text);
  // Excluding non-AI material means AI is required.
  assert.equal(extractAiPolicy("Traditionally filmed live-action footage or non-AI visual assets are not permitted at any stage.").ai_policy, "required");
  // A negated premiere rule is "none"; per-category or conflicting rules stay unknown.
  assert.equal(extractPremiere("The festival does not require world premiere status.").premiere_requirement, "none");
  assert.equal(extractPremiere("This category does not require world premiere status."), null);
  assert.equal(extractPremiere("Features must be world premieres. Shorts do not require world premiere status."), null);
  // Category-scoped fees are not the call's fee.
  assert.equal(extractFee("** Music videos have a fixed submission fee of $50 for the official deadline."), null);
  // Tiered fees have no single answer.
  assert.equal(extractFee("Fee: €30 through September 3 / €45 final deadline"), null);
  // Dates that belong to something else.
  assert.equal(extractDeadline("Submission deadlines total Last updated September 26, 2026", { now: NOW }), null);
  assert.equal(
    extractDeadline("October 15, 2026 Late deadline · €45 October 19, 2026 Notifications", { now: NOW }).deadline,
    "2026-10-15",
  );
  // A site-wide banner for another call is not this record's deadline.
  const banner = "Hot now Call for applications open FeatureLab 2027 Deadline for applications: 5 November 2026\n".concat(
    "x ".repeat(400),
    "TFL Alumni Grant supports alumni projects. Applications for this cycle are closed.",
  );
  assert.equal(extractDeadline(banner, { now: NOW, title: "TFL Alumni Grant" }), null);
  assert.equal(extractDeadline(banner, { now: NOW, title: "FeatureLab 2027" }).deadline, "2026-11-05");
});

test("banners, JSON and escaped HTML are not deadlines", () => {
  const tfl = "Find your TFL activity\nHot now\nCall for applications open\nFeatureLab 2027\nDeadline for applications: 5 November 2026\nTFL Alumni Grant\nThe grant supports alumni.";
  assert.equal(extractDeadline(tfl, { now: NOW, title: "TFL Alumni Grant" }), null);
  assert.equal(extractDeadline(tfl, { now: NOW, title: "FeatureLab 2027" }).deadline, "2026-11-05");
  // Ordinary sentences mentioning a year are not a foreign call name.
  const anime = "Registration Deadline: 20th September 2026 at 11:59pm (ACST)\nSubmission Deadline: 22nd September 2026";
  assert.ok(extractDeadline(anime, { now: NOW, title: "Short Anime Film Competition" }));
  assert.equal(extractDeadline('{"deadline" : "2026-08-15"}', { now: NOW }), null);
  assert.equal(extractDeadline("Submission deadline\x3C/p>\x3Ctd>Sep 15, 2026", { now: NOW }), null);
});

test("a tier list under a Deadlines heading closes on its last tier; tiers without the heading do not count", () => {
  const now = Date.parse("2026-10-03T10:00:00Z");
  const page = "COMPETITION CATEGORIES: • Feature Screenplays • Short Screenplays DEADLINES: Super Earlybird: May 31, 2026 Earlybird: July 31, 2026 Regular: September 30, 2026 Late: November 30, 2026 Extended: December 31, 2026 AWARDS AND PRIZES: 1st place";
  const found = extractDeadline(page, { now, title: "Screenplay Competition" });
  assert.equal(found.deadline, "2026-12-31");
  assert.equal(found.evidence, "Extended: December 31, 2026");
  assert.equal(extractDeadline("Regular: September 30, 2026 Late: November 30, 2026", { now }), null);
  // The list ends at the first line that is not a tier (notifications, festival dates).
  assert.equal(extractDeadline("Key dates\nEarly: 1 May 2026\nNotification: 1 November 2026", { now }).deadline, "2026-05-01");
});
