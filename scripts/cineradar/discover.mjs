import { config, requireEnv, selectDiscoveryQueries } from "./config.mjs";
import { fetchWithTimeout, mapPool } from "./http.mjs";
import { dedupeOpportunitiesDetailed } from "./normalization.mjs";
import { processFetchedPage } from "./process-page.mjs";
import {
  createRunMetrics,
  incrementMetric,
  metricsRunPatch,
  recordRejection,
  summarizeMetrics,
} from "./telemetry.mjs";
import { finishRun, ingest, startRun } from "./supabase.mjs";
import { canonicalizeUrl, fetchPage } from "./web-validation.mjs";

requireEnv("EXA_API_KEY");

const run = await startRun("discovery");
const metrics = createRunMetrics("discovery");

async function searchExa(query) {
  incrementMetric(metrics, "queries");
  try {
    const response = await fetchWithTimeout("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": config.exaApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: config.discoveryResultLimit,
        contents: { highlights: { numSentences: 4 } },
      }),
    });
    if (!response.ok) throw new Error(`Exa ${response.status}: ${await response.text()}`);
    const body = await response.json();
    return body.results ?? [];
  } catch (error) {
    recordRejection(metrics, "DISCOVERY_QUERY_FAILED");
    console.warn(`Discovery query failed (${query.slice(0, 80)}): ${error.message}`);
    return [];
  }
}

try {
  const queries = selectDiscoveryQueries(config.discoveryQueryLimit);
  const batches = await mapPool(queries, 4, searchExa);
  const unique = new Map();
  for (const result of batches.flat()) {
    const url = canonicalizeUrl(result?.url);
    if (url && !unique.has(url)) unique.set(url, { ...result, url });
    else if (result?.url && !url) recordRejection(metrics, "INVALID_URL");
  }

  const candidates = [...unique.values()].slice(0, config.maxLlmCalls);
  incrementMetric(metrics, "discovered", candidates.length);
  const fetched = (await mapPool(candidates, 8, async (result) => {
    try {
      const page = await fetchPage(result.url);
      incrementMetric(metrics, "fetched");
      return { result, page };
    } catch (error) {
      recordRejection(metrics, error.code ?? "FETCH_FAILED");
      console.warn(`Fetch skipped ${result.url}: ${error.message}`);
      return null;
    }
  })).filter(Boolean);

  const pageRecords = await mapPool(fetched, config.llmConcurrency, async ({ result, page }) => {
    try {
      return await processFetchedPage({
        page,
        title: result.title,
        sourceType: "press",
        metrics,
      });
    } catch (error) {
      console.warn(`Extraction skipped ${page.finalUrl}: ${error.message}`);
      return [];
    }
  });

  const deduped = dedupeOpportunitiesDetailed(pageRecords.flat());
  incrementMetric(metrics, "duplicates", deduped.duplicates);
  const result = await ingest(deduped.records);
  incrementMetric(metrics, "stored", result.stored);
  incrementMetric(metrics, "inserted", result.inserted);
  incrementMetric(metrics, "updated", result.updated);
  incrementMetric(metrics, "duplicates", result.legacyCollapsed);

  await finishRun(run.id, metricsRunPatch(metrics));
  console.log(JSON.stringify({ status: "succeeded", ...summarizeMetrics(metrics) }));
} catch (error) {
  try {
    await finishRun(run.id, {
      ...metricsRunPatch(metrics, "failed"),
      error: String(error.message).slice(0, 1000),
    });
  } catch (finishError) {
    console.error(`Unable to record failed discovery run: ${finishError.message}`);
  }
  throw error;
}
