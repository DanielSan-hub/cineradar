import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizedSeriesName,
  persistTemporalObservations,
  temporalClaimPriority,
  temporalEntityEvidence,
} from "../scripts/cineradar/temporal-observations.mjs";

const source = {
  id: "11111111-1111-4111-8111-111111111111",
  url: "https://aurora.example/",
  source_type: "official",
  source_family: "official-site",
};

function record(year, overrides = {}) {
  const sourceUrl = `https://aurora.example/calls/${year}`;
  return {
    canonical_key: `key-${year}`,
    title: `Aurora Film Festival ${year}`,
    organizer: "Aurora Arts",
    category: "Traditional festival",
    source_type: "official",
    source_url: sourceUrl,
    source_url_last_checked_at: `${year}-01-10T12:00:00.000Z`,
    official_url: sourceUrl,
    official_url_status: "verified",
    application_url: `https://aurora.example/apply/${year}`,
    deadline: `${year}-07-01T23:59:59.000Z`,
    deadline_status: "confirmed",
    edition_year: year,
    discovered_at: `${year}-01-10T12:00:00.000Z`,
    raw_payload: {
      evidence: { deadline_quote: `Deadline: July 1, ${year}` },
      normalization: { warnings: [] },
    },
    _provenance: [{ sourceId: source.id, sourceUrl }],
    ...overrides,
  };
}

function fakeClient() {
  const tables = {
    organizers: new Map(),
    event_series: new Map(),
    opportunity_editions: new Map(),
  };
  const observations = new Map();
  const calls = [];
  let nextId = 0;
  const client = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === "rpc/record_opportunity_observation") {
      const body = JSON.parse(init.body);
      if (observations.has(body.p_idempotency_key)) {
        return { inserted: false, idempotent_replay: true, conflict_count: 0 };
      }
      observations.set(body.p_idempotency_key, body);
      return { inserted: true, idempotent_replay: false, conflict_count: 0 };
    }
    const [table, query = ""] = path.split("?");
    const rows = tables[table];
    if (!rows) throw new Error(`Unexpected ${path}`);
    const params = new URLSearchParams(query);
    if (init.method === "POST") {
      const [body] = JSON.parse(init.body);
      const field = params.get("on_conflict");
      const existing = [...rows.values()].find((row) => row[field] === body[field]);
      if (existing) return [];
      const row = { id: `row-${++nextId}`, ...body };
      rows.set(row.id, row);
      return [row];
    }
    if (init.method === "PATCH") {
      const id = params.get("id").slice(3);
      Object.assign(rows.get(id), JSON.parse(init.body));
      return null;
    }
    const key = [...params.entries()].find(([field]) => field !== "select" && field !== "limit");
    const field = key?.[0];
    const value = key?.[1]?.slice(3);
    return [...rows.values()].filter((row) => row[field] === value).slice(0, 1);
  };
  return { client, tables, observations, calls };
}

test("dated official identity is stable and shared with historical series keys", () => {
  const first = temporalEntityEvidence(record(2025), source);
  const second = temporalEntityEvidence(record(2026), source);
  assert.equal(normalizedSeriesName("Aurora Film Festival 2026"), "aurora film festival");
  assert.equal(first.seriesKey, second.seriesKey);
  assert.notEqual(first.editionKey, second.editionKey);
  assert.equal(first.year, 2025);
  assert.equal(second.year, 2026);
});

test("unverified, generic, directory, and undated pages do not create identities", () => {
  assert.equal(temporalEntityEvidence(record(2026), null), null);
  assert.equal(temporalEntityEvidence(record(2026), {
    ...source, source_family: "opportunity-directory",
  }), null);
  assert.equal(temporalEntityEvidence(record(2026, { official_url_status: "unchecked" }), source), null);
  assert.equal(temporalEntityEvidence(record(2026, { title: "Aurora Film Festival" }), source), null);
  assert.equal(temporalEntityEvidence(record(2026, { title: "Open Call 2026" }), source), null);
  assert.equal(temporalEntityEvidence(record(2026, { edition_year: 2027 }), source), null);
});

test("claim ranking favors verified official details over summaries and press", () => {
  assert.equal(temporalClaimPriority(record(2026), source), 20);
  assert.equal(temporalClaimPriority(record(2026, {
    source_url: "https://aurora.example/",
    official_url: "https://aurora.example/",
  }), source), 40);
  assert.equal(temporalClaimPriority(record(2026), {
    ...source, source_family: "structured-festival",
  }), 80);
  assert.equal(temporalClaimPriority(record(2026, { source_type: "press" }), source), 180);
});

