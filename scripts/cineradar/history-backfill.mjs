import { createHash } from "node:crypto";

import { config } from "./config.mjs";
import {
  fetchUrlCache,
  observeFetchedPage,
  observeNotModified,
  recordFetchFailure,
} from "./operations.mjs";
import {
  assertOperationalSchema,
  assertTemporalSchema,
  finishRun,
  startRun,
  supabase,
} from "./supabase.mjs";
import {
  createRunMetrics,
  incrementMetric,
  metricsRunPatch,
  recordRejection,
  summarizeMetrics,
} from "./telemetry.mjs";
import { canonicalizeUrl, fetchPage, plainText } from "./web-validation.mjs";

const MIN_HISTORY_YEAR = 2023;
const MAX_HISTORY_YEAR = new Date().getUTCFullYear();
const CHECKPOINT_KEY = "historical";
const MAX_LINKS_SCANNED_PER_PAGE = 500;
const MAX_CANDIDATE_LINKS_PER_PAGE = 40;
const MAX_PENDING_URLS_PER_SOURCE = 100;
const MAX_VISITED_URLS_PER_SOURCE = 500;
const MAX_FETCH_FAILURES_PER_URL = 3;
const ROOT_REVISIT_DAYS = 90;
const OFFICIAL_SOURCE_FAMILIES = new Set([
  "official-site",
  "film-funding",
  "media-art-residency",
  "ai-creative-tech",
  "arts-institution",
  "platform-company",
]);

const ARCHIVE_SIGNAL = /(?:archive|archivio|archivo|arquivo|history|historique|past[-_ ]?(?:editions?|events?|calls?)|previous[-_ ]?(?:editions?|years?)|editions?|ann(?:e|ee|e)e?s?|jahrgang|ã‚¢ãƒ¼ã‚«ã‚¤ãƒ–|éŽåŽ»|ì•„ì¹´ì´ë¸Œ|åŽ†å±Š|Ø£Ø±Ø´ÙŠÙ)/iu;
const NON_PAGE_ASSET = /\.(?:avif|css|docx?|gif|ico|jpe?g|json|mp3|mp4|mov|pdf|png|pptx?|rss|svg|webm|webp|xlsx?|xml|zip)(?:\?|$)/iu;
const HISTORICAL_OPPORTUNITY_SIGNAL = /festival|film|cinema|video|animation|competition|contest|challenge|grant|fund|residen|fellowship|\blab\b|biennial|open call|commission|edital|bando|convocatoria|audiovisual/iu;
const LOCAL_ARCHIVE_SIGNAL = /\u30a2\u30fc\u30ab\u30a4\u30d6|\u904e\u53bb|\u6b74\u4ee3|\u5386\u5c4a|\u5f80\u5c4a|\uc544\uce74\uc774\ube0c|\uc9c0\ub09c|\uc5ed\ub300|\u0623\u0631\u0634\u064a\u0641|\u0627\u0644\u0633\u0627\u0628\u0642\u0629/iu;

const pageLimit = Math.min(
  20,
  Math.max(5, Math.trunc(Number(config.historicalPageLimit) || 10)),
);

const counters = {
  page_limit: pageLimit,
  sources_eligible: 0,
  sources_advanced: 0,
  pages_attempted: 0,
  pages_inspected: 0,
  pages_changed: 0,
  pages_unchanged: 0,
  fetch_failures: 0,
  cross_host_skips: 0,
  links_scanned: 0,
  links_outside_window: 0,
  historical_urls_found: 0,
  historical_urls_inserted: 0,
  historical_urls_seen_again: 0,
  observations_inserted: 0,
  observation_duplicates: 0,
  series_created: 0,
  editions_created: 0,
  opportunities_linked_to_editions: 0,
  checkpoints_written: 0,
  exa_calls: 0,
  llm_calls: 0,
  paid_api_calls: 0,
  forecasts_created: 0,
};

function sha256(parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex");
}

function hostname(value) {
  const canonical = canonicalizeUrl(value);
  return canonical ? new URL(canonical).hostname : null;
}

function sameHost(left, right) {
  const leftHost = hostname(left);
  const rightHost = hostname(right);
  return leftHost !== null && rightHost !== null
    && leftHost.replace(/^www\./, "") === rightHost.replace(/^www\./, "");
}

