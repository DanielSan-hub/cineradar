import { createHash } from "node:crypto";

import { config } from "./config.mjs";
import { mapPool } from "./http.mjs";
import {
  fetchUrlCache,
  observeFetchedPage,
  observeNotModified,
  recordFetchFailure,
} from "./operations.mjs";
import {
  advanceSourceCheckpoint,
  buildNextSourceRequestUrl,
  selectDueSources,
  sourceOutcomePatch,
} from "./source-registry.mjs";
import {
  createRunMetrics,
  incrementMetric,
  metricsRunPatch,
  recordRejection,
  summarizeMetrics,
} from "./telemetry.mjs";
import {
  assertSourceRegistrySchema,
  finishRun,
  startRun,
  supabase,
} from "./supabase.mjs";
import {
  canonicalizeUrl,
  fetchPage,
  selectSourceOpportunityLinks,
} from "./web-validation.mjs";

let run = null;
const metrics = createRunMetrics("monitor");

function attemptKey(sourceId, checkedAt) {
  return createHash("sha256")
    .update([run.id, sourceId, checkedAt].join("\u001f"))
    .digest("hex");
}

async function updateSource(source, outcome) {
  return supabase(`sources?id=eq.${encodeURIComponent(source.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(sourceOutcomePatch(source, outcome)),
  });
}

const SUBMISSION_HOSTS = new Set([
  "filmfreeway.com", "festhome.com", "shortfilmdepot.com",
  "submittable.com", "eventival.com", "filmfestplatform.com",
]);

function sameHost(left, right) {
  try {
    const sourceHost = new URL(left).hostname.replace(/^www\./i, "").toLowerCase();
    const childHost = new URL(right).hostname.replace(/^www\./i, "").toLowerCase();
    return sourceHost === childHost
      || [...SUBMISSION_HOSTS].some((host) => childHost === host || childHost.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function checkpointFor(source, stored) {
  if (stored) return stored;
  const configuredKind = source.adapter_config?.cursor_kind;
  const cursorKind = configuredKind
    ?? (new Set(["page", "cursor"]).has(source.adapter)
      ? source.adapter
      : "link-window");
  return {
    source_id: source.id,
    checkpoint_key: source.adapter_config?.checkpoint_key ?? "default",
    cursor_kind: cursorKind,
    cursor_value: null,
    page_number: 1,
    link_offset: 0,
    link_window_size: Number(source.adapter_config?.link_window_size ?? config.monitorLinkLimit),
    cycle_count: 0,
    request_count: 0,
    state: {},
  };
}

async function persistCheckpoint(source, checkpoint, outcome) {
  const next = advanceSourceCheckpoint(checkpoint, outcome, {
    maxPageNumber: Number(source.adapter_config?.max_pages ?? 10),
    linkWindowSize: Number(source.adapter_config?.link_window_size ?? config.monitorLinkLimit),
  });
  return supabase("source_checkpoints?on_conflict=source_id,checkpoint_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify([{
      source_id: source.id,
      checkpoint_key: checkpoint.checkpoint_key,
      ...next,
    }]),
  });
}

async function fetchObserved(url, source, existing, { forceBody = false } = {}) {
  const useConditional = !forceBody
    && existing?.processed_hash
    && existing.processed_hash === existing.content_hash;
  const page = await fetchPage(url, useConditional ? {
    etag: existing.etag,
    lastModified: existing.last_modified,
  } : {});
  incrementMetric(metrics, "fetched");
  const observation = page.notModified
    ? await observeNotModified(page, existing)
    : await observeFetchedPage(page, { sourceId: source.id, existing });
  if (observation.changed) incrementMetric(metrics, "discovered");
  else incrementMetric(metrics, "unchanged");
  return { page, observation };
}

async function observeDiscoveredUrls(source, links, checkedAt) {
  let newCount = 0;
  for (const link of links) {
    const canonicalUrl = canonicalizeUrl(link.url);
    if (!canonicalUrl) continue;
    const existing = await supabase(
      `discovered_urls?select=id,seen_count,first_seen_at&source_id=eq.${encodeURIComponent(source.id)}&canonical_url=eq.${encodeURIComponent(canonicalUrl)}&limit=1`,
    );
    if (existing.length) {
      await supabase(`discovered_urls?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          last_seen_at: checkedAt,
          seen_count: Number(existing[0].seen_count ?? 0) + 1,
          metadata: { link_text: String(link.text ?? "").slice(0, 240) },
        }),
      });
    } else {
      newCount += 1;
      await supabase("discovered_urls", {
        method: "POST",
        prefer: "return=minimal",
        body: JSON.stringify([{
          canonical_url: canonicalUrl,
          source_id: source.id,
          status: "candidate",
          first_seen_at: checkedAt,
          last_seen_at: checkedAt,
          seen_count: 1,
          metadata: { link_text: String(link.text ?? "").slice(0, 240) },
        }]),
      });
    }
  }
  return newCount;
}

async function recordAttempt(source, values) {
  return supabase("discovery_attempts?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify([{
      idempotency_key: attemptKey(source.id, values.started_at),
      pipeline_run_id: run.id,
      source_id: source.id,
      attempt_kind: "source",
      provider: "http",
      operation: "incremental-monitor",
      category: source.opportunity_categories?.[0] ?? null,
      region: source.region ?? null,
      language: source.language ?? null,
      status: values.status,
      request_count: values.request_count,
      result_count: values.result_count,
      candidate_count: values.candidate_count,
      validated_count: 0,
      unique_opportunity_count: 0,
      unique_source_count: 0,
      false_positive_count: values.false_positive_count ?? 0,
      estimated_cost_eur: 0,
      started_at: values.started_at,
      finished_at: values.finished_at,
      error: values.error ?? null,
      metadata: {
        source_family: source.source_family,
        adapter: source.adapter,
        request_url: values.request_url,
      },
    }]),
  });
}

