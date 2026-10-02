import {
  config,
  selectAdaptiveDiscoveryQueryDescriptors,
} from "./config.mjs";
import {
  BudgetBlockedError,
  estimateExaReservation,
  estimateExaSearch,
  finalizeProviderUsage,
  getBudgetState,
  limitsForBudget,
  reserveProviderUsage,
  usageIdempotencyKey,
} from "./cost-control.mjs";
import { isAiFilmText, isAiSource, scoreCallSignal } from "./call-signal.mjs";
import { admitDiscoveryCandidates } from "./discovery-candidates.mjs";
import { fetchWithTimeout, mapPool } from "./http.mjs";
import { dedupeOpportunitiesDetailed } from "./normalization.mjs";
import {
  deferPageProcessing,
  fetchUrlCache,
  markPagesProcessed,
  observeFetchedPage,
  observeNotModified,
  persistExistingPageProvenance,
  persistProvenance,
  recordFetchFailure,
  registerProductiveSources,
  withProvenance,
} from "./operations.mjs";
import { processFetchedPage } from "./process-page.mjs";
import { persistTemporalObservations } from "./temporal-observations.mjs";
import {
  createRunMetrics,
  incrementMetric,
  metricsRunPatch,
  recordRejection,
  summarizeMetrics,
} from "./telemetry.mjs";
import {
  assertTemporalSchema,
  finishRun,
  ingest,
  selectIn,
  startRun,
  supabase,
} from "./supabase.mjs";
import { canonicalizeUrl, fetchPage } from "./web-validation.mjs";

let run = null;
const metrics = createRunMetrics("discovery");