function uniqueCanonicalUrls(values, sourceUrl) {
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    const url = canonicalizeUrl(value, sourceUrl);
    if (!url || seen.has(url) || !sameHost(sourceUrl, url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function yearsIn(value) {
  const years = String(value ?? "").match(/\b20\d{2}\b/g) ?? [];
  return [...new Set(years.map(Number).filter(Number.isInteger))];
}

function historicalLink(record, source) {
  const sourceUrl = source.url;
  const url = canonicalizeUrl(record?.url, sourceUrl);
  if (!url || !sameHost(sourceUrl, url) || NON_PAGE_ASSET.test(url)) return null;
  const evidence = `${url} ${record?.text ?? ""}`;
  const years = yearsIn(evidence);
  if (years.length > 0) {
    const inWindow = years.filter(
      (year) => year >= MIN_HISTORY_YEAR && year <= MAX_HISTORY_YEAR,
    );
    if (!inWindow.length) return { outsideWindow: true };
    const yearOnlyPath = /\/20\d{2}(?:\/|$)/u.test(new URL(url).pathname)
      && (source.opportunity_categories ?? []).length > 0;
    if (
      !ARCHIVE_SIGNAL.test(evidence)
      && !LOCAL_ARCHIVE_SIGNAL.test(evidence)
      && !HISTORICAL_OPPORTUNITY_SIGNAL.test(evidence)
      && !yearOnlyPath
    ) return null;
    return { url, years: inWindow, text: String(record?.text ?? "").slice(0, 240) };
  }
  if (!ARCHIVE_SIGNAL.test(evidence) && !LOCAL_ARCHIVE_SIGNAL.test(evidence)) return null;
  return { url, years: [], text: String(record?.text ?? "").slice(0, 240) };
}

function selectHistoricalLinks(page, source) {
  const selected = new Map();
  const records = (page.linkRecords ?? []).slice(0, MAX_LINKS_SCANNED_PER_PAGE);
  counters.links_scanned += records.length;
  for (const record of records) {
    const candidate = historicalLink(record, source);
    if (candidate?.outsideWindow) {
      counters.links_outside_window += 1;
      continue;
    }
    if (!candidate || selected.has(candidate.url)) continue;
    selected.set(candidate.url, candidate);
    if (selected.size >= MAX_CANDIDATE_LINKS_PER_PAGE) break;
  }
  return [...selected.values()];
}

function collectConfiguredHistoryUrls(source) {
  const adapterConfig = source.adapter_config;
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) {
    return [];
  }
  const values = [];
  const walk = (value, path = "", depth = 0) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/(?:histor|archive|past|edition)/iu.test(path)) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 50)) walk(entry, path, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      walk(entry, `${path}.${key}`, depth + 1);
    }
  };
  walk(adapterConfig);
  return uniqueCanonicalUrls(values, source.url);
}

function checkpointWork(source, checkpoint) {
  const state = checkpoint?.state && typeof checkpoint.state === "object"
    ? checkpoint.state
    : {};
  const visited = uniqueCanonicalUrls(state.visited_urls ?? [], source.url)
    .slice(-MAX_VISITED_URLS_PER_SOURCE);
  const visitedSet = new Set(visited);
  const configured = collectConfiguredHistoryUrls(source);
  const pending = uniqueCanonicalUrls(
    [...(state.pending_urls ?? []), ...configured],
    source.url,
  ).filter((url) => !visitedSet.has(url));
  const rootUrl = canonicalizeUrl(source.url);
  const completedAt = Date.parse(checkpoint?.completed_cycle_at ?? "");
  const revisitRoot = Boolean(
    checkpoint?.exhausted
    && Number.isFinite(completedAt)
    && Date.now() - completedAt >= ROOT_REVISIT_DAYS * 24 * 60 * 60 * 1000,
  );

  if (
    ((!checkpoint || Number(checkpoint.request_count ?? 0) === 0)
      && !visitedSet.has(rootUrl))
    || revisitRoot
  ) {
    pending.push(rootUrl);
  }

  const queue = [...new Set(pending.filter(Boolean))]
    .slice(0, MAX_PENDING_URLS_PER_SOURCE);
  if (!queue.length) return null;
  return { source, checkpoint, state, visited, url: queue[0], queue };
}

