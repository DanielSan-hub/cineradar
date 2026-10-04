import { createHash } from "node:crypto";

import { CALL_SIGNAL_VERSION, isAiFilmText, isAiSource, scoreCallSignal } from "./call-signal.mjs";
import { config } from "./config.mjs";
import { mapPool } from "./http.mjs";
import { BLOCKED_HOSTS } from "./registry-seeds.mjs";
import { createRobotsChecker } from "./robots.mjs";
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
  selectIn,
  startRun,
  supabase,
} from "./supabase.mjs";
import {
  canonicalizeUrl,
  selectSourceOpportunityLinks,
} from "./web-validation.mjs";
import { fetchPageOrRender } from "./browser-render.mjs";
import { isSeriesSource, pageHasPlatformLink, pageHasSubmissionLink } from "./series-extraction.mjs";

let run = null;
const metrics = createRunMetrics("monitor");
const USER_AGENT = "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)";
const robotsAllowed = createRobotsChecker({ userAgent: USER_AGENT });
const gate = { passed: 0, discarded: 0, robotsBlocked: 0, deferredByTimeBudget: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBlockedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
  } catch {
    return true;
  }
}

// Pages with no actionable call are settled here, for free, so discovery only
// spends extraction effort on pages that announce a submission window.
function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function gateCallSignal(page, observation, source) {
  if (page.notModified || observation.alreadyProcessed) return;
  const lenient = isAiSource(source) || isAiFilmText(page.text ?? "");
  const signal = scoreCallSignal(page.text ?? "", { lenient });
  // A festival site's "Submit on FilmFreeway/Festhome" link is a call signal
  // too: series-anchored extraction maps the call through that link. On a
  // known series' own site, a link to its Submit/Rules page is enough: the
  // extraction reads the call there.
  if (signal.pass || pageHasPlatformLink(page) || (isSeriesSource(source) && pageHasSubmissionLink(page))) {
    gate.passed += 1;
    return;
  }
  gate.discarded += 1;
  recordRejection(metrics, "NO_CALL_SIGNAL");
  const canonicalUrl = canonicalizeUrl(page.inputUrl ?? page.finalUrl);
  if (!canonicalUrl) return;
  const processedAt = new Date().toISOString();
  await supabase(`url_fetch_cache?canonical_url=eq.${encodeURIComponent(canonicalUrl)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      processed_hash: observation.contentHash,
      last_processed_at: processedAt,
      processor_version: CALL_SIGNAL_VERSION,
      updated_at: processedAt,
    }),
  });
}

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
  "festhome.com", "shortfilmdepot.com",
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
  // AI and other high-priority sites built as JavaScript apps are rendered
  // in a headless browser (capped per day) when the plain fetch is empty.
  const page = await fetchPageOrRender(url, useConditional ? {
    etag: existing.etag,
    lastModified: existing.last_modified,
  } : {}, { allowRender: true, runId: run?.id ?? null });
  if (page.rendered) incrementMetric(metrics, "rendered");
  incrementMetric(metrics, "fetched");
  const observation = page.notModified
    ? await observeNotModified(page, existing)
    : await observeFetchedPage(page, { sourceId: source.id, existing });
  if (observation.changed) incrementMetric(metrics, "discovered");
  else incrementMetric(metrics, "unchanged");
  await gateCallSignal(page, observation, source);
  return { page, observation };
}

/** A registered deep link that moved (404/410) falls back to the site's home page. */
async function fetchSourcePage(requestUrl, source, existing, options) {
  try {
    return await fetchObserved(requestUrl, source, existing, options);
  } catch (error) {
    let origin = null;
    try {
      const parsed = new URL(requestUrl);
      origin = parsed.pathname !== "/" ? `${parsed.origin}/` : null;
    } catch {
      origin = null;
    }
    if (!origin || !["HTTP_404", "HTTP_410"].includes(error.code) || !(await robotsAllowed(origin)).allowed) throw error;
    incrementMetric(metrics, "moved_page_fallbacks");
    return fetchObserved(origin, source, null, options);
  }
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
  // The oldest-first window alone never reaches new high-priority sources
  // while thousands are overdue, so priority sources are fetched separately.
  // PostgREST returns at most 1,000 rows per request: page through the window.
  const window = Math.min(7000, config.sourceRefreshLimit + 500);
  const overduePages = await Promise.all(
    Array.from({ length: Math.ceil(window / 1000) }, (_, page) => supabase(
      `sources?select=*&enabled=eq.true&or=(next_check_at.is.null,next_check_at.lte.${dueAt})&order=next_check_at.asc.nullsfirst,id.asc&limit=1000&offset=${page * 1000}`,
    )),
  );
  const overdue = overduePages.flat();
  const priorityDue = await supabase(
    `sources?select=*&enabled=eq.true&priority=lt.3&or=(next_check_at.is.null,next_check_at.lte.${dueAt})&order=priority.asc,next_check_at.asc.nullsfirst&limit=1000`,
  );
  const allSources = [...new Map([...overdue, ...priorityDue].map((source) => [source.id, source])).values()];
  // Festhome pages are read once a week at most (owner, 2026-10-03).
  const weekAgo = Date.now() - 7 * 86_400_000;
  const allowedSources = allSources.filter((source) => !/(?:^|\.)festhome\.com$/i.test(hostOfUrl(source.url))
    || !source.last_checked_at || Date.parse(source.last_checked_at) < weekAgo);
  const sources = selectDueSources(allowedSources, {
    now: new Date(),
    limit: config.sourceRefreshLimit,
  });
  const sourceIds = sources.map((source) => source.id);
  const checkpointRows = sourceIds.length
    ? await selectIn("source_checkpoints", "*", "source_id", sourceIds)
    : [];
  const checkpointBySource = new Map(checkpointRows.map((row) => [row.source_id, row]));
  // One malformed source URL (e.g. an e-mail address listed as a website)
  // must never stop the whole run: it is skipped and taken out of rotation.
  const plans = [];
  for (const source of sources) {
    const checkpoint = checkpointFor(source, checkpointBySource.get(source.id));
    try {
      plans.push({ source, checkpoint, requestUrl: buildNextSourceRequestUrl(source, checkpoint) });
    } catch (error) {
      recordRejection(metrics, "INVALID_SOURCE_URL");
      console.warn(`Skipping source ${source.id}: ${error.message}`);
      await supabase(`sources?id=eq.${source.id}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ enabled: false, health_status: "blocked", health_message: "INVALID_URL: not an absolute http(s) URL" }),
      }).catch(() => {});
    }
  }
  const initialCache = await fetchUrlCache(plans.map((plan) => plan.requestUrl));

  const deadline = Date.now() + config.monitorTimeBudgetSeconds * 1000;
  const results = await mapPool(plans, config.monitorConcurrency, async ({ source, checkpoint, requestUrl }) => {
    if (Date.now() > deadline) {
      gate.deferredByTimeBudget += 1;
      return { ok: false, skipped: true, changed: false, childPages: 0, newCandidateCount: 0 };
    }
    const startedAt = new Date().toISOString();
    const sourceUrl = canonicalizeUrl(requestUrl);
    const permission = isBlockedHost(requestUrl)
      ? { allowed: false, reason: "HOST_BLOCKS_AUTOMATION" }
      : await robotsAllowed(requestUrl);
    if (!permission.allowed) {
      gate.robotsBlocked += 1;
      recordRejection(metrics, permission.reason);
      // Unreachable robots.txt is transient; an explicit disallow is not. A
      // host name that fails to resolve on two checks in a row is a lapsed
      // domain: it leaves the rotation (DEAD_DOMAIN; the name resolver may
      // find the series' new site).
      const deadDomain = permission.reason === "DNS_NOT_FOUND" && Number(source.consecutive_failures ?? 0) >= 1
        && /DNS_NOT_FOUND/.test(String(source.health_message ?? ""));
      const blocked = deadDomain || !["ROBOTS_UNREACHABLE", "DNS_NOT_FOUND"].includes(permission.reason);
      await updateSource(source, blocked
        ? { checkedAt: startedAt, blocked: true, reason: deadDomain ? "DEAD_DOMAIN" : permission.reason }
        : { checkedAt: startedAt, failed: true, error: permission.reason });
      await recordAttempt(source, {
        status: blocked ? "blocked" : "failed",
        request_count: 1,
        result_count: 0,
        candidate_count: 0,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        request_url: requestUrl,
        error: permission.reason,
      });
      return { ok: false, changed: false, childPages: 0, newCandidateCount: 0 };
    }
    try {
      // Link-window adapters need the body to advance through different child
      // windows even when the directory hash itself is unchanged.
      const parent = await fetchSourcePage(
        requestUrl,
        source,
        initialCache.get(sourceUrl) ?? null,
        { forceBody: ["link-window", "page", "cursor"].includes(checkpoint.cursor_kind) },
      );
      const eligibleLinks = parent.page.notModified ? [] : selectSourceOpportunityLinks(
        source,
        parent.page.linkRecords,
        { sourceUrl: parent.page.finalUrl, limit: parent.page.linkRecords.length },
      ).filter((link) => sameHost(parent.page.finalUrl, link.url) && !isBlockedHost(link.url));
      const linkLimit = Math.min(config.monitorLinkLimit, checkpoint.link_window_size);
      const links = eligibleLinks.slice(checkpoint.link_offset, checkpoint.link_offset + linkLimit);
      const newCandidateCount = await observeDiscoveredUrls(source, links, startedAt);
      const childCache = await fetchUrlCache(links.map((link) => link.url));
      // Honour Crawl-delay between requests to the same site (capped per run).
      const delayMs = Math.min(Number(permission.crawlDelay ?? 0), 10) * 1000;
      const children = await mapPool(links, delayMs ? 1 : 2, async (link) => {
        const canonical = canonicalizeUrl(link.url);
        const childPermission = await robotsAllowed(link.url);
        if (!childPermission.allowed) {
          recordRejection(metrics, childPermission.reason);
          return { ok: false, changed: false };
        }
        if (delayMs) await sleep(delayMs);
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
      // Bookkeeping for one source must never abort the whole run.
      await updateSource(source, { checkedAt: startedAt, failed: true, error }).catch(() => {});
      await recordAttempt(source, {
        status: "failed",
        request_count: 1,
        result_count: 0,
        candidate_count: 0,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        request_url: requestUrl,
        error: String(error.message).slice(0, 1000),
      }).catch(() => {});
      return { ok: false, changed: false, childPages: 0, newCandidateCount: 0 };
    }
  });

  await finishRun(run.id, metricsRunPatch(metrics));
  console.log(JSON.stringify({
    status: "succeeded",
    sources_due_in_query: allSources.length,
    sources_due: sources.length,
    sources_checked: results.filter((result) => !result.skipped).length,
    sources_changed: results.filter((result) => result.changed).length,
    new_candidate_urls: results.reduce((sum, result) => sum + result.newCandidateCount, 0),
    child_pages_checked: results.reduce((sum, result) => sum + result.childPages, 0),
    call_signal: gate,
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
