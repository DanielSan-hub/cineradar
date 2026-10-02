import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildOpportunitiesSearchParams,
  mergeUniqueById,
  normalizeOpportunityQuery,
  parseBoundedInteger,
} from "../lib/opportunity-pagination.mjs";
import {
  alignOpportunityPayload,
  reviewRequiredForAutomatedIngest,
} from "../lib/ingest-payload.mjs";
import { chatGPTUserFromHeaders } from "../lib/chatgpt-identity.mjs";
import { isAuthorizedTeamEmail } from "../lib/team-authorization.mjs";
import {
  budgetMode,
  estimateCloudflareUsage,
  estimateExaReservation,
  estimateExaSearch,
  estimateMessageTokens,
  limitsForBudget,
  projectConfiguredMonthlyCost,
} from "../scripts/cineradar/cost-control.mjs";
import { admitDiscoveryCandidates } from "../scripts/cineradar/discovery-candidates.mjs";
import { deterministicPageExtraction } from "../scripts/cineradar/deterministic-extractor.mjs";
import { parseExtractionPayload } from "../scripts/cineradar/llm.mjs";
import {
  applyUrlValidations,
  dedupeOpportunities,
  normalizeDeadline,
  normalizeOpportunity,
} from "../scripts/cineradar/normalization.mjs";
import {
  buildDiscoveryQueries,
  selectDiscoveryQueryDescriptors,
} from "../scripts/cineradar/queries.mjs";
import { sourceCatalog } from "../scripts/cineradar/source-catalog.mjs";
import { parseSupabasePayload } from "../scripts/cineradar/supabase.mjs";
import {
  advanceSourceCheckpoint,
  buildNextSourceRequestUrl,
  selectDueSources,
} from "../scripts/cineradar/source-registry.mjs";
import {
  createRunMetrics,
  incrementMetric,
  recordRejection,
  summarizeMetrics,
} from "../scripts/cineradar/telemetry.mjs";
import {
  canonicalizeUrl,
  selectOpportunityLinks,
  selectSourceOpportunityLinks,
  validateUrl,
} from "../scripts/cineradar/web-validation.mjs";

function response(status, { location, url, text = "a".repeat(100) } = {}) {
  return {
    status,
    url,
    headers: { get: (name) => name.toLowerCase() === "location" ? location ?? null : "text/html" },
    body: { cancel: async () => {} },
    text: async () => text,
  };
}

const sourceUrl = "https://source.test/call";
const officialUrl = "https://official.test/festival";
const applicationUrl = "https://apply.test/entry";

test("team access requires an explicitly allowlisted exact email", () => {
  assert.equal(isAuthorizedTeamEmail("reviewer@example.com", undefined), false);
  assert.equal(isAuthorizedTeamEmail("reviewer@example.com", ""), false);
  assert.equal(isAuthorizedTeamEmail("reviewer@example.com", " other@example.com, REVIEWER@example.com "), true);
  assert.equal(isAuthorizedTeamEmail("reviewer@example.com.evil", "reviewer@example.com"), false);
  assert.equal(isAuthorizedTeamEmail("reviewer@example.com", "reviewer@example.com.evil"), false);
  assert.equal(isAuthorizedTeamEmail("", "reviewer@example.com"), false);
  assert.equal(isAuthorizedTeamEmail("reviewer@example.com", "reviewer"), false);
});

test("ChatGPT Sites identity accepts its documented email header without a user ID", () => {
  assert.deepEqual(chatGPTUserFromHeaders(new Headers({
    "oai-authenticated-user-email": " reviewer@example.com ",
  })), {
    email: "reviewer@example.com",
    fullName: null,
    displayName: "reviewer@example.com",
  });
  assert.equal(chatGPTUserFromHeaders(new Headers({
    "oai-authenticated-user-id": "untrusted-id-only",
  })), null);
  assert.deepEqual(chatGPTUserFromHeaders(new Headers({
    "oai-authenticated-user-email": "reviewer@example.com",
    "oai-authenticated-user-full-name": "Giulia%20Rossi",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  }))?.displayName, "Giulia Rossi");
});