function checkedTime(work) {
  const value = Date.parse(work.checkpoint?.last_checked_at ?? "");
  return Number.isFinite(value) ? value : 0;
}

function quotedInValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function assertHistoricalSchema() {
  await assertOperationalSchema();
  await assertTemporalSchema();
  try {
    await Promise.all([
      supabase("sources?select=id,adapter_config,health_status&limit=1"),
      supabase("source_checkpoints?select=id,state&limit=1"),
      supabase("discovery_attempts?select=id&limit=1"),
      supabase("discovered_urls?select=id&limit=1"),
      supabase("event_series?select=id&limit=1"),
      supabase("opportunity_editions?select=id&limit=1"),
      supabase("opportunity_observations?select=id&limit=1"),
    ]);
  } catch (error) {
    throw new Error(
      "HISTORICAL_SCHEMA_REQUIRED: apply "
      + "202609230002_source_registry_and_economics.sql and "
      + `202609230003_temporal_history.sql (${error.message})`,
    );
  }
}

async function loadWorkItems() {
  const [sources, checkpoints] = await Promise.all([
    supabase(
      "sources?select=*&enabled=eq.true&health_status=not.in.(blocked,paused)"
      + "&order=priority.asc,updated_at.asc&limit=2000",
    ),
    supabase(
      `source_checkpoints?select=*&checkpoint_key=eq.${CHECKPOINT_KEY}&limit=2000`,
    ),
  ]);
  const checkpointBySource = new Map(
    checkpoints.map((checkpoint) => [checkpoint.source_id, checkpoint]),
  );
  const work = sources
    .map((source) => checkpointWork(source, checkpointBySource.get(source.id) ?? null))
    .filter(Boolean)
    .sort((left, right) => (
      checkedTime(left) - checkedTime(right)
      || Number(left.source.priority ?? 3) - Number(right.source.priority ?? 3)
      || left.source.url.localeCompare(right.source.url)
    ));
  counters.sources_eligible = work.length;
  return work.slice(0, pageLimit);
}

async function startAttempt(run, work) {
  const [attempt] = await supabase("discovery_attempts", {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify([{
      idempotency_key: `historical:${run.id}:${work.source.id}`,
      pipeline_run_id: run.id,
      source_id: work.source.id,
      attempt_kind: "historical",
      provider: "http",
      operation: "historical-page-fetch",
      status: "running",
      estimated_cost_eur: 0,
      metadata: {
        min_year: MIN_HISTORY_YEAR,
        max_year: MAX_HISTORY_YEAR,
        page_limit: pageLimit,
        page_url: work.url,
        no_forecasting: true,
      },
    }]),
  });
  return attempt;
}

async function finishAttempt(attempt, values) {
  if (!attempt?.id) return;
  await supabase(`discovery_attempts?id=eq.${encodeURIComponent(attempt.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      ...values,
      finished_at: new Date().toISOString(),
    }),
  });
}

async function existingDiscoveredUrls(sourceId, urls) {
  if (!urls.length) return new Map();
  const rows = [];
  for (let index = 0; index < urls.length; index += 20) {
    const batch = urls.slice(index, index + 20);
    const params = new URLSearchParams({
      select: "*",
      source_id: `eq.${sourceId}`,
      canonical_url: `in.(${batch.map(quotedInValue).join(",")})`,
      limit: "1000",
    });
    rows.push(...await supabase(`discovered_urls?${params.toString()}`));
  }
  return new Map(rows.map((row) => [row.canonical_url, row]));
}

async function persistHistoricalUrls(work, attempt, parentUrl, candidates) {
  const urls = candidates.map((candidate) => candidate.url);
  const existing = await existingDiscoveredUrls(work.source.id, urls);
  const observedAt = new Date().toISOString();
  const inserts = [];

  for (const candidate of candidates) {
    const prior = existing.get(candidate.url);
    const historicalMetadata = {
      min_year: MIN_HISTORY_YEAR,
      max_year: MAX_HISTORY_YEAR,
      year_signals: candidate.years,
      discovered_from_url: parentUrl,
      link_text: candidate.text,
      no_forecasting: true,
    };
    if (!prior) {
      inserts.push({
        canonical_url: candidate.url,
        source_id: work.source.id,
        first_discovery_attempt_id: attempt.id,
        last_discovery_attempt_id: attempt.id,
        status: "candidate",
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        seen_count: 1,
        metadata: { historical: historicalMetadata },
      });
      continue;
    }
    await supabase(`discovered_urls?id=eq.${encodeURIComponent(prior.id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        last_discovery_attempt_id: attempt.id,
        last_seen_at: observedAt,
        seen_count: Number(prior.seen_count ?? 1) + 1,
        metadata: {
          ...(prior.metadata ?? {}),
          historical: historicalMetadata,
        },
      }),
    });
  }

  let inserted = [];
  if (inserts.length) {
    inserted = await supabase("discovered_urls", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify(inserts),
    });
  }
  counters.historical_urls_inserted += inserted.length;
  counters.historical_urls_seen_again += existing.size;
  return { inserted: inserted.length, existing: existing.size };
}