try {
  await assertSourceRegistrySchema();
  run = await startRun("monitor");
  const dueAt = encodeURIComponent(new Date().toISOString());
  const allSources = await supabase(
    `sources?select=*&enabled=eq.true&or=(next_check_at.is.null,next_check_at.lte.${dueAt})&order=next_check_at.asc.nullsfirst&limit=2000`,
  );
  const sources = selectDueSources(allSources, {
    now: new Date(),
    limit: config.sourceRefreshLimit,
  });
  const sourceIds = sources.map((source) => source.id);
  const checkpointRows = sourceIds.length
    ? await supabase(`source_checkpoints?select=*&source_id=in.(${sourceIds.join(",")})&limit=2000`)
    : [];
  const checkpointBySource = new Map(checkpointRows.map((row) => [row.source_id, row]));
  const plans = sources.map((source) => {
    const checkpoint = checkpointFor(source, checkpointBySource.get(source.id));
    return { source, checkpoint, requestUrl: buildNextSourceRequestUrl(source, checkpoint) };
  });
  const initialCache = await fetchUrlCache(plans.map((plan) => plan.requestUrl));

  const results = await mapPool(plans, 6, async ({ source, checkpoint, requestUrl }) => {
    const startedAt = new Date().toISOString();
    const sourceUrl = canonicalizeUrl(requestUrl);
    try {
      // Link-window adapters need the body to advance through different child
      // windows even when the directory hash itself is unchanged.
      const parent = await fetchObserved(
        requestUrl,
        source,
        initialCache.get(sourceUrl) ?? null,
        { forceBody: ["link-window", "page", "cursor"].includes(checkpoint.cursor_kind) },
      );
      const eligibleLinks = parent.page.notModified ? [] : selectSourceOpportunityLinks(
        source,
        parent.page.linkRecords,
        { sourceUrl: parent.page.finalUrl, limit: parent.page.linkRecords.length },
      ).filter((link) => sameHost(parent.page.finalUrl, link.url));
      const linkLimit = Math.min(config.monitorLinkLimit, checkpoint.link_window_size);
      const links = eligibleLinks.slice(checkpoint.link_offset, checkpoint.link_offset + linkLimit);
      const newCandidateCount = await observeDiscoveredUrls(source, links, startedAt);
      const childCache = await fetchUrlCache(links.map((link) => link.url));
      const children = await mapPool(links, 2, async (link) => {
        const canonical = canonicalizeUrl(link.url);
        try {
          const child = await fetchObserved(
            link.url,
            source,
            childCache.get(canonical) ?? null,
          );
          return { ok: true, changed: child.observation.changed };
        } catch (error) {
          await recordFetchFailure(
            link.url,
            error,
            childCache.get(canonical) ?? null,
          ).catch(() => {});
          recordRejection(metrics, error.code ?? "FETCH_FAILED");
          return { ok: false, changed: false };
        }
      });
      const changed = parent.observation.changed || children.some((child) => child.changed);
      const lastSeenUrl = links.at(-1)?.url ?? requestUrl;
      await persistCheckpoint(source, checkpoint, {
        checkedAt: startedAt,
        totalLinks: eligibleLinks.length,
        linkWindowSize: Math.max(1, linkLimit),
        hasMore: links.length > 0 && !(
          checkpoint.cursor_kind === "page"
          && checkpoint.page_number > 1
          && checkpoint.last_content_hash === parent.observation.contentHash
        ),
        lastSeenUrl,
        contentHash: parent.observation.contentHash,
      });
      await updateSource(source, {
        checkedAt: startedAt,
        changed,
        candidateCount: newCandidateCount,
      });
      await recordAttempt(source, {
        status: "succeeded",
        request_count: 1 + children.length,
        result_count: links.length,
        candidate_count: newCandidateCount,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        request_url: requestUrl,
      });
      return { ok: true, changed, childPages: children.length, newCandidateCount };
    } catch (error) {
      await recordFetchFailure(
        requestUrl,
        error,
        initialCache.get(sourceUrl) ?? null,
      ).catch(() => {});
      recordRejection(metrics, error.code ?? "FETCH_FAILED");
      console.warn(`Refresh failed for ${requestUrl}: ${error.message}`);
      await updateSource(source, { checkedAt: startedAt, failed: true, error });
      await recordAttempt(source, {
        status: "failed",
        request_count: 1,
        result_count: 0,
        candidate_count: 0,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        request_url: requestUrl,
        error: String(error.message).slice(0, 1000),
      });
      return { ok: false, changed: false, childPages: 0, newCandidateCount: 0 };
    }
  });

  await finishRun(run.id, metricsRunPatch(metrics));
  console.log(JSON.stringify({
    status: "succeeded",
    sources_due_in_query: allSources.length,
    sources_due: sources.length,
    sources_checked: results.length,
    sources_changed: results.filter((result) => result.changed).length,
    new_candidate_urls: results.reduce((sum, result) => sum + result.newCandidateCount, 0),
    child_pages_checked: results.reduce((sum, result) => sum + result.childPages, 0),
    llm_calls: 0,
    ...summarizeMetrics(metrics),
  }));
} catch (error) {
  try {
    if (run) await finishRun(run.id, {
      ...metricsRunPatch(metrics, "failed"),
      error: String(error.message).slice(0, 1000),
    });
  } catch (finishError) {
    console.error(`Unable to record failed refresh run: ${finishError.message}`);
  }
  console.error(error.message);
  process.exitCode = 1;
}