test("persistence creates observed editions, never forecasts, then replays idempotently", async () => {
  const db = fakeClient();
  const one = record(2025);
  const two = record(2026);
  const stored = [
    { id: "op-2025", canonical_key: one.canonical_key },
    { id: "op-2026", canonical_key: two.canonical_key },
  ];
  const first = await persistTemporalObservations(
    [one, two], stored, "run-one", { client: db.client, sourceRows: [source] },
  );
  assert.deepEqual(first, {
    observationsInserted: 2,
    observationsReplayed: 0,
    organizersCreated: 1,
    seriesCreated: 1,
    editionsCreated: 2,
    entityEvidenceSkipped: 0,
    entityConflictsSkipped: 0,
    conflictsObserved: 0,
  });
  const [series] = db.tables.event_series.values();
  assert.equal(series.earliest_known_year, 2025);
  assert.equal(series.latest_known_year, 2026);
  assert.equal(series.recurring, true);
  assert.equal(db.tables.opportunity_editions.size, 2);
  assert.equal([...db.observations.values()].every((item) =>
    item.p_observed_status === null
      && item.p_observed_fields.no_forecasting === true
      && item.p_observed_deadline !== null), true);

  const replay = await persistTemporalObservations(
    [two], stored, "run-two", { client: db.client, sourceRows: [source] },
  );
  assert.equal(replay.observationsInserted, 0);
  assert.equal(replay.observationsReplayed, 1);
  assert.equal(db.tables.opportunity_editions.size, 2);
});

test("a series owned by another organizer is left unlinked instead of aborting the run", async () => {
  const db = fakeClient();
  const one = record(2025);
  const two = record(2026);
  await persistTemporalObservations(
    [one], [{ id: "op-2025", canonical_key: one.canonical_key }], "run-one",
    { client: db.client, sourceRows: [source] },
  );
  // Another organizer now owns the series identity this record resolves to.
  for (const series of db.tables.event_series.values()) series.organizer_id = "someone-else";
  const result = await persistTemporalObservations(
    [two], [{ id: "op-2026", canonical_key: two.canonical_key }], "run-two",
    { client: db.client, sourceRows: [source] },
  );
  assert.equal(result.entityConflictsSkipped, 1);
  assert.equal(result.observationsInserted, 1);
  assert.equal(result.editionsCreated, 0);
});

test("unsupported deadline claims are omitted and database failures propagate", async () => {
  const db = fakeClient();
  const item = record(2026, {
    source_type: "press",
    deadline_status: "rolling",
    deadline: null,
  });
  const result = await persistTemporalObservations(
    [item], [{ id: "op-one", canonical_key: item.canonical_key }], "run-one",
    { client: db.client, sourceRows: [source] },
  );
  assert.equal(result.entityEvidenceSkipped, 1);
  const [observation] = db.observations.values();
  assert.equal(observation.p_deadline_status, "unknown");
  assert.equal(observation.p_observed_deadline, null);
  await assert.rejects(
    persistTemporalObservations(
      [item], [{ id: "op-one", canonical_key: item.canonical_key }], "run-one",
      { client: async () => { throw new Error("database unavailable"); }, sourceRows: [source] },
    ),
    /database unavailable/,
  );
});

test("only source-grounded OPEN/CLOSED claims become temporal observations", async () => {
  const db = fakeClient();
  const base = record(2026);
  const stored = [{ id: "op-one", canonical_key: base.canonical_key }];
  for (const [status, quote, hash] of [
    ["open", "Applications are open", "open-hash"],
    ["closed", "Applications are closed", "closed-hash"],
  ]) {
    const item = {
      ...base,
      raw_payload: {
        ...base.raw_payload,
        extraction: { observed_status: status, status_evidence: quote },
      },
    };
    await persistTemporalObservations([item], stored, `run-${status}`, {
      client: db.client,
      sourceRows: [source],
      pageEvidence: [{
        url: item.source_url,
        contentHash: hash,
        observedAt: "2026-01-10T12:00:00.000Z",
        pageText: `Aurora Film Festival. ${quote}.`,
      }],
    });
  }
  assert.deepEqual(
    [...db.observations.values()].map((item) => item.p_observed_status),
    ["open", "closed"],
  );
  const unsupported = {
    ...base,
    raw_payload: {
      ...base.raw_payload,
      extraction: {
        observed_status: "open",
        status_evidence: "Applications are open",
      },
    },
  };
  await persistTemporalObservations([unsupported], stored, "run-ungrounded", {
    client: db.client,
    sourceRows: [source],
    pageEvidence: [{
      url: unsupported.source_url,
      contentHash: "unrelated-hash",
      observedAt: "2026-01-11T12:00:00.000Z",
      pageText: "Aurora Film Festival information page.",
    }],
  });
  assert.equal([...db.observations.values()].at(-1).p_observed_status, null);
});