async function matchingOpportunities(urls) {
  const canonical = [...new Set(urls.map((url) => canonicalizeUrl(url)).filter(Boolean))];
  if (!canonical.length) return [];
  const values = canonical.map(quotedInValue).join(",");
  const params = new URLSearchParams({
    select: "id,opportunity_edition_id,source_url,official_url,application_url,title,edition_year",
    or: `(source_url.in.(${values}),official_url.in.(${values}),application_url.in.(${values}))`,
    limit: "1000",
  });
  return supabase(`opportunities?${params.toString()}`);
}

function normalizedSeriesName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\b20\d{2}\b/g, " ")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function datedEditionEvidence(work, page) {
  if (
    page.notModified
    || work.source.source_type !== "official"
    || !OFFICIAL_SOURCE_FAMILIES.has(work.source.source_family)
  ) return null;

  const heading = plainText(page.html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!heading || heading.length > 200) return null;
  if (/\b20\d{2}\s*[/–—-]\s*(?:\d{2}|20\d{2})\b/u.test(heading)) return null;
  const years = yearsIn(heading).filter(
    (year) => year >= MIN_HISTORY_YEAR && year <= MAX_HISTORY_YEAR,
  );
  if (years.length !== 1) return null;
  const year = years[0];
  const seriesName = heading.replace(new RegExp(`\\b${year}\\b`, "g"), " ")
    .replace(/\b\d{1,3}(?:st|nd|rd|th)\s+(?:annual\s+)?edition\b/giu, " ")
    .replace(/[|–—:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedName = normalizedSeriesName(seriesName);
  const genericName = /^(?:open call|call for (?:entries|applications|projects)|applications?|submissions?|festival|film festival|funding|grants?|past editions?|archive|history)$/iu;
  const listingName = /\b(?:archive|archives|history|past editions|previous editions|all editions|winners|programme|program)\b/iu;
  const opportunityName = /festival|film|cinema|video|animation|competition|contest|challenge|grant|fund|residen|fellowship|\blab\b|biennial|open call|commission|edital|bando|convocatoria|audiovisual/iu;
  const pathHasYear = new RegExp(`(?:^|/)${year}(?:/|$)`, "u")
    .test(new URL(page.finalUrl ?? page.inputUrl).pathname);
  const officialNameMatch = pathHasYear && normalizedName.length >= 8
    && normalizedSeriesName(work.source.name).includes(normalizedName);
  if (
    normalizedName.length < 8
    || (normalizedName.split(" ").length < 2 && !officialNameMatch)
    || genericName.test(normalizedName)
    || listingName.test(heading)
    || (!opportunityName.test(heading) && !officialNameMatch)
  ) return null;

  return {
    title: heading,
    seriesName,
    normalizedName,
    year,
    seriesKey: `series:v1:${sha256([
      hostname(work.source.url).replace(/^www\./, ""),
      normalizedName,
    ])}`,
    sourceUrl: canonicalizeUrl(page.finalUrl ?? page.inputUrl),
  };
}

async function rowByKey(table, field, value) {
  const rows = await supabase(
    `${table}?select=*&${field}=eq.${encodeURIComponent(value)}&limit=1`,
  );
  return rows[0] ?? null;
}

async function persistDatedEdition(work, page) {
  const evidence = datedEditionEvidence(work, page);
  if (!evidence) return null;
  const observedAt = new Date().toISOString();
  const seriesPayload = {
    canonical_key: evidence.seriesKey,
    name: evidence.seriesName,
    normalized_name: evidence.normalizedName,
    source_family: work.source.source_family,
    category: work.source.opportunity_categories?.length === 1
      ? work.source.opportunity_categories[0]
      : null,
    country: work.source.country ?? null,
    region: work.source.region ?? null,
    language: work.source.language ?? null,
    recurring: false,
    earliest_known_year: evidence.year,
    latest_known_year: evidence.year,
    metadata: {
      provenance: "official_dated_heading",
      source_id: work.source.id,
      source_url: evidence.sourceUrl,
      observed_heading: evidence.title,
      no_forecasting: true,
    },
  };
  const createdSeries = await supabase("event_series?on_conflict=canonical_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: JSON.stringify([seriesPayload]),
  });
  let series = createdSeries[0]
    ?? await rowByKey("event_series", "canonical_key", evidence.seriesKey);
  if (!series) throw new Error("HISTORICAL_SERIES_WRITE_NOT_VISIBLE");
  counters.series_created += createdSeries.length;

  if (!createdSeries.length) {
    const earliest = Math.min(Number(series.earliest_known_year ?? evidence.year), evidence.year);
    const latest = Math.max(Number(series.latest_known_year ?? evidence.year), evidence.year);
    await supabase(`event_series?id=eq.${encodeURIComponent(series.id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        earliest_known_year: earliest,
        latest_known_year: latest,
        recurring: Boolean(series.recurring) || earliest < latest,
        last_seen_at: observedAt,
      }),
    });
    series = { ...series, earliest_known_year: earliest, latest_known_year: latest };
  }

  const editionKey = `edition:v1:${sha256([evidence.seriesKey, evidence.year])}`;
  const createdEdition = await supabase("opportunity_editions?on_conflict=edition_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: JSON.stringify([{
      edition_key: editionKey,
      event_series_id: series.id,
      edition_label: String(evidence.year),
      edition_year: evidence.year,
      title: evidence.title,
      status: "signal",
      source_url: evidence.sourceUrl,
      metadata: {
        provenance: "official_dated_heading",
        source_id: work.source.id,
        observed_heading: evidence.title,
        no_forecasting: true,
      },
    }]),
  });
  const edition = createdEdition[0]
    ?? await rowByKey("opportunity_editions", "edition_key", editionKey);
  if (!edition) throw new Error("HISTORICAL_EDITION_WRITE_NOT_VISIBLE");
  counters.editions_created += createdEdition.length;
  if (!createdEdition.length) {
    await supabase(`opportunity_editions?id=eq.${encodeURIComponent(edition.id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ last_seen_at: observedAt }),
    });
  }
  return { ...evidence, editionId: edition.id, seriesId: series.id };
}