test("Supabase minimal writes may return an empty 200 or 201 response", async () => {
  assert.equal(await parseSupabasePayload(new Response("", { status: 200 })), null);
  assert.equal(await parseSupabasePayload(new Response("", { status: 201 })), null);
  assert.equal(await parseSupabasePayload(new Response(null, { status: 204 })), null);
  assert.deepEqual(
    await parseSupabasePayload(new Response('{"id":"stored"}', { status: 201 })),
    { id: "stored" },
  );
});

function rawOpportunity(overrides = {}) {
  return {
    relevant: true,
    title: "Grounded Film Festival",
    organizer: "Grounded Arts",
    category: "Traditional festival",
    ai_policy: "unclear",
    deadline: null,
    deadline_status: "unknown",
    deadline_evidence: null,
    deadline_source_url: null,
    opens_at: null,
    prize_amount: null,
    prize_currency: null,
    entry_fee_amount: null,
    entry_fee_currency: null,
    location: "Athens, Greece",
    remote: false,
    max_runtime_minutes: null,
    official_url: officialUrl,
    application_url: applicationUrl,
    source_type: "press",
    confidence: 0.7,
    summary: "A real call for filmmakers.",
    eligibility: [],
    formats: [],
    tags: ["film"],
    field_evidence: {
      title: "Grounded Film Festival",
      organizer: "Grounded Arts",
      location: "Athens, Greece",
    },
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    sourceUrl,
    sourceFinalUrl: sourceUrl,
    sourceLinks: [officialUrl, applicationUrl],
    sourceText: "Grounded Film Festival is presented by Grounded Arts in Athens, Greece.",
    sourceTitle: "Grounded Film Festival",
    sourceType: "press",
    checkedAt: "2026-09-22T12:00:00.000Z",
    ...overrides,
  };
}

function verified(url) {
  return {
    input_url: url,
    final_url: url,
    status: "verified",
    http_status: 200,
    checked_at: "2026-09-22T12:00:00.000Z",
    redirect_chain: [],
    reason: null,
  };
}

test("1. public catalogue query is not capped at eight", () => {
  const params = buildOpportunitiesSearchParams({ limit: 50, offset: 0, sort: "urgent" });
  assert.equal(params.get("limit"), "50");
  assert.notEqual(params.get("limit"), "8");
});

test("2. pagination/load-more appends later pages without duplicate IDs", () => {
  const first = Array.from({ length: 24 }, (_, index) => ({ id: String(index) }));
  const second = Array.from({ length: 24 }, (_, index) => ({ id: String(index + 20) }));
  assert.equal(mergeUniqueById(first, second).length, 44);
  assert.equal(parseBoundedInteger("24", 8, { min: 1, max: 50 }), 24);
});

