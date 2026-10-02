import assert from "node:assert/strict";
import { test } from "node:test";

import { autoReviewDecision, pageDisciplineContext } from "../lib/auto-review.mjs";
import { looksLikeJavaScriptShell } from "../scripts/cineradar/browser-render.mjs";
import {
  evidenceNearTitle,
  huntDeadline,
  huntLinks,
  inferYearlessDeadline,
  isApplyPage,
  jsonLdDeadline,
} from "../scripts/cineradar/deadline-hunt.mjs";
import { deterministicPageExtraction } from "../scripts/cineradar/deterministic-extractor.mjs";
import { cloudflareCharge, cloudflareRefusedBeforeInference, groqRetryAfterMs } from "../scripts/cineradar/llm.mjs";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const DAY = 86_400_000;

test("the hunt opens the call's own rules/submit pages, never FilmFreeway or news", () => {
  const links = huntLinks([
    { url: "https://fest.example/news/2026-winners", text: "Winners 2026" },
    { url: "https://fest.example/submit/", text: "Submit your film" },
    { url: "https://fest.example/rules-and-regulations", text: "Rules" },
    { url: "https://filmfreeway.com/Fest", text: "Submit on FilmFreeway" },
    { url: "https://filmmakers.festhome.com/en/festival/fest", text: "Submit on Festhome" },
    { url: "https://other.example/submit", text: "Submit" },
    { url: "https://fest.example/guidelines.pdf", text: "Guidelines" },
  ], { pageUrl: "https://www.fest.example/" });
  const urls = links.map((link) => link.url);
  assert.equal(urls.length, 3);
  assert.ok(urls.includes("https://fest.example/submit/"));
  assert.ok(urls.includes("https://fest.example/rules-and-regulations"));
  assert.ok(!urls.some((url) => /filmfreeway|news|other\.example|\.pdf/.test(url)));
  assert.equal(isApplyPage("https://fest.example/submit/"), true);
  assert.equal(isApplyPage("https://fest.example/rules"), false);
});

test("a year-less closing date takes the next occurrence only when the page names that year", () => {
  const page = "2026 AI Holiday Film Competition. Submissions are now open. You have until December 6th at 11 AM PST to submit.";
  const hit = inferYearlessDeadline(page, { now: NOW });
  assert.equal(hit.deadline, "2026-12-06");
  assert.equal(hit.deadline_status, "estimated");
  assert.match(hit.evidence, /until December 6th/);
  // No year on the page, too far ahead, closed, or not a closing date: nothing.
  assert.equal(inferYearlessDeadline("You have until December 6th to submit.", { now: NOW }), null);
  assert.equal(inferYearlessDeadline("2027 edition. Deadline: June 6th.", { now: NOW }), null);
  assert.equal(inferYearlessDeadline("2026. Submissions are closed. Deadline: December 6th.", { now: NOW }), null);
  assert.equal(inferYearlessDeadline("2026 screenings on December 6th at the cinema.", { now: NOW }), null);
  // A submission window closes on its second date; dated text is left to the dated extractor.
  assert.equal(inferYearlessDeadline("Edition 2026. Submission window: Oct 20 – November 8", { now: NOW }).deadline, "2026-11-08");
  assert.equal(inferYearlessDeadline("2026 call. Deadline: December 6, 2026", { now: NOW }), null);
});

test("structured validThrough and dated text are confirmed; past dates are ignored", () => {
  const html = `<script type="application/ld+json">{"@type":"Event","name":"X","offers":{"@type":"Offer","validThrough":"2026-11-30"}}</script>`;
  assert.equal(jsonLdDeadline(html, { now: NOW }).deadline, "2026-11-30");
  assert.equal(jsonLdDeadline(html, { now: NOW + 90 * DAY }), null);
  const dated = huntDeadline({ text: "Final deadline: 15 February 2027", html: "" }, { now: NOW, title: "World AI Film Festival Kyoto" });
  assert.deepEqual([dated.deadline, dated.deadline_status, dated.method], ["2027-02-15", "confirmed", "dated"]);
});