function linkedEditionId(opportunity, edition) {
  if (!edition) return opportunity.opportunity_edition_id ?? null;
  if (opportunity.opportunity_edition_id) return opportunity.opportunity_edition_id;
  if (
    (opportunity.edition_year !== null
      && Number(opportunity.edition_year) !== edition.year)
    || normalizedSeriesName(
      String(opportunity.title).replace(
        /\b\d{1,3}(?:st|nd|rd|th)\s+(?:annual\s+)?edition\b/giu,
        " ",
      ),
    ) !== edition.normalizedName
  ) return null;
  return edition.editionId;
}

async function appendPageObservations({ work, run, page, contentHash, edition }) {
  if (!contentHash) return { inserted: 0, duplicates: 0 };
  const pageUrls = [page.inputUrl, page.finalUrl]
    .map((url) => canonicalizeUrl(url))
    .filter(Boolean);
  const matches = await matchingOpportunities(pageUrls);
  const pageUrlSet = new Set(pageUrls);
  let inserted = 0;
  let duplicates = 0;
  for (const opportunity of matches) {
    const matchedFields = ["source_url", "official_url", "application_url"]
      .filter((field) => pageUrlSet.has(canonicalizeUrl(opportunity[field])));
    const editionId = linkedEditionId(opportunity, edition);
    const result = await supabase("rpc/record_opportunity_observation", {
      method: "POST",
      body: JSON.stringify({
        p_idempotency_key: sha256([
          opportunity.id,
          page.finalUrl ?? page.inputUrl,
          contentHash,
        ]),
        p_opportunity_id: opportunity.id,
        p_pipeline_run_id: run.id,
        p_source_id: work.source.id,
        p_opportunity_edition_id: editionId,
        p_source_url: page.finalUrl ?? page.inputUrl,
        p_content_hash: contentHash,
        p_observed_at: page.checkedAt ?? new Date().toISOString(),
        p_observed_status: null,
        p_observed_deadline: null,
        p_deadline_status: null,
        p_is_primary_evidence: work.source.source_type === "official"
          && matchedFields.some((field) => ["official_url", "source_url"].includes(field)),
        p_claim_priority: 1000,
        p_observed_fields: {
          http_status: page.httpStatus,
          content_type: page.contentType ?? null,
          matched_url_fields: matchedFields,
          historical_year_signals: yearsIn(`${page.finalUrl} ${page.text.slice(0, 20_000)}`)
            .filter((year) => year >= MIN_HISTORY_YEAR && year <= MAX_HISTORY_YEAR),
          explicit_edition_year: edition?.year ?? null,
          explicit_edition_heading: edition?.title ?? null,
          no_forecasting: true,
        },
      }),
    });
    if (result.inserted) {
      inserted += 1;
      if (editionId && !opportunity.opportunity_edition_id) {
        counters.opportunities_linked_to_editions += 1;
      }
    } else duplicates += 1;
  }
  counters.observations_inserted += inserted;
  counters.observation_duplicates += duplicates;
  return { inserted, duplicates };
}