async function patchDiscoveryAttempt(id, values) {
  return supabase(`discovery_attempts?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(values),
  });
}

async function startDiscoveryAttempt(query) {
  const [attempt] = await supabase("discovery_attempts?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: JSON.stringify([{
      idempotency_key: usageIdempotencyKey([run.id, "exa", "attempt", query.id]),
      pipeline_run_id: run.id,
      attempt_kind: "gap-search",
      provider: "exa",
      operation: "search",
      query_id: query.id,
      query_family: query.family,
      query_text: query.text,
      category: query.category ?? null,
      region: query.region ?? null,
      language: query.language ?? null,
      status: "running",
      metadata: { source_type: query.sourceType ?? null, time_window: query.timeWindow ?? null },
    }]),
  });
  if (!attempt?.id) throw new Error(`Unable to create discovery attempt ${query.id}`);
  return attempt;
}

async function searchExa(query, resultLimit) {
  incrementMetric(metrics, "queries");
  const attempt = await startDiscoveryAttempt(query);
  const reserved = estimateExaReservation();
  let reservation;
  try {
    reservation = await reserveProviderUsage({
      idempotencyKey: usageIdempotencyKey([run.id, "exa", "search", query.id]),
      runId: run.id,
      provider: "exa",
      operation: "search",
      reservedCostEur: reserved.cost_eur,
      usageUnits: { searches: 1 },
      optional: true,
      metadata: {
        query_id: query.id,
        query_family: query.family,
        query_text: query.text,
        region: query.region,
        language: query.language,
        discovery_attempt_id: attempt.id,
      },
    });
  } catch (error) {
    if (error instanceof BudgetBlockedError) {
      recordRejection(metrics, "BUDGET_BLOCKED_EXA");
      await patchDiscoveryAttempt(attempt.id, {
        status: "blocked",
        finished_at: new Date().toISOString(),
        error: error.reason ?? "BUDGET_BLOCKED",
      });
      return { query, results: [], attemptId: attempt.id, costEur: 0 };
    }
    await patchDiscoveryAttempt(attempt.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: String(error.message).slice(0, 1000),
    });
    throw error;
  }

  try {
    const response = await fetchWithTimeout("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": config.exaApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query.text,
        type: "auto",
        numResults: resultLimit,
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) {
      const definiteNoCharge = [400, 401, 403].includes(response.status);
      await finalizeProviderUsage(reservation.event_id, {
        status: definiteNoCharge ? "released" : "uncertain",
        usageUnits: { searches: 1 },
        estimatedCostEur: definiteNoCharge ? 0 : reserved.cost_eur,
        providerCurrency: "USD",
        httpStatus: response.status,
        errorCode: `EXA_HTTP_${response.status}`,
      });
      await patchDiscoveryAttempt(attempt.id, {
        status: "failed",
        request_count: 1,
        estimated_cost_eur: definiteNoCharge ? 0 : reserved.cost_eur,
        finished_at: new Date().toISOString(),
        error: `EXA_HTTP_${response.status}`,
      });
      throw new Error(`Exa ${response.status}`);
    }
    const actual = estimateExaSearch(body);
    await finalizeProviderUsage(reservation.event_id, {
      status: "succeeded",
      usageUnits: {
        ...actual,
        results: Array.isArray(body.results) ? body.results.length : 0,
      },
      estimatedCostEur: actual.cost_eur,
      providerCost: actual.cost_usd,
      providerCurrency: "USD",
      providerRequestId: body.requestId ?? body.request_id ?? response.headers.get("x-request-id"),
      httpStatus: response.status,
    });
    const results = Array.isArray(body.results) ? body.results : [];
    await patchDiscoveryAttempt(attempt.id, {
      status: "succeeded",
      request_count: 1,
      result_count: results.length,
      estimated_cost_eur: actual.cost_eur,
      finished_at: new Date().toISOString(),
    });
    return { query, results, attemptId: attempt.id, costEur: actual.cost_eur };
  } catch (error) {
    if (!/^Exa \d+$/.test(error.message)) {
      await finalizeProviderUsage(reservation.event_id, {
        status: "uncertain",
        usageUnits: { searches: 1 },
        estimatedCostEur: reserved.cost_eur,
        providerCurrency: "USD",
        errorCode: "EXA_REQUEST_UNCERTAIN",
      }).catch(() => {});
      await patchDiscoveryAttempt(attempt.id, {
        status: "failed",
        request_count: 1,
        estimated_cost_eur: reserved.cost_eur,
        finished_at: new Date().toISOString(),
        error: String(error.message).slice(0, 1000),
      });
    }
    recordRejection(metrics, "DISCOVERY_QUERY_FAILED");
    console.warn(`Discovery query failed (${query.id}): ${error.message}`);
    return { query, results: [], attemptId: attempt.id, costEur: reserved.cost_eur };
  }
}

async function pendingKnownSourceCandidates(limit) {
  if (limit <= 0) return [];
  // PostgREST cannot compare two columns, so fetch never-processed pages
  // server-side and add recently changed ones; a single oldest-first window
  // would starve new pages once the cache holds tens of thousands of rows.
  const fields = "canonical_url,source_id,content_hash,processed_hash,last_changed_at,next_retry_at";
  const [neverProcessed, recentlyChanged] = await Promise.all([
    supabase(`url_fetch_cache?select=${fields}&source_id=not.is.null&content_hash=not.is.null&processed_hash=is.null&order=last_changed_at.asc&limit=2000`),
    supabase(`url_fetch_cache?select=${fields}&source_id=not.is.null&content_hash=not.is.null&processed_hash=not.is.null&order=last_changed_at.desc&limit=1000`),
  ]);
  const now = Date.now();
  const pending = [...new Map([...recentlyChanged, ...neverProcessed].map((row) => [row.canonical_url, row])).values()]
    .filter((row) =>
      row.content_hash !== row.processed_hash
      && (!row.next_retry_at || Date.parse(row.next_retry_at) <= now),
    );
  const sourceIds = [...new Set(pending.map((row) => row.source_id).filter(Boolean))];
  if (!sourceIds.length) return [];
  const sources = await selectIn("sources", "id,name,source_type,source_family,priority,opportunity_categories", "id", sourceIds);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  // AI-focused sources first, then source priority (1 = highest), then oldest:
  // an oldest-first queue left new AI contest pages waiting behind thousands of
  // generic festival homepages.
  pending.sort((left, right) => {
    const a = sourceById.get(left.source_id);
    const b = sourceById.get(right.source_id);
    return Number(isAiSource(b)) - Number(isAiSource(a))
      || Number(a?.priority ?? 3) - Number(b?.priority ?? 3)
      || Date.parse(left.last_changed_at ?? 0) - Date.parse(right.last_changed_at ?? 0);
  });
  return pending.slice(0, limit).map((row) => {
    const source = sourceById.get(row.source_id);
    return {
      url: row.canonical_url,
      title: source?.name ?? "Known source",
      sourceType: source?.source_type ?? "official",
      aiSource: isAiSource(source),
      provenance: [{
        provider: "source_monitor",
        queryId: null,
        queryText: null,
        sourceId: row.source_id,
        sourceUrl: row.canonical_url,
        resultRank: null,
        observedAt: row.last_changed_at ?? new Date().toISOString(),
        metadata: {},
      }],
    };
  });
}

async function recentDiscoveryAttempts() {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  return supabase(
    `discovery_attempts?select=query_id,candidate_count,validated_count,unique_source_count,estimated_cost_eur&status=eq.succeeded&started_at=gte.${encodeURIComponent(since)}&order=started_at.desc&limit=5000`,
  );
}

async function persistDiscoveryYield(batches, candidates, records, insertedKeys, newSources, processedPages) {
  const admittedByQuery = new Map();
  for (const candidate of candidates) {
    for (const hit of candidate.provenance ?? []) {
      if (hit.provider !== "exa") continue;
      const urls = admittedByQuery.get(hit.queryId) ?? new Set();
      urls.add(candidate.url);
      admittedByQuery.set(hit.queryId, urls);
    }
  }
  const validatedByQuery = new Map();
  const insertedByQuery = new Map();
  const sourcesByQuery = new Map();
  const falsePositivesByQuery = new Map();
  const inserted = new Set(insertedKeys);
  const newSourceHosts = new Set(newSources.map((source) => source.host));
  for (const record of records) {
    const hit = (record._provenance ?? []).find((entry) => entry.provider === "exa");
    if (!hit?.queryId) continue;
    const queryId = hit.queryId;
    const validated = validatedByQuery.get(queryId) ?? new Set();
    validated.add(record.canonical_key);
    validatedByQuery.set(queryId, validated);
    if (inserted.has(record.canonical_key)) {
      const unique = insertedByQuery.get(queryId) ?? new Set();
      unique.add(record.canonical_key);
      insertedByQuery.set(queryId, unique);
    }
    try {
      const host = new URL(record.official_url).hostname.replace(/^www\./i, "").toLowerCase();
      if (newSourceHosts.has(host)) {
        const uniqueSources = sourcesByQuery.get(queryId) ?? new Set();
        uniqueSources.add(host);
        sourcesByQuery.set(queryId, uniqueSources);
      }
    } catch { /* no official host to attribute */ }
  }
  for (const item of processedPages) {
    if (item.records.length) continue;
    for (const hit of item.candidate.provenance ?? []) {
      if (hit.provider !== "exa" || !hit.queryId) continue;
      const urls = falsePositivesByQuery.get(hit.queryId) ?? new Set();
      urls.add(item.candidate.url);
      falsePositivesByQuery.set(hit.queryId, urls);
    }
  }
  for (const batch of batches) {
    if (!batch.attemptId || !batch.results.length) continue;
    await patchDiscoveryAttempt(batch.attemptId, {
      candidate_count: admittedByQuery.get(batch.query.id)?.size ?? 0,
      validated_count: validatedByQuery.get(batch.query.id)?.size ?? 0,
      unique_opportunity_count: insertedByQuery.get(batch.query.id)?.size ?? 0,
      unique_source_count: sourcesByQuery.get(batch.query.id)?.size ?? 0,
      false_positive_count: falsePositivesByQuery.get(batch.query.id)?.size ?? 0,
    });
  }
}

async function persistGapUrlSightings(candidates, batches) {
  const attempts = new Map(batches.map((batch) => [batch.query.id, batch.attemptId]));
  let newUrls = 0;
  for (const candidate of candidates) {
    const url = canonicalizeUrl(candidate.url);
    if (!url) continue;
    const queryIds = [...new Set((candidate.provenance ?? [])
      .filter((entry) => entry.provider === "exa")
      .map((entry) => entry.queryId))];
    const attemptId = queryIds.map((id) => attempts.get(id)).find(Boolean) ?? null;
    const existing = await supabase(
      `discovered_urls?select=id,seen_count&source_id=is.null&canonical_url=eq.${encodeURIComponent(url)}&limit=1`,
    );
    if (existing.length) {
      await supabase(`discovered_urls?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          last_seen_at: new Date().toISOString(),
          seen_count: Number(existing[0].seen_count ?? 0) + 1,
          last_discovery_attempt_id: attemptId,
          metadata: { query_ids: queryIds },
        }),
      });
    } else {
      newUrls += 1;
      await supabase("discovered_urls", {
        method: "POST",
        prefer: "return=minimal",
        body: JSON.stringify([{
          canonical_url: url,
          source_id: null,
          status: "candidate",
          first_discovery_attempt_id: attemptId,
          last_discovery_attempt_id: attemptId,
          metadata: { query_ids: queryIds },
        }]),
      });
    }
  }
  return newUrls;
}