test("on a page listing several calls, a date counts only next to the record's own name", () => {
  const text = "AI Halloween Competition — You have until October 20th to submit.\n\nAI Holiday Film Competition — You have until December 6th to submit.";
  assert.equal(evidenceNearTitle(text, "You have until December 6th", "Curious Refuge AI Holiday Film Competition", { window: 40 }), true);
  assert.equal(evidenceNearTitle(text, "You have until December 6th", "The AI Film Trailer Competition", { window: 40 }), false);
});

test("deterministic extraction uses the page's own JSON-LD, site name and description", () => {
  const html = `<html><head><title>Home</title>
    <meta property="og:site_name" content="Valencia AI Cinema">
    <meta name="description" content="Short films made with AI compete for EUR 2,250.">
    <script type="application/ld+json">{"@type":"Event","name":"FESTIAV 2026 AI Film Festival","organizer":{"@type":"Organization","name":"Galaxia Televisión"},"offers":{"validThrough":"2026-10-04"}}</script>
    </head><body><h1>Welcome</h1></body></html>`;
  const page = { html, text: "FESTIAV 2026. Submit your film. Final deadline: October 4, 2026.", linkRecords: [{ url: "https://festiav.example/submit", text: "Submit" }], finalUrl: "https://festiav.example/" };
  const result = deterministicPageExtraction(page, { sourceType: "official", now: NOW });
  assert.equal(result.disposition, "complete");
  const [record] = result.records;
  assert.equal(record.title, "FESTIAV 2026 AI Film Festival");
  assert.equal(record.organizer, "Galaxia Televisión");
  assert.equal(record.category, "AI film festival");
  assert.equal(record.deadline, "2026-10-04");
  assert.match(record.summary, /made with AI/);
});

const pending = Object.freeze({
  title: "Creekside Residency 2027",
  summary: "A residency on Vancouver Island.",
  category: "Residency",
  organizer: "Creekside Arts",
  status: "discovered",
  deadline: new Date(NOW + 40 * DAY).toISOString(),
  deadline_status: "confirmed",
  official_url: "https://creekside.example/residency",
  official_url_status: "verified",
  source_type: "official",
  confidence: 0.8,
});
const page = (extra = {}) => ({ ok: true, httpStatus: 200, finalUrl: pending.official_url, callSignal: true, deadlineEvidenceFound: true, closed: false, organizer: null, ...extra });

test("residencies and labs: film words or all-disciplines on the official page are enough", () => {
  assert.equal(autoReviewDecision(pending, { now: NOW, page: page() }).decision, "human");
  assert.equal(autoReviewDecision(pending, { now: NOW, page: page({ filmContext: true }) }).decision, "approve");
  assert.equal(autoReviewDecision(pending, { now: NOW, page: page({ allDisciplines: true }) }).decision, "approve");
  assert.equal(autoReviewDecision(pending, { now: NOW, page: page({ otherDisciplineOnly: true }) }).decision, "reject");
  assert.deepEqual(pageDisciplineContext("Open to artists of all disciplines."), { filmContext: false, allDisciplines: true, otherDisciplineOnly: false });
  assert.equal(pageDisciplineContext("Use a screen reader to watch the video.").filmContext, false);
  assert.equal(pageDisciplineContext("Poetry and painting residency.").otherDisciplineOnly, true);
});

test("an estimated deadline publishes as verified, never as open", () => {
  const estimated = { ...pending, title: "Creekside Film Residency 2027", deadline_status: "estimated" };
  const result = autoReviewDecision(estimated, { now: NOW, page: page() });
  assert.equal(result.decision, "approve");
  assert.equal(result.targetStatus, "verified");
});

test("LLM capacity: Cloudflare inside its free allowance costs nothing; Groq takes over only after a refusal", () => {
  assert.equal(cloudflareCharge(0.002, { dailyLimit: 9000, freeDaily: 10000 }), 0);
  assert.equal(cloudflareCharge(0.002, { dailyLimit: 20000, freeDaily: 10000 }), 0.002);
  assert.equal(cloudflareRefusedBeforeInference({ code: "BUDGET_BLOCKED", reason: "daily-provider-limit" }), true);
  assert.equal(cloudflareRefusedBeforeInference({ code: "LLM_PROVIDER_EXHAUSTED" }), true);
  assert.equal(cloudflareRefusedBeforeInference({ code: "BUDGET_BLOCKED", reason: "monthly-budget" }), false);
  assert.equal(cloudflareRefusedBeforeInference(new Error("Cloudflare AI 500 invalid response")), false);
  assert.equal(groqRetryAfterMs({ get: () => "7" }, null), 7000);
  assert.equal(groqRetryAfterMs({ get: () => null }, { error: { message: "Please try again in 1m30.5s." } }), 90500);
  assert.equal(groqRetryAfterMs({ get: () => null }, {}), null);
});