function checkpointStateAfterSuccess(work, page, candidates) {
  const completedUrl = canonicalizeUrl(work.url);
  const visited = [...work.visited.filter((url) => url !== completedUrl), completedUrl]
    .filter(Boolean)
    .slice(-MAX_VISITED_URLS_PER_SOURCE);
  const visitedSet = new Set(visited);
  const pending = uniqueCanonicalUrls(
    [...work.queue.slice(1), ...candidates.map((candidate) => candidate.url)],
    work.source.url,
  ).filter((url) => !visitedSet.has(url)).slice(0, MAX_PENDING_URLS_PER_SOURCE);
  const failures = { ...(work.state.fetch_failures ?? {}) };
  delete failures[completedUrl];
  const yearEvidence = [
    Number(work.state.oldest_year_seen),
    ...candidates.flatMap((candidate) => candidate.years),
    ...yearsIn(page.text.slice(0, 50_000)),
  ].filter(
    (year) => Number.isInteger(year)
      && year >= MIN_HISTORY_YEAR
      && year <= MAX_HISTORY_YEAR,
  );
  return {
    pending_urls: pending,
    visited_urls: visited,
    fetch_failures: failures,
    target_year: MIN_HISTORY_YEAR,
    oldest_year_seen: yearEvidence.length ? Math.min(...yearEvidence) : null,
    no_forecasting: true,
  };
}

function checkpointStateAfterFailure(work) {
  const currentUrl = canonicalizeUrl(work.url);
  const failures = { ...(work.state.fetch_failures ?? {}) };
  failures[currentUrl] = Number(failures[currentUrl] ?? 0) + 1;
  const permanentlySkipped = failures[currentUrl] >= MAX_FETCH_FAILURES_PER_URL;
  const visited = permanentlySkipped
    ? [...work.visited, currentUrl].filter(Boolean).slice(-MAX_VISITED_URLS_PER_SOURCE)
    : work.visited;
  const pending = permanentlySkipped ? work.queue.slice(1) : work.queue;
  return {
    pending_urls: pending.slice(0, MAX_PENDING_URLS_PER_SOURCE),
    visited_urls: visited,
    fetch_failures: Object.fromEntries(Object.entries(failures).slice(-100)),
    target_year: MIN_HISTORY_YEAR,
    oldest_year_seen: work.state.oldest_year_seen ?? null,
    no_forecasting: true,
  };
}