test("3. a 404 URL is never verified", async () => {
  let calls = 0;
  const result = await validateUrl(officialUrl, {
    fetchImpl: async (url) => { calls += 1; return response(404, { url }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "unreachable");
  assert.equal(result.reason, "HTTP_404");
});

test("4. redirects are followed and the final URL is recorded", async () => {
  const calls = [];
  const result = await validateUrl("https://redirect.test/old", {
    fetchImpl: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? response(302, { location: "/new", url })
        : response(200, { url });
    },
  });
  assert.deepEqual(calls, ["https://redirect.test/old", "https://redirect.test/new"]);
  assert.equal(result.status, "redirected");
  assert.equal(result.final_url, "https://redirect.test/new");
});

test("5. malformed and unsafe URLs are rejected before fetch", async () => {
  let calls = 0;
  const malformed = await validateUrl("javascript:alert(1)", {
    fetchImpl: async () => { calls += 1; return response(200); },
  });
  assert.equal(calls, 0);
  assert.equal(malformed.status, "invalid");
  assert.equal(canonicalizeUrl("http://127.0.0.1/private"), null);
});

test("6. source, official and application URLs retain separate semantics", () => {
  const normalized = normalizeOpportunity(rawOpportunity(), context());
  assert.equal(normalized.source_url, sourceUrl);
  assert.equal(normalized.official_url, officialUrl);
  assert.equal(normalized.application_url, applicationUrl);

  const validated = applyUrlValidations(normalized, {
    source: verified(sourceUrl),
    official: { ...verified(officialUrl), status: "unreachable", http_status: 404, reason: "HTTP_404" },
    application: verified(applicationUrl),
  });
  assert.equal(validated.source_url, sourceUrl);
  assert.equal(validated.official_url, null);
  assert.equal(validated.application_url, applicationUrl);
});

test("7. opportunities with an unknown deadline are retained", () => {
  const normalized = normalizeOpportunity(rawOpportunity({ deadline: null, deadline_status: "unknown" }), context());
  assert.equal(normalized.deadline, null);
  assert.equal(normalized.deadline_status, "unknown");
  assert.equal(normalized.title, "Grounded Film Festival");
});

test("ambiguous or opening dates are not promoted to deadlines", () => {
  assert.equal(normalizeDeadline("Thursday 9 April", { now: new Date("2026-09-22") }), null);
  assert.equal(
    normalizeDeadline("5 November 2026", { now: new Date("2026-09-22") }),
    "2026-11-05T23:59:59.000Z",
  );
  const record = normalizeOpportunity(
    rawOpportunity({
      deadline: "2027-01-01",
      deadline_status: "confirmed",
      deadline_evidence: "Submissions open January 1, 2027",
      deadline_source_url: sourceUrl,
    }),
    context({ sourceText: "Grounded Film Festival is presented by Grounded Arts in Athens, Greece. Submissions open January 1, 2027." }),
  );
  assert.equal(record.deadline, null);
  assert.equal(record.deadline_status, "unknown");
});

test("explicit ordinal English deadlines use the stated CET or CEST offset", () => {
  const now = new Date("2026-09-25T00:00:00Z");
  assert.equal(
    normalizeDeadline("Thursday, 5th November 2026, 4.00 pm CET", { now }),
    "2026-11-05T15:00:00.000Z",
  );
  assert.equal(
    normalizeDeadline("Monday, 6th July 2026, 4:00 pm CEST", { now }),
    "2026-07-06T14:00:00.000Z",
  );
  assert.equal(
    normalizeDeadline("5th November 2026, 16:00 CET", { now }),
    "2026-11-05T15:00:00.000Z",
  );
  for (const value of [
    "Thursday, 5th November 2026, 4.00 pm",
    "Friday, 5th November 2026, 4.00 pm CET",
    "Thursday, 5st November 2026, 4.00 pm CET",
    "Sunday, 31st February 2027, 4.00 pm CET",
    "Thursday, 5th November 2026, 25:00 CET",
    "Thursday, 5th November 2026, 4:60 pm CET",
  ]) {
    assert.equal(normalizeDeadline(value, { now }), null, value);
  }
});

test("a grounded exact CET deadline survives opportunity normalization", () => {
  const deadline = "Thursday, 5th November 2026, 4.00 pm CET";
  const quote = `Deadline for applications: ${deadline}.`;
  const record = normalizeOpportunity(
    rawOpportunity({
      deadline,
      deadline_status: "confirmed",
      deadline_evidence: quote,
      deadline_source_url: sourceUrl,
    }),
    context({ sourceText: `${context().sourceText} ${quote}` }),
  );
  assert.equal(record.deadline, "2026-11-05T15:00:00.000Z");
  assert.equal(record.deadline_status, "confirmed");
  assert.equal(record.deadline_source_url, sourceUrl);
});

test("8. dedupe keeps different festivals from the same organizer separate", () => {
  const first = normalizeOpportunity(rawOpportunity(), context());
  const second = normalizeOpportunity(
    rawOpportunity({ title: "Grounded Animation Festival", field_evidence: { title: "Grounded Animation Festival", organizer: "Grounded Arts", location: "Athens, Greece" } }),
    context({ sourceText: "Grounded Animation Festival is presented by Grounded Arts in Athens, Greece.", sourceTitle: "Grounded Animation Festival" }),
  );
  assert.equal(dedupeOpportunities([first, second]).length, 2);
});

test("9. daily discovery is stratified and Athens identities remain separate", () => {
  const plan = selectDiscoveryQueryDescriptors(24, new Date("2026-09-22T00:00:00Z"));
  assert.equal(plan.length, 24);
  assert.equal(new Set(plan.map((item) => item.id)).size, 24);
  for (const family of [
    "ai-generative",
    "short-general",
    "animation",
    "music-video",
    "experimental-new-media",
    "grants",
    "residencies",
    "labs-fellowships",
    "platform-challenges",
    "branded-open-calls",
  ]) {
    assert.ok(plan.some((item) => item.family === family), `missing family ${family}`);
  }
  for (const region of [
    "europe",
    "usa-canada",
    "asia",
    "middle-east",
    "oceania",
    "latin-america",
  ]) {
    assert.ok(plan.some((item) => item.region === region), `missing region ${region}`);
  }
  assert.ok(sourceCatalog.some((source) => source.url === "https://en.aiff.gr/"));
  assert.ok(sourceCatalog.some((source) => /athensfilmfest\.org/.test(source.url)));
  assert.ok(sourceCatalog.some((source) => /athensfilm\.com/.test(source.url)));

  const greece = normalizeOpportunity(rawOpportunity(), context());
  const ohio = normalizeOpportunity(
    rawOpportunity({ location: "Athens, Ohio", field_evidence: { title: "Grounded Film Festival", organizer: "Grounded Arts", location: "Athens, Ohio" } }),
    context({ sourceText: "Grounded Film Festival is presented by Grounded Arts in Athens, Ohio." }),
  );
  assert.equal(dedupeOpportunities([greece, ohio]).length, 2);
});

test("reduced-budget query plans rotate category and geography coverage", () => {
  const partialPlans = Array.from({ length: 10 }, (_, day) =>
    selectDiscoveryQueryDescriptors(
      12,
      new Date(Date.UTC(2026, 8, 22 + day)),
    ),
  ).flat();
  for (const family of [
    "ai-generative",
    "short-general",
    "animation",
    "music-video",
    "experimental-new-media",
    "grants",
    "residencies",
    "labs-fellowships",
    "platform-challenges",
    "branded-open-calls",
  ]) {
    assert.ok(partialPlans.some((item) => item.family === family));
  }
  for (const region of [
    "europe",
    "usa-canada",
    "asia",
    "middle-east",
    "oceania",
    "latin-america",
  ]) {
    assert.ok(partialPlans.some((item) => item.region === region));
  }
});

test("known-source child links rotate while preserving a hard page bound", () => {
  const links = Array.from({ length: 5 }, (_, index) => ({
    url: `https://festival.test/apply-${index}`,
    text: `Apply to call ${index}`,
  }));
  const first = selectOpportunityLinks(links, {
    sourceUrl: "https://festival.test/",
    limit: 2,
    offset: 0,
  });
  const second = selectOpportunityLinks(links, {
    sourceUrl: "https://festival.test/",
    limit: 2,
    offset: 2,
  });
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.notDeepEqual(first.map((item) => item.url), second.map((item) => item.url));
});

test("generic open-call directories never become a deterministic opportunity", () => {
  const page = {
    finalUrl: "https://arts.test/open-calls",
    html: "<h1>Open Calls</h1>",
    text: "Open Calls Apply to a film festival by 2026-10-20.",
    linkRecords: [{ url: "https://arts.test/apply", text: "Apply" }],
  };
  const result = deterministicPageExtraction(page, { sourceType: "official" });
  assert.equal(result.disposition, "ambiguous");
  assert.equal(result.records.length, 0);
});

test("generic collection headings are not extracted as single opportunities", () => {
  for (const { title, finalUrl } of [
    { title: "Festival Submissions & Deadlines 2026", finalUrl: "https://arts.test/festival-deadlines" },
    { title: "Festival List", finalUrl: "https://festhome.com/festivals" },
    { title: "Get funding and support", finalUrl: "https://www.bfi.org.uk/get-funding-support" },
  ]) {
    const result = deterministicPageExtraction({
      finalUrl,
      html: `<h1>${title}</h1>`,
      text: `${title}. Applications open. Deadline 2026-11-30.`,
      linkRecords: [{ url: `${finalUrl}/apply`, text: "Apply" }],
    }, { sourceType: "official" });
    assert.equal(result.disposition, "ambiguous", title);
    assert.equal(result.reason, "NO_STRONG_TITLE_SIGNAL", title);
    assert.deepEqual(result.records, [], title);
  }
});

test("specific festival detail heading still extracts an opportunity", () => {
  const result = deterministicPageExtraction({
    finalUrl: "https://arts.test/aurora-festival",
    html: "<h1>Aurora Short Film Festival 2026</h1>",
    text: "Applications open. Deadline 2026-11-30.",
    linkRecords: [{ url: "https://arts.test/aurora-festival/apply", text: "Apply" }],
  }, { sourceType: "official" });
  assert.equal(result.disposition, "complete");
  assert.equal(result.records[0].title, "Aurora Short Film Festival 2026");
  assert.equal(result.records[0].deadline, "2026-11-30");
});

test("deterministic extraction recognizes multilingual calls, application links, and deadlines", () => {
  const cases = [
    { title: "Appel à projets cinéma 2027", deadline: "date limite", application: "candidature" },
    { title: "Edital audiovisual 2027", deadline: "prazo", application: "inscrições" },
    { title: "映像公募 2027", deadline: "締切", application: "応募" },
    { title: "미디어아트 공모 2027", deadline: "마감", application: "신청" },
    { title: "影像艺术征集 2027", deadline: "截止", application: "提交" },
    { title: "دعوة أفلام 2027", deadline: "آخر موعد", application: "التقديم" },
  ];
  for (const [index, item] of cases.entries()) {
    const finalUrl = `https://arts.test/call-${index}`;
    const applicationUrl = `https://arts.test/apply-${index}`;
    const result = deterministicPageExtraction({
      finalUrl,
      html: `<h1>${item.title}</h1>`,
      text: `${item.deadline} 2027-05-30`,
      linkRecords: [{ url: applicationUrl, text: item.application }],
    }, { sourceType: "official" });
    assert.equal(result.disposition, "complete", item.title);
    assert.equal(result.records[0].application_url, applicationUrl, item.title);
    assert.equal(result.records[0].deadline, "2027-05-30", item.title);
    assert.equal(result.records[0].deadline_source_url, finalUrl, item.title);
  }
});

test("Festhome detail URLs are monitored despite generic link labels", () => {
  const links = [
    { url: "https://festhome.com/en/festivals", text: "English" },
    { url: "https://festhome.com/festival/10629", text: "Open in new window" },
    { url: "https://festhome.com/festival/9509", text: "Open in new window" },
  ];
  const first = selectSourceOpportunityLinks(
    { url: "https://festhome.com/festivals", source_family: "structured-festival" },
    links,
    { sourceUrl: "https://festhome.com/festivals", limit: 1, offset: 0 },
  );
  const second = selectSourceOpportunityLinks(
    { url: "https://festhome.com/festivals", source_family: "structured-festival" },
    links,
    { sourceUrl: "https://festhome.com/festivals", limit: 1, offset: 1 },
  );
  assert.equal(first[0].url, "https://festhome.com/festival/10629");
  assert.equal(second[0].url, "https://festhome.com/festival/9509");
});

test("incremental page cursor advances, caps depth, and never restarts daily", () => {
  const source = {
    url: "https://directory.test/calls",
    adapter: "page",
    adapter_config: { page_param: "page", page_base: 0, max_pages: 3 },
  };
  const initial = { cursor_kind: "page", page_number: 1, request_count: 0 };
  assert.equal(buildNextSourceRequestUrl(source, initial), "https://directory.test/calls?page=0");
  const second = advanceSourceCheckpoint(initial, { hasMore: true }, { maxPageNumber: 3 });
  assert.equal(buildNextSourceRequestUrl(source, second), "https://directory.test/calls?page=1");
  const third = advanceSourceCheckpoint(second, { hasMore: true }, { maxPageNumber: 3 });
  const wrapped = advanceSourceCheckpoint(third, { hasMore: true }, { maxPageNumber: 3 });
  assert.equal(wrapped.page_number, 1);
  assert.equal(wrapped.cycle_count, 1);
  assert.equal(wrapped.request_count, 3);
});

test("old overdue sources remain eligible ahead of newer high-priority sources", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const sources = [
    { id: "new", enabled: true, priority: 1, next_check_at: "2026-09-24T11:00:00Z" },
    { id: "old", enabled: true, priority: 5, next_check_at: "2026-09-20T11:00:00Z" },
  ];
  assert.deepEqual(selectDueSources(sources, { now, limit: 1 }).map((item) => item.id), ["old"]);
});

test("10. Supabase page parameters can retrieve successive pages beyond eight", () => {
  const first = buildOpportunitiesSearchParams({ limit: 24, offset: 0, sort: "newest" });
  const next = buildOpportunitiesSearchParams({ limit: 24, offset: 24, sort: "newest" });
  assert.equal(first.get("offset"), "0");
  assert.equal(next.get("offset"), "24");
  assert.equal(next.get("limit"), "24");
  assert.match(next.get("order"), /discovered_at\.desc/);
});

test("multi-opportunity extraction accepts several calls from one page", () => {
  const parsed = parseExtractionPayload(JSON.stringify({
    opportunities: [rawOpportunity(), rawOpportunity({ title: "Second Call" })],
  }));
  assert.equal(parsed.length, 2);
});

test("an ungrounded model URL is discarded", () => {
  const record = normalizeOpportunity(
    rawOpportunity({ official_url: "https://invented.test/not-found" }),
    context(),
  );
  assert.equal(record.official_url, null);
  assert.ok(record.raw_payload.normalization.warnings.includes("UNGROUNDED_URL_OFFICIAL_URL"));
});

test("persistent 5xx responses are retried and remain unreachable", async () => {
  let calls = 0;
  const result = await validateUrl(officialUrl, {
    fetchImpl: async (url) => { calls += 1; return response(503, { url }); },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "unreachable");
  assert.equal(result.reason, "HTTP_5XX");
});

test("query input cannot inject PostgREST filter grammar", () => {
  assert.equal(normalizeOpportunityQuery("Athens),status.eq.closed"), "Athens status eq closed");
});

test("observability counters and rejection reasons are exact", () => {
  const metrics = createRunMetrics("discovery");
  incrementMetric(metrics, "discovered", 12);
  incrementMetric(metrics, "fetched", 10);
  recordRejection(metrics, "FETCH_FAILED", 2);
  const summary = summarizeMetrics(metrics);
  assert.equal(summary.discovered, 12);
  assert.equal(summary.fetched, 10);
  assert.equal(summary.rejected, 2);
  assert.deepEqual(summary.rejection_reasons, { FETCH_FAILED: 2 });
});

test("bulk ingest objects always have identical keys", () => {
  const base = {
    slug: "grounded-film-festival-2027",
    title: "Grounded Film Festival 2027",
    organizer: "Grounded Arts",
    category: "Traditional festival",
    source_url: "https://source.test/2027",
    canonical_key: "canonical-2027",
  };
  const fresh = { ...base, deadline: null };
  const legacyExisting = {
    ...base,
    slug: "grounded-film-festival-2026",
    source_url: "https://source.test/2026",
    canonical_key: "canonical-2026",
    verified_at: "2026-09-22T12:00:00.000Z",
    featured: true,
    content_hash: "abc123",
  };
  const payload = alignOpportunityPayload([fresh, legacyExisting], {
    integrity: true,
    now: "2026-09-23T00:00:00.000Z",
  });

  assert.deepEqual(Object.keys(payload[0]), Object.keys(payload[1]));
  assert.ok(Object.values(payload[0]).every((value) => value !== undefined));
  assert.equal(payload[0].verified_at, null);
  assert.equal(payload[1].featured, true);
  assert.equal(payload[0].discovered_at, "2026-09-23T00:00:00.000Z");
});

test("new automated leads stay review-gated before temporal status claims", () => {
  const base = {
    slug: "festival-submissions-2026",
    title: "Festival Submissions 2026",
    organizer: "Unknown organizer",
    category: "Traditional festival",
    source_url: "https://source.test/submissions",
    canonical_key: "canonical-submissions-2026",
    status: "discovered",
  };
  const [newLead, approved] = alignOpportunityPayload([
    base,
    { ...base, canonical_key: "canonical-approved-2026", review_required: false },
  ], { integrity: true, reviewGate: true });
  assert.equal(newLead.status, "discovered");
  assert.equal(newLead.review_required, true);
  assert.equal(approved.review_required, false);
  assert.equal(reviewRequiredForAutomatedIngest(null), true);
  assert.equal(reviewRequiredForAutomatedIngest({
    status: "closed", review_required: false, verified_at: null,
  }), true);
  assert.equal(reviewRequiredForAutomatedIngest({
    status: "open", review_required: false, verified_at: "2026-09-25T00:00:00Z",
  }), false);
});

test("cost estimates and budget thresholds are conservative and exact", () => {
  const cloudflare = estimateCloudflareUsage({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  assert.equal(cloudflare.cost_usd, 0.429);
  assert.equal(cloudflare.neurons, 38_987);
  assert.equal(estimateExaSearch().cost_usd, 0.007);
  assert.equal(estimateExaReservation().cost_usd, 0.01);
  assert.equal(budgetMode(2.99, 5), "normal");
  assert.equal(budgetMode(3, 5), "conserve");
  assert.equal(budgetMode(4, 5), "essential-only");
  assert.equal(budgetMode(5, 5), "stopped");
  assert.deepEqual(
    limitsForBudget("conserve", { queryLimit: 24, resultLimit: 8, llmLimit: 80 }),
    { queryLimit: 2, resultLimit: 4, llmLimit: 12 },
  );
  assert.deepEqual(
    limitsForBudget("essential-only", { queryLimit: 24, resultLimit: 8, llmLimit: 80 }),
    { queryLimit: 0, resultLimit: 1, llmLimit: 4 },
  );
  const multilingual = [{ role: "user", content: "film æ˜ ç”» Ù…Ù†Ø­Ø©" }];
  assert.equal(
    estimateMessageTokens(multilingual),
    Buffer.byteLength(JSON.stringify(multilingual), "utf8"),
  );
  const projected = projectConfiguredMonthlyCost({ days: 30, multiplier: 5 });
  assert.ok(projected.gross_demand_eur > 5);
  assert.equal(projected.enforced_max_eur, 5);
});

test("fair candidate admission gives every query a result before later ranks", () => {
  const queries = selectDiscoveryQueryDescriptors(24, new Date("2026-09-22T00:00:00Z"));
  const batches = queries.map((query, queryIndex) => ({
    query,
    results: Array.from({ length: 8 }, (_, rank) => ({
      url: `https://host-${queryIndex}.test/call-${rank}`,
      title: `Call ${queryIndex}-${rank}`,
    })),
  }));
  const candidates = admitDiscoveryCandidates(batches, {
    limit: 80,
    perHostLimit: 8,
    observedAt: "2026-09-23T00:00:00.000Z",
  });
  assert.equal(candidates.length, 80);
  assert.equal(
    new Set(candidates.slice(0, 24).map((candidate) => candidate.provenance[0].queryId)).size,
    24,
  );
});

test("named audit misses are regression-only and survive the normal admission path", () => {
  const plan = selectDiscoveryQueryDescriptors(24, new Date("2026-09-22T00:00:00Z"));
  const forbiddenNames = [
    "SXSW",
    "Sundance",
    "TorinoFilmLab",
    "EMAP",
    "HKAIIFF",
    "DANA Dubai",
    "Flickerfest",
    "ECAMC",
    "IMCINE",
  ];
  for (const name of forbiddenNames) {
    assert.ok(!plan.some((item) => item.text.toLowerCase().includes(name.toLowerCase())));
  }
  const regressionUrls = [
    "https://sxsw.com/film-submissions/",
    "https://www.sundance.org/deadlines",
    "https://www.torinofilmlab.it/labs/featurelab/featurelab-2027",
    "https://call.emare.eu/",
    "https://www.hkaiiff.org/en",
    "https://www.danafilmfestival.com/submit",
    "https://flickerfest.com.au/entries/",
    "https://convocatorias.imcine.gob.mx/ecamc/",
  ];
  const batches = plan.map((query, index) => ({
    query,
    results: index < regressionUrls.length ? [{ url: regressionUrls[index] }] : [],
  }));
  const admitted = admitDiscoveryCandidates(batches, { limit: 80 });
  assert.deepEqual(
    new Set(admitted.map((item) => item.url)),
    new Set(regressionUrls),
  );
});

test("multilingual discovery strings remain valid UTF-8", () => {
  const queries = buildDiscoveryQueries(new Date("2026-09-22T00:00:00Z"));
  const joined = queries.join("\n");
  for (const expected of ["inscrições", "México", "日本", "한국", "亚洲", "مهرجان"]) {
    assert.ok(joined.includes(expected), `missing ${expected}`);
  }
  assert.doesNotMatch(joined, /Ã.|Î.|å‹|ì¶|Ù…/);
});

test("scheduled workflow ceilings stay below 2,000 private-runner minutes", async () => {
  const workflowFiles = [
    ".github/workflows/discovery.yml",
    ".github/workflows/monitor.yml",
    ".github/workflows/revalidate.yml",
    ".github/workflows/stale.yml",
    ".github/workflows/history.yml",
    ".github/workflows/registry.yml",
  ];
  const contents = await Promise.all(workflowFiles.map((file) => readFile(file, "utf8")));
  assert.ok(contents.every((content) => /group: cineradar-pipeline/.test(content)));
  // Worst case: every scheduled run hits its timeout, in a 31-day month.
  const runsPerMonth = (cron) => {
    const [, hours, dayOfMonth, , dayOfWeek] = cron.split(/\s+/);
    const perDay = hours.split(",").length;
    if (dayOfMonth !== "*") return perDay * dayOfMonth.split(",").length;
    if (dayOfWeek !== "*") return perDay * 5 * dayOfWeek.split(",").length;
    return perDay * 31;
  };
  // A guarded slot is run once in full (dispatched or scheduled) and the
  // other trigger stops after its guard step: one extra billed minute.
  const worstCaseMinutes = contents.reduce((total, content) => {
    const crons = [...content.matchAll(/cron: "([^"]+)"/g)].map((match) => match[1]);
    const timeout = Number(content.match(/timeout-minutes: (\d+)/)[1]);
    const guardMinutes = /id: guard/.test(content) ? 1 : 0;
    return total + crons.reduce((sum, cron) => sum + runsPerMonth(cron) * (timeout + guardMinutes), 0);
  }, 0);
  for (const content of [contents[0], contents[1]]) {
    assert.match(content, /id: guard/);
    // Every work step must honour the guard.
    const steps = content.split("\n      - ").slice(1).filter((step) => !step.startsWith("name: Skip when"));
    assert.ok(steps.every((step) => /steps\.guard\.outputs\.skip != 'true'/.test(step)));
  }
  assert.ok(worstCaseMinutes < 2000, `worst case ${worstCaseMinutes} minutes`);
  assert.match(contents[1], /MONITOR_TIME_BUDGET_SECONDS: "(\d+)"/);
  const budget = Number(contents[1].match(/MONITOR_TIME_BUDGET_SECONDS: "(\d+)"/)[1]);
  const monitorTimeout = Number(contents[1].match(/timeout-minutes: (\d+)/)[1]);
  assert.ok(budget <= (monitorTimeout - 2) * 60, "monitor must stop before its job timeout");
});

test("public catalogue hides passed deadlines and supports the quick filters", () => {
  const now = Date.parse("2026-10-02T10:37:00Z");
  const base = buildOpportunitiesSearchParams({ limit: 24, offset: 0, now });
  assert.match(base.get("and"), /deadline\.is\.null,deadline_status\.eq\.rolling,deadline\.gte\.2026-10-02T10:00:00\.000Z/);
  const quick = buildOpportunitiesSearchParams({
    limit: 24, offset: 0, now, query: "athens", aiOnly: true, freeEntry: true, withPrize: true, closingWithinDays: 14,
  });
  assert.match(quick.get("and"), /or\(title\.ilike\.\*athens\*/);
  assert.match(quick.get("and"), /category\.eq\."AI film festival",ai_policy\.in\.\(allowed,required\)/);
  assert.equal(quick.get("or"), null);
  assert.equal(quick.get("entry_fee_amount"), "eq.0");
  assert.equal(quick.get("prize_amount"), "gt.0");
  assert.equal(quick.get("deadline"), "lte.2026-10-16T10:00:00.000Z");
});

test("a share of each monitor run goes to high-priority sources behind a long backlog", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const backlog = Array.from({ length: 20 }, (_, index) => ({
    id: `old-${index}`, enabled: true, priority: 3, next_check_at: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00Z`,
  }));
  const harvested = { id: "harvested-ai", enabled: true, priority: 1, next_check_at: "2026-10-02T11:00:00Z" };
  const picked = selectDueSources([...backlog, harvested], { now, limit: 10 }).map((item) => item.id);
  assert.equal(picked.length, 10);
  assert.ok(picked.includes("harvested-ai"));
  assert.ok(picked.includes("old-0"));
  assert.ok(!selectDueSources([...backlog, harvested], { now, limit: 10, priorityShare: 0 }).some((item) => item.id === "harvested-ai"));
});