async function markDiscoveredUrlsProcessed(items) {
  for (const item of items) {
    const url = canonicalizeUrl(item.page.inputUrl ?? item.page.finalUrl);
    if (!url) continue;
    await supabase(`discovered_urls?canonical_url=eq.${encodeURIComponent(url)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        status: "processed",
        final_url: item.page.finalUrl,
        content_hash: item.contentHash,
      }),
    });
  }
}

async function creditKnownSourceYield(records, insertedKeys, processedPages) {
  const inserted = new Set(insertedKeys);
  const bySource = new Map();
  for (const record of records) {
    for (const sourceId of new Set((record._provenance ?? [])
      .map((entry) => entry.sourceId).filter(Boolean))) {
      const value = bySource.get(sourceId) ?? { validated: new Set(), unique: new Set() };
      value.validated.add(record.canonical_key);
      if (inserted.has(record.canonical_key)) value.unique.add(record.canonical_key);
      bySource.set(sourceId, value);
    }
  }
  const emptyBySource = new Map();
  for (const item of processedPages) {
    if (item.records.length) continue;
    for (const sourceId of new Set((item.candidate.provenance ?? [])
      .map((entry) => entry.sourceId).filter(Boolean))) {
      const urls = emptyBySource.get(sourceId) ?? new Set();
      urls.add(item.candidate.url);
      emptyBySource.set(sourceId, urls);
      if (!bySource.has(sourceId)) bySource.set(sourceId, { validated: new Set(), unique: new Set() });
    }
  }
  const ids = [...bySource.keys()];
  if (!ids.length) return { sourcesCredited: 0, uniqueDiscoveries: 0 };
  const rows = await selectIn(
    "sources",
    "id,url,check_count,successful_discoveries,unique_discoveries,false_positive_count",
    "id",
    ids,
  );
  if (rows.length !== ids.length) throw new Error("SOURCE_YIELD_SOURCE_MISSING");
  let uniqueDiscoveries = 0;
  for (const source of rows) {
    const yieldData = bySource.get(source.id);
    const successes = Number(source.successful_discoveries ?? 0) + yieldData.validated.size;
    const uniques = Number(source.unique_discoveries ?? 0) + yieldData.unique.size;
    const falsePositives = [...(emptyBySource.get(source.id) ?? [])]
      .filter((url) => canonicalizeUrl(url) !== canonicalizeUrl(source.url)).length;
    uniqueDiscoveries += yieldData.unique.size;
    await supabase(`sources?id=eq.${encodeURIComponent(source.id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        successful_discoveries: successes,
        unique_discoveries: uniques,
        false_positive_count: Number(source.false_positive_count ?? 0) + falsePositives,
        yield_score: Number((uniques / Math.max(1, Number(source.check_count ?? 0))).toFixed(6)),
        ...(yieldData.unique.size ? { last_new_opportunity_at: new Date().toISOString() } : {}),
      }),
    });
  }
  return { sourcesCredited: rows.length, uniqueDiscoveries };
}

