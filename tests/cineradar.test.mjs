import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOpportunitiesSearchParams,
  mergeUniqueById,
  normalizeOpportunityQuery,
  parseBoundedInteger,
} from "../lib/opportunity-pagination.mjs";
import { parseExtractionPayload } from "../scripts/cineradar/llm.mjs";
import {
  applyUrlValidations,
  dedupeOpportunities,
  normalizeDeadline,
  normalizeOpportunity,
} from "../scripts/cineradar/normalization.mjs";
import { buildDiscoveryQueries } from "../scripts/cineradar/queries.mjs";
import { sourceCatalog } from "../scripts/cineradar/source-catalog.mjs";
import {
  createRunMetrics,
  incrementMetric,
  recordRejection,
  summarizeMetrics,
} from "../scripts/cineradar/telemetry.mjs";
import { canonicalizeUrl, validateUrl } from "../scripts/cineradar/web-validation.mjs";

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

test("8. dedupe keeps different festivals from the same organizer separate", () => {
  const first = normalizeOpportunity(rawOpportunity(), context());
  const second = normalizeOpportunity(
    rawOpportunity({ title: "Grounded Animation Festival", field_evidence: { title: "Grounded Animation Festival", organizer: "Grounded Arts", location: "Athens, Greece" } }),
    context({ sourceText: "Grounded Animation Festival is presented by Grounded Arts in Athens, Greece.", sourceTitle: "Grounded Animation Festival" }),
  );
  assert.equal(dedupeOpportunities([first, second]).length, 2);
});

test("9. Athens, Greece is a stable discovery anchor and not conflated by identity", () => {
  const queries = buildDiscoveryQueries(new Date("2026-09-22T00:00:00Z"));
  assert.ok(queries.some((query) => /Athens Greece film festival/i.test(query)));
  assert.ok(queries.some((query) => /Athens International Digital Film Festival/i.test(query)));
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