async function persistCheckpoint(work, { page = null, contentHash = null, state }) {
  const checkedAt = page?.checkedAt ?? new Date().toISOString();
  const exhausted = state.pending_urls.length === 0;
  const requestCount = Number(work.checkpoint?.request_count ?? 0) + 1;
  const body = {
    source_id: work.source.id,
    checkpoint_key: CHECKPOINT_KEY,
    cursor_kind: "link-window",
    cursor_value: state.pending_urls[0] ?? null,
    page_number: Math.min(100_000, requestCount + 1),
    link_offset: Math.min(1_000_000, state.visited_urls.length),
    link_window_size: pageLimit,
    cycle_count: Number(work.checkpoint?.cycle_count ?? 0) + Number(exhausted),
    request_count: requestCount,
    exhausted,
    last_seen_url: canonicalizeUrl(work.url),
    last_content_hash: contentHash ?? work.checkpoint?.last_content_hash ?? null,
    last_checked_at: checkedAt,
    completed_cycle_at: exhausted
      ? checkedAt
      : work.checkpoint?.completed_cycle_at ?? null,
    state,
  };
  await supabase(
    "source_checkpoints?on_conflict=source_id,checkpoint_key",
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify([body]),
    },
  );
  counters.checkpoints_written += 1;
}