test("only an empty JavaScript shell is sent to the headless browser", () => {
  assert.equal(looksLikeJavaScriptShell({ text: "Sin Cámara - Festival", linkRecords: [] }), true);
  assert.equal(looksLikeJavaScriptShell({ text: "x".repeat(2000), linkRecords: [] }), false);
});

test("regressions from the first live hunt", () => {
  // "realized by" and promotions are not submission deadlines.
  assert.equal(inferYearlessDeadline("Biennale 2026. Projects up to EUR 25,000 should be realized by April 2.", { now: NOW }), null);
  assert.equal(inferYearlessDeadline("2026 promo: Minimax is live! Ends Oct 15", { now: NOW }), null);
  // Early-bird and final dates: the call closes on the last one.
  assert.equal(inferYearlessDeadline("2026 awards. Early bird deadline: October 20. Final deadline: December 1.", { now: NOW }).deadline, "2026-12-01");
  // A page listing two competitions: each record keeps the date next to its own name.
  const listing = "Curious Refuge 2026 competitions.\nAI Halloween Competition. You have until October 20th to submit.\n\n\n\nAI Holiday Film Competition. You have until December 6th to submit.";
  const exclude = ["curiousrefuge.com", "Curious Refuge"];
  const pick = (title) => inferYearlessDeadline(listing, {
    now: NOW,
    accept: (evidence) => evidenceNearTitle(listing, evidence, title, { exclude, window: 40 }),
  })?.deadline ?? null;
  assert.equal(pick("Curious Refuge AI Halloween Competition"), "2026-10-20");
  assert.equal(pick("Curious Refuge AI Holiday Film Competition"), "2026-12-06");
  assert.equal(pick("The AI Film Trailer Competition"), null);
  // A title that is only the organizer's name is the site's main call.
  assert.equal(evidenceNearTitle("Hot Docs. Deadline: December 10, 2026", "Deadline: December 10, 2026", "Hot Docs Festival", { exclude: ["hotdocs.ca", "Hot Docs"] }), true);
});

test("with a wide window, the date goes to the call named closest to it", () => {
  const listing = "Curious Refuge 2026.\nAI Halloween Competition. Spooky shorts. You have until October 20th to submit.\nAI Holiday Film Competition. Festive shorts. You have until December 6th to submit.";
  const titles = ["Curious Refuge AI Halloween Competition", "Curious Refuge AI Holiday Film Competition", "The AI Film Trailer Competition"];
  const exclude = ["curiousrefuge.com", "Curious Refuge"];
  const pick = (title) => inferYearlessDeadline(listing, {
    now: NOW,
    accept: (evidence) => evidenceNearTitle(listing, evidence, title, { exclude, siblings: titles.filter((other) => other !== title) }),
  })?.deadline ?? null;
  assert.equal(pick(titles[0]), "2026-10-20");
  assert.equal(pick(titles[1]), "2026-12-06");
  assert.equal(pick(titles[2]), null);
});