try {
  // Paid acquisition is never allowed to bypass the persistent budget ledger.
  await assertTemporalSchema();
  run = await startRun("discovery");
  const cloudflareParts = [config.cloudflareAccountId, config.cloudflareApiToken]
    .filter(Boolean).length;
  if (cloudflareParts === 1) {
    console.warn(
      "Cloudflare extraction is partially configured; paid gap search and LLM extraction are disabled",
    );
  }
  const cloudflareConfigured = cloudflareParts === 2;
  const groqConfigured = Boolean(
    config.groqFallbackEnabled && config.groqApiKey,
  );
  const extractionConfigured = cloudflareConfigured || groqConfigured;
  const budget = await getBudgetState();
  const requestedLimits = {
    queryLimit: config.discoveryQueryLimit,
    resultLimit: config.discoveryResultLimit,
    llmLimit: config.maxLlmCalls,
  };
  // Search volume follows the Exa pool; extraction follows the core pool.
  const exaLimits = limitsForBudget(budget.exaMode, requestedLimits);
  const budgetLimits = {
    ...limitsForBudget(budget.mode, requestedLimits),
    queryLimit: exaLimits.queryLimit,
    resultLimit: exaLimits.resultLimit,
  };
  const limits = extractionConfigured && cloudflareParts !== 1
    ? budgetLimits
    : { ...budgetLimits, queryLimit: 0, llmLimit: 0 };
  // Changed known sources are the primary path and remain eligible for the
  // free deterministic cascade even after paid operations have stopped.
  const knownCandidates = await pendingKnownSourceCandidates(config.freeProcessingLimit);
  const paidCandidateBudget = Math.max(0, limits.llmLimit);
  const attempts = limits.queryLimit > 0 ? await recentDiscoveryAttempts() : [];
  const queries = config.exaApiKey
    ? selectAdaptiveDiscoveryQueryDescriptors(limits.queryLimit, attempts)
    : [];
  if (!config.exaApiKey && limits.queryLimit > 0) {
    console.warn("EXA_API_KEY is absent; continuing with free known-source discovery");
  }
  const batches = paidCandidateBudget > 0
    ? await mapPool(queries, 4, (query) => searchExa(query, limits.resultLimit))
    : [];
  const discoveredCandidates = admitDiscoveryCandidates(batches, {
    limit: paidCandidateBudget,
    perHostLimit: 3,
  });
  const newGapUrls = await persistGapUrlSightings(discoveredCandidates, batches);
  const unique = new Map();
  for (const candidate of [...knownCandidates, ...discoveredCandidates]) {
    const url = canonicalizeUrl(candidate.url);
    if (!url) {
      recordRejection(metrics, "INVALID_URL");
      continue;
    }
    const existing = unique.get(url);
    if (existing) {
      existing.provenance.push(...candidate.provenance);
    } else {
      unique.set(url, { ...candidate, url });
    }
  }
  const candidates = [...unique.values()].slice(
    0,
    config.freeProcessingLimit + paidCandidateBudget,
  );
  incrementMetric(metrics, "discovered", candidates.length);

  const cache = await fetchUrlCache(candidates.map((candidate) => candidate.url));
  const observations = (await mapPool(candidates, 8, async (candidate) => {
    const existing = cache.get(candidate.url) ?? null;
    if (existing?.next_retry_at && Date.parse(existing.next_retry_at) > Date.now()) {
      recordRejection(metrics, "URL_RETRY_DEFERRED");
      return null;
    }
    try {
      const canUseConditional = existing?.processed_hash
        && existing.processed_hash === existing.content_hash;
      const page = await fetchPage(candidate.url, canUseConditional ? {
        etag: existing.etag,
        lastModified: existing.last_modified,
      } : {});
      incrementMetric(metrics, "fetched");
      const observation = page.notModified
        ? await observeNotModified(page, existing)
        : await observeFetchedPage(page, {
          sourceId: candidate.provenance.find((entry) => entry.sourceId)?.sourceId ?? null,
          existing,
        });
      if (observation.alreadyProcessed) {
        incrementMetric(metrics, "unchanged");
        return { candidate, page, ...observation, unchanged: true };
      }
      return { candidate, page, ...observation, unchanged: false };
    } catch (error) {
      await recordFetchFailure(candidate.url, error, existing).catch(() => {});
      recordRejection(metrics, error.code ?? "FETCH_FAILED");
      console.warn(`Fetch skipped ${candidate.url}: ${error.message}`);
      return null;
    }
  })).filter(Boolean);
  const unchangedPages = observations.filter((item) => item.unchanged);
  await persistExistingPageProvenance(unchangedPages, run.id);
  // Known-source pages without a call are settled for free; the LLM budget
  // then goes to the strongest call signals first.
  const scored = observations
    .filter((item) => !item.unchanged)
    .map((item) => {
      const ai = Boolean(item.candidate.aiSource) || isAiFilmText(item.page.text ?? "");
      return { ...item, ai, callSignal: scoreCallSignal(item.page.text ?? "", { lenient: ai }) };
    });
  const noSignal = scored.filter((item) =>
    !item.callSignal.pass
    && item.candidate.provenance.every((entry) => entry.provider === "source_monitor"),
  );
  if (noSignal.length) recordRejection(metrics, "NO_CALL_SIGNAL", noSignal.length);
  await markPagesProcessed(noSignal);
  const fetched = scored
    .filter((item) => !noSignal.includes(item))
    .sort((left, right) => Number(right.ai) - Number(left.ai) || right.callSignal.score - left.callSignal.score);

  let claimedLlmCalls = 0;
  const claimLlmCall = () => {
    if (claimedLlmCalls >= limits.llmLimit) return false;
    claimedLlmCalls += 1;
    return true;
  };
  const processedPages = await mapPool(
    fetched,
    config.llmConcurrency,
    async (item) => {
      try {
        const records = await processFetchedPage({
          page: item.page,
          title: item.candidate.title,
          sourceType: item.candidate.sourceType ?? "press",
          metrics,
          runId: run.id,
          operation: "discovery_extract",
          contentHash: item.contentHash,
          claimLlmCall,
        });
        return {
          ...item,
          records: records.map((record) =>
            withProvenance(record, item.candidate.provenance),
          ),
          processed: true,
        };
      } catch (error) {
        await deferPageProcessing(item.page, error.code ?? "EXTRACTION_FAILED")
          .catch(() => {});
        if (!error.metricsRecorded) {
          recordRejection(metrics, error.code ?? "EXTRACTION_FAILED");
        }
        console.warn(`Extraction skipped ${item.page.finalUrl}: ${error.message}`);
        return { ...item, records: [], processed: false };
      }
    },
  );

  const successfulPages = processedPages.filter((item) => item.processed);
  const deduped = dedupeOpportunitiesDetailed(
    successfulPages.flatMap((item) => item.records),
  );
  incrementMetric(metrics, "duplicates", deduped.duplicates);
  const result = await ingest(deduped.records, { temporalProjection: true });
  incrementMetric(metrics, "stored", result.stored);
  incrementMetric(metrics, "inserted", result.inserted);
  incrementMetric(metrics, "updated", result.updated);
  incrementMetric(metrics, "duplicates", result.legacyCollapsed);
  await persistProvenance(deduped.records, result.records, run.id);
  // Mark pages processed as soon as their records are stored, so a later
  // bookkeeping failure never makes the next run re-extract (and re-pay for)
  // the same pages.
  await markPagesProcessed(successfulPages);
  await markDiscoveredUrlsProcessed(successfulPages);
  // Temporal history is secondary bookkeeping: records and processed pages are
  // already stored. A failure here is recorded on the run (TEMPORAL_FAILED)
  // and logged instead of failing the whole discovery.
  let temporal = null;
  try {
    temporal = await persistTemporalObservations(
      deduped.records,
      result.records,
      run.id,
      {
        pageEvidence: successfulPages.flatMap((item) =>
          [item.page.inputUrl, item.page.finalUrl]
            .filter(Boolean)
            .map((url) => ({
              url,
              contentHash: item.contentHash,
              observedAt: item.page.checkedAt,
              pageText: item.page.text,
            })),
        ),
      },
    );
  } catch (error) {
    recordRejection(metrics, "TEMPORAL_FAILED");
    console.error(`Temporal observations failed: ${String(error.message).slice(0, 2000)}`);
  }
  const newSources = await registerProductiveSources(deduped.records);
  const sourceYield = await creditKnownSourceYield(
    deduped.records,
    result.insertedCanonicalKeys,
    successfulPages,
  );
  await persistDiscoveryYield(
    batches,
    discoveredCandidates,
    deduped.records,
    result.insertedCanonicalKeys,
    newSources,
    successfulPages,
  );

  await finishRun(run.id, metricsRunPatch(metrics));
  console.log(JSON.stringify({
    status: "succeeded",
    budget,
    effective_limits: limits,
    known_source_candidates: knownCandidates.length,
    new_organizer_sources: newSources.length,
    new_gap_urls: newGapUrls,
    source_yield: sourceYield,
    temporal,
    ...summarizeMetrics(metrics),
  }));
} catch (error) {
  try {
    if (run) await finishRun(run.id, {
      ...metricsRunPatch(metrics, "failed"),
      error: String(error.message).slice(0, 1000),
    });
  } catch (finishError) {
    console.error(`Unable to record failed discovery run: ${finishError.message}`);
  }
  console.error(error.message);
  process.exitCode = 1;
}