function strictHostFetch(sourceUrl) {
  return async (input, init) => {
    if (!sameHost(String(input), sourceUrl)) {
      const error = new Error("CROSS_HOST_REDIRECT_BLOCKED");
      error.code = "CROSS_HOST_REDIRECT_BLOCKED";
      throw error;
    }
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(input, { ...init, signal });
    const contentLength = Number(response.headers.get("content-length"));
    if (
      response.status >= 200
      && response.status < 300
      && Number.isFinite(contentLength)
      && contentLength > 2_000_000
    ) {
      await response.body?.cancel?.();
      const error = new Error("HISTORICAL_PAGE_TOO_LARGE");
      error.code = "HISTORICAL_PAGE_TOO_LARGE";
      throw error;
    }
    if (!response.body || response.status < 200 || response.status >= 300) {
      return response;
    }
    const reader = response.body.getReader();
    let receivedBytes = 0;
    const limitedBody = new ReadableStream({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > 2_000_000) {
          await reader.cancel();
          controller.error(new Error("HISTORICAL_PAGE_TOO_LARGE"));
          return;
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(limitedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function processWorkItem(run, metrics, work) {
  counters.pages_attempted += 1;
  const attempt = await startAttempt(run, work);
  const canonicalUrl = canonicalizeUrl(work.url);
  const cache = await fetchUrlCache([canonicalUrl]);
  const existingCache = cache.get(canonicalUrl) ?? null;
  let page;
  try {
    const previouslyScanned = work.visited.includes(canonicalUrl);
    page = await fetchPage(canonicalUrl, {
      fetchImpl: strictHostFetch(work.source.url),
      maxCharacters: 60_000,
      etag: previouslyScanned ? existingCache?.etag ?? null : null,
      lastModified: previouslyScanned ? existingCache?.last_modified ?? null : null,
    });
    if (!sameHost(work.source.url, page.finalUrl)) {
      const error = new Error("CROSS_HOST_REDIRECT_BLOCKED");
      error.code = "CROSS_HOST_REDIRECT_BLOCKED";
      throw error;
    }
  } catch (error) {
    counters.fetch_failures += 1;
    if (/CROSS_HOST_REDIRECT/.test(
      `${error.message} ${error.validation?.error ?? ""}`,
    )) counters.cross_host_skips += 1;
    recordRejection(metrics, error.code ?? error.message ?? "HISTORICAL_FETCH_FAILED");
    await recordFetchFailure(canonicalUrl, error, existingCache);
    await persistCheckpoint(work, {
      state: checkpointStateAfterFailure(work),
    });
    await finishAttempt(attempt, {
      status: "failed",
      request_count: 1,
      result_count: 0,
      candidate_count: 0,
      validated_count: 0,
      unique_opportunity_count: 0,
      unique_source_count: 0,
      false_positive_count: 0,
      estimated_cost_eur: 0,
      error: String(error.message).slice(0, 1000),
      metadata: {
        min_year: MIN_HISTORY_YEAR,
        max_year: MAX_HISTORY_YEAR,
        page_url: canonicalUrl,
        no_forecasting: true,
      },
    });
    console.warn(`Historical fetch failed for ${canonicalUrl}: ${error.message}`);
    return;
  }

  try {
    incrementMetric(metrics, "fetched");
    counters.pages_inspected += 1;
    const observation = page.notModified
      ? await observeNotModified(page, existingCache)
      : await observeFetchedPage(page, {
        sourceId: work.source.id,
        existing: existingCache,
      });
    if (observation.changed) counters.pages_changed += 1;
    else {
      counters.pages_unchanged += 1;
      incrementMetric(metrics, "unchanged");
    }
    if (!page.notModified) incrementMetric(metrics, "parsed");

    const historicalLinks = page.notModified
      ? []
      : selectHistoricalLinks(page, work.source)
        .filter((candidate) => candidate.url !== canonicalUrl);
    counters.historical_urls_found += historicalLinks.length;
    incrementMetric(metrics, "discovered", historicalLinks.length);

    const seriesCreatedBefore = counters.series_created;
    const editionsCreatedBefore = counters.editions_created;
    const edition = await persistDatedEdition(work, page);
    const persisted = await persistHistoricalUrls(
      work,
      attempt,
      page.finalUrl,
      historicalLinks,
    );
    const pageObservations = await appendPageObservations({
      work,
      run,
      page,
      contentHash: observation.contentHash,
      edition,
    });
    const createdSeries = counters.series_created - seriesCreatedBefore;
    const createdEditions = counters.editions_created - editionsCreatedBefore;
    incrementMetric(
      metrics,
      "stored",
      persisted.inserted + pageObservations.inserted + createdSeries + createdEditions,
    );
    incrementMetric(metrics, "duplicates", persisted.existing + pageObservations.duplicates);

    const state = checkpointStateAfterSuccess(work, page, historicalLinks);
    await persistCheckpoint(work, {
      page,
      contentHash: observation.contentHash,
      state,
    });
    counters.sources_advanced += 1;
    await finishAttempt(attempt, {
      status: "succeeded",
      request_count: 1,
      result_count: historicalLinks.length,
      candidate_count: historicalLinks.length,
      validated_count: 0,
      unique_opportunity_count: 0,
      unique_source_count: 0,
      false_positive_count: 0,
      estimated_cost_eur: 0,
      metadata: {
        min_year: MIN_HISTORY_YEAR,
        max_year: MAX_HISTORY_YEAR,
        page_url: canonicalUrl,
        changed: observation.changed,
        new_historical_urls: persisted.inserted,
        series_created: createdSeries,
        editions_created: createdEditions,
        observations_inserted: pageObservations.inserted,
        no_forecasting: true,
      },
    });
  } catch (error) {
    await finishAttempt(attempt, {
      status: "failed",
      request_count: 1,
      result_count: 0,
      candidate_count: 0,
      validated_count: 0,
      unique_opportunity_count: 0,
      unique_source_count: 0,
      false_positive_count: 0,
      estimated_cost_eur: 0,
      error: String(error.message).slice(0, 1000),
      metadata: {
        min_year: MIN_HISTORY_YEAR,
        max_year: MAX_HISTORY_YEAR,
        page_url: canonicalUrl,
        failure_stage: "persistence",
        no_forecasting: true,
      },
    }).catch((finishError) => {
      console.error(`Unable to record failed historical attempt: ${finishError.message}`);
    });
    throw error;
  }
}

async function main() {
await assertHistoricalSchema();
const run = await startRun("historical");
const metrics = createRunMetrics("historical");

try {
  const workItems = await loadWorkItems();
  for (const work of workItems) {
    if (counters.pages_attempted >= pageLimit) break;
    await processWorkItem(run, metrics, work);
  }
  if (workItems.length > 0 && counters.pages_inspected === 0) {
    throw new Error("ALL_HISTORICAL_FETCHES_FAILED");
  }
  await finishRun(run.id, metricsRunPatch(metrics));
  console.log(JSON.stringify({
    status: "succeeded",
    min_history_year: MIN_HISTORY_YEAR,
    max_history_year: MAX_HISTORY_YEAR,
    ...counters,
    ...summarizeMetrics(metrics),
  }));
} catch (error) {
  try {
    await finishRun(run.id, {
      ...metricsRunPatch(metrics, "failed"),
      error: String(error.message).slice(0, 1000),
    });
  } catch (finishError) {
    console.error(`Unable to record failed historical run: ${finishError.message}`);
  }
  throw error;
}
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