test("review regressions: theatre, finalists, stale rolling calls and page-label names", () => {
  const live = { ...pending, title: "Short+Sweet Theatre 2026-27", category: "Traditional festival" };
  assert.equal(autoReviewDecision(live, { now: NOW, page: page({ filmContext: true }) }).decision, "reject");
  assert.equal(autoReviewDecision({ ...live, title: "Short+Sweet Film Festival" }, { now: NOW, page: page({ filmContext: true }) }).decision, "approve");
  assert.equal(autoReviewDecision({ ...pending, title: "NYISA 2026 Best Feature Screenplay Award Semi-Finalists" }, { now: NOW, page: page({ filmContext: true }) }).decision, "reject");
  const rolling = { ...pending, title: "#DiffuseTogether AI Video Contest", deadline: null, deadline_status: "rolling" };
  assert.equal(autoReviewDecision(rolling, { now: NOW, page: page({ filmContext: true, mentionsCurrentYear: false }) }).decision, "human");
  assert.equal(autoReviewDecision(rolling, { now: NOW, page: page({ filmContext: true, mentionsCurrentYear: true }) }).decision, "approve");
  const named = autoReviewDecision({ ...pending, title: "Submit Your Screenplay", organizer: "NFFTY", official_url: "https://www.nffty.example/submit" }, { now: NOW, page: page({ filmContext: true, finalUrl: "https://www.nffty.example/submit" }) });
  assert.equal(named.changes.title, "NFFTY – Screenplay");
});

test("public names drop website chrome, entities and announcement sentences", async () => {
  const { publicTitleFor, NOT_YET_OPEN } = await import("../lib/auto-review.mjs");
  const cases = [
    ["Home - Glasgow Short Film Festival", "Glasgow Short Film Festival", "Glasgow Short Film Festival"],
    ["CALL FOR ENTRIES MONO NO AWARE XX 2026 &mdash; MONO NO AWARE", "MONO NO AWARE", "MONO NO AWARE XX 2026"],
    ["Call for Entries 2027 is now open!", "Kaboom Animation Festival", "Kaboom Animation Festival"],
    ["Inscripciones abiertas para el 41° Festival Internacional de Cine de Mar del Plata", "Mar del Plata", "41° Festival Internacional de Cine de Mar del Plata"],
    ["WILDsound Festival – Deadline Today (Top 100 Best Reviewed Festival)", "WILDsound", "WILDsound Festival"],
    ["Submissions for the 2027 Episodic Lab and Intensive are now open", "Sundance Institute", "Sundance Institute – 2027 Episodic Lab and Intensive"],
  ];
  for (const [title, organizer, expected] of cases) assert.equal(publicTitleFor(title, organizer).title, expected, title);
  assert.ok(NOT_YET_OPEN.test("Stay tuned – Our 2027 Call for Entries is coming up in November"));
  assert.equal(autoReviewDecision({ ...pending, title: "Stay tuned – Our 2027 Call for Entries is coming up" }, { now: NOW, page: page({ filmContext: true }) }).decision, "watch");
  assert.equal(autoReviewDecision({ ...pending, title: "A4 Residency Art Center 2027" }, { now: NOW, page: page({ filmContext: true, directoryPage: true }) }).decision, "reject");
});

test("a title or page that says the call is closed is never published", async () => {
  const { scoreCallSignal } = await import("../scripts/cineradar/call-signal.mjs");
  assert.equal(autoReviewDecision({ ...pending, title: "Submissions for the 2027 Episodic Lab and Intensive are now closed." }, { now: NOW, page: page({ filmContext: true }) }).decision, "reject");
  assert.equal(scoreCallSignal("Submissions for the 2027 Episodic Lab and Intensive are now closed.").closed, true);
  assert.equal(autoReviewDecision({ ...pending, title: "Closed Circuit Film Festival 2027" }, { now: NOW, page: page({ filmContext: true }) }).decision, "approve");
});

test("pasted secrets are cleaned of quotes, names and whitespace", async () => {
  const { cleanSecret } = await import("../scripts/cineradar/config.mjs");
  for (const value of ["  gsk_abc\n", "\"gsk_abc\"", "GROQ_API_KEY=gsk_abc", "Bearer gsk_abc", "GROQ_API_KEY = \"gsk_abc\""]) {
    assert.equal(cleanSecret(value), "gsk_abc");
  }
  assert.equal(cleanSecret("   "), undefined);
});

test("Groq falls back to the first available free model it can price", async () => {
  const { pickGroqModel } = await import("../scripts/cineradar/llm.mjs");
  assert.equal(pickGroqModel(["llama-3.1-8b-instant", "openai/gpt-oss-20b", "whisper-large-v3"]), "openai/gpt-oss-20b");
  assert.equal(pickGroqModel(["whisper-large-v3", "unpriced/model"]), null);
});
