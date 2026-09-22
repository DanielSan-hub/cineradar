import { createHash } from "node:crypto";

import { config } from "./config.mjs";
import { mapPool } from "./http.mjs";
import { dedupeOpportunitiesDetailed } from "./normalization.mjs";
import { processFetchedPage } from "./process-page.mjs";
import {
  createRunMetrics,
  incrementMetric,
  metricsRunPatch,
  recordRejection,
  summarizeMetrics,
} from "./telemetry.mjs";
import { finishRun, ingest, startRun, supabase } from "./supabase.mjs";
import { canonicalizeUrl, fetchPage, selectOpportunityLinks } from "./web-validation.mjs";

const run = await startRun("monitor");
const metrics = createRunMetrics("monitor");

async function updateSource(source, values) {
  return supabase(`sources?id=eq.${encodeURIComponent(source.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(values),
  });
}

function sameHost(left, right) {
  try { return new URL(left).hostname === new URL(right).hostname; } catch { return false; }
}

try {
  const sources = await supabase(
    "sources?select=*&enabled=eq.true&order=tier.asc,updated_at.asc&limit=2000",
  );
  const fetchedSources = await mapPool(sources, 8, async (source) => {
    const checkedAt = new Date().toISOString();
    try {
      const page = await fetchPage(source.url);
      incrementMetric(metrics, "fetched");
      const hash = createHash("sha256").update(page.text).digest("hex");
      const changed = hash !== source.last_hash;
      await updateSource(source, {
        last_checked_at: checkedAt,
        consecutive_failures: 0,
        ...(!changed ? { last_hash: hash } : {}),
      });
      return { source, page, hash, changed };
    } catch (error) {
      recordRejection(metrics, error.code ?? "FETCH_FAILED");
      console.warn(`Monitor failed for ${source.url}: ${error.message}`);
      await updateSource(source, {
        last_checked_at: checkedAt,
        consecutive_failures: Number(source.consecutive_failures ?? 0) + 1,
      });
      return null;
    }
  });

  const changed = fetchedSources.filter((item) => item?.changed);
  incrementMetric(metrics, "discovered", changed.length);

  // Prefer one high-signal call/application link per source; use the source page
  // itself when it exposes no such link. A second link is added round-robin only
  // while the global LLM budget allows it.
  const primaryTasks = [];
  const secondaryTasks = [];
  const seenUrls = new Set();
  for (const item of changed) {
    const links = selectOpportunityLinks(item.page.linkRecords, {
      sourceUrl: item.page.finalUrl,
      limit: config.monitorLinkLimit,
    });
    const sourceCandidate = {
      url: item.page.finalUrl,
      title: item.source.name,
      existingPage: item.page,
    };
    const linkCandidates = links
      .filter((link) => sameHost(item.page.finalUrl, link.url))
      .map((link) => ({
        url: link.url,
        title: link.text || item.source.name,
      }));
    const candidates = linkCandidates.length
      ? [...linkCandidates, sourceCandidate]
      : [sourceCandidate];
    candidates.forEach((candidate, index) => {
      const url = canonicalizeUrl(candidate.url);
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);
      const task = { parent: item, ...candidate, url };
      (index === 0 ? primaryTasks : secondaryTasks).push(task);
    });
  }
  const tasks = [...primaryTasks, ...secondaryTasks].slice(0, config.maxLlmCalls);

  const fetchedTasks = (await mapPool(tasks, 6, async (task) => {
    if (task.existingPage) return { ...task, page: task.existingPage };
    try {
      const page = await fetchPage(task.url);
      incrementMetric(metrics, "fetched");
      return { ...task, page };
    } catch (error) {
      recordRejection(metrics, error.code ?? "FETCH_FAILED");
      console.warn(`Candidate fetch skipped ${task.url}: ${error.message}`);
      return null;
    }
  })).filter(Boolean);

  const processedTasks = await mapPool(
    fetchedTasks,
    config.llmConcurrency,
    async (task) => {
      try {
        const sourceType = sameHost(task.parent.page.finalUrl, task.page.finalUrl)
          ? task.parent.source.source_type
          : "press";
        const records = await processFetchedPage({
          page: task.page,
          title: task.title,
          sourceType,
          metrics,
        });
        return { ...task, records, processed: true };
      } catch (error) {
        console.warn(`Extraction will be retried for ${task.url}: ${error.message}`);
        return { ...task, records: [], processed: false };
      }
    },
  );

  const successfulSourceIds = new Set(
    processedTasks.filter((task) => task.processed).map((task) => task.parent.source.id),
  );
  const deduped = dedupeOpportunitiesDetailed(
    processedTasks.filter((task) => task.processed).flatMap((task) => task.records),
  );
  incrementMetric(metrics, "duplicates", deduped.duplicates);
  const result = await ingest(deduped.records);
  incrementMetric(metrics, "stored", result.stored);
  incrementMetric(metrics, "inserted", result.inserted);
  incrementMetric(metrics, "updated", result.updated);
  incrementMetric(metrics, "duplicates", result.legacyCollapsed);

  const changedAt = new Date().toISOString();
  const successfulSources = changed.filter((item) => successfulSourceIds.has(item.source.id));
  await mapPool(successfulSources, 6, (item) => updateSource(item.source, {
    last_hash: item.hash,
    last_changed_at: changedAt,
    last_checked_at: item.page.checkedAt,
    consecutive_failures: 0,
  }));
  const failedSources = changed.filter((item) =>
    tasks.some((task) => task.parent.source.id === item.source.id)
    && !successfulSourceIds.has(item.source.id));
  await mapPool(failedSources, 6, (item) => updateSource(item.source, {
    consecutive_failures: Number(item.source.consecutive_failures ?? 0) + 1,
  }));

  await finishRun(run.id, metricsRunPatch(metrics));
  console.log(JSON.stringify({
    status: "succeeded",
    sources_checked: sources.length,
    changed_sources: changed.length,
    source_hashes_committed: successfulSources.length,
    candidate_pages: tasks.length,
    changed_deferred: changed.filter((item) =>
      !tasks.some((task) => task.parent.source.id === item.source.id)).length,
    ...summarizeMetrics(metrics),
  }));
} catch (error) {
  try {
    await finishRun(run.id, {
      ...metricsRunPatch(metrics, "failed"),
      error: String(error.message).slice(0, 1000),
    });
  } catch (finishError) {
    console.error(`Unable to record failed monitor run: ${finishError.message}`);
  }
  throw error;
}
