// Weekly directory harvest: opportunity directories (aggregators) point to
// the official pages of calls we may not know yet. For each robots-allowed
// directory, read a rotating window of its detail pages (from its sitemap, or
// from the homepage links), take the official page each one points to and
// register it as a monitored source. Nothing is copied from the directory:
// the official page is fetched, gated and extracted like any other source.
//
//   node scripts/cineradar/harvest-directories.mjs           # dry run
//   node scripts/cineradar/harvest-directories.mjs --apply   # register sources

import { isAiFilmText, isAiSource } from "./call-signal.mjs";
import {
  detailUrls,
  harvestedSource,
  officialCandidates,
  parseSitemapLocs,
} from "./directory-harvest.mjs";
import { fetchWithTimeout } from "./http.mjs";
import { hostOf } from "./registry-seeds.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { supabase } from "./supabase.mjs";
import { canonicalizeUrl, fetchPage, selectOpportunityLinks } from "./web-validation.mjs";

const apply = process.argv.includes("--apply");
const USER_AGENT = "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)";
const robotsAllowed = createRobotsChecker({ userAgent: USER_AGENT });
const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};
const DIRECTORY_LIMIT = number("HARVEST_DIRECTORY_LIMIT", 40);
const PAGES_PER_DIRECTORY = Math.min(number("HARVEST_PAGES_PER_DIRECTORY", 60), 200);
const TOTAL_PAGE_LIMIT = number("HARVEST_PAGE_LIMIT", 600);
const NEW_SOURCE_LIMIT = number("HARVEST_NEW_SOURCE_LIMIT", 400);
const MAX_SOURCES_PER_HOST = 3;
const deadline = Date.now() + number("HARVEST_TIME_BUDGET_SECONDS", 420) * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function allSources() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await supabase(`sources?select=id,url,source_family,opportunity_categories,adapter_config,enabled,priority&order=id.asc&limit=1000&offset=${offset}`);
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function sitemapUrls(origin) {
  const locs = [];
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const seen = new Set();
  while (queue.length && seen.size < 6) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const permission = await robotsAllowed(url);
    if (!permission.allowed) continue;
    try {
      const response = await fetchWithTimeout(url, { headers: { "user-agent": USER_AGENT, accept: "application/xml,text/xml" } }, 15_000);
      if (!response.ok) continue;
      const xml = (await response.text()).slice(0, 5_000_000);
      const found = parseSitemapLocs(xml);
      if (/<sitemapindex/i.test(xml)) queue.push(...found.filter((loc) => /\.xml(?:\?|$)/i.test(loc)).slice(0, 5));
      else locs.push(...found);
    } catch {
      // A missing or slow sitemap falls back to homepage links.
    }
    if (locs.length) break;
  }
  return locs;
}

const sources = await allSources();
const knownUrls = new Set(sources.map((source) => canonicalizeUrl(source.url)).filter(Boolean));
const perHost = new Map();
for (const source of sources) {
  const host = hostOf(source.url);
  if (host) perHost.set(host, (perHost.get(host) ?? 0) + 1);
}
const directories = sources
  .filter((source) => source.enabled && source.source_family === "opportunity-directory")
  .sort((left, right) =>
    Date.parse(left.adapter_config?.harvest?.last_run ?? 0) - Date.parse(right.adapter_config?.harvest?.last_run ?? 0)
    || Number(right.adapter_config?.series_count ?? 0) - Number(left.adapter_config?.series_count ?? 0))
  .slice(0, DIRECTORY_LIMIT);
const directoryHosts = new Set(sources.filter((source) => source.source_family === "opportunity-directory").map((source) => hostOf(source.url)).filter(Boolean));

const summary = {
  mode: apply ? "apply" : "dry-run",
  directories: 0,
  robotsBlocked: 0,
  pagesFetched: 0,
  pageErrors: 0,
  candidates: 0,
  alreadyKnown: 0,
  hostCapped: 0,
  platformOnly: 0,
  newSources: 0,
  newAiSources: 0,
  stoppedByTimeBudget: false,
  byDirectory: {},
};
const newRows = new Map();
let pagesLeft = TOTAL_PAGE_LIMIT;

for (const directory of directories) {
  if (Date.now() > deadline || pagesLeft <= 0) {
    summary.stoppedByTimeBudget = Date.now() > deadline;
    break;
  }
  const directoryUrl = canonicalizeUrl(directory.url);
  const directoryHost = hostOf(directoryUrl);
  if (!directoryUrl || !directoryHost) continue;
  const permission = await robotsAllowed(directoryUrl);
  if (!permission.allowed) {
    summary.robotsBlocked += 1;
    continue;
  }
  summary.directories += 1;
  const delayMs = Math.max(1000, Math.min(Number(permission.crawlDelay ?? 0), 10) * 1000);
  const origin = new URL(directoryUrl).origin;
  let details = detailUrls(await sitemapUrls(origin), directoryHost);
  let homepage = null;
  try {
    homepage = await fetchPage(directoryUrl);
    if (!details.length) {
      details = detailUrls(
        selectOpportunityLinks(homepage.linkRecords, { sourceUrl: homepage.finalUrl, limit: 500, lenient: true }).map((link) => link.url),
        directoryHost,
      );
    }
  } catch {
    // Sitemap-only directories still work without the homepage.
  }
  const aiDirectory = isAiSource(directory) || isAiFilmText(homepage?.text ?? "");
  const state = directory.adapter_config?.harvest ?? {};
  const offset = Number(state.offset ?? 0) < details.length ? Number(state.offset ?? 0) : 0;
  const window = details.slice(offset, offset + Math.min(PAGES_PER_DIRECTORY, pagesLeft));
  const stats = { details: details.length, offset, fetched: 0, new: 0 };
  for (const url of window) {
    if (Date.now() > deadline) {
      summary.stoppedByTimeBudget = true;
      break;
    }
    const pagePermission = await robotsAllowed(url);
    if (!pagePermission.allowed) continue;
    await sleep(delayMs);
    let page;
    try {
      page = await fetchPage(url);
    } catch {
      summary.pageErrors += 1;
      continue;
    }
    pagesLeft -= 1;
    stats.fetched += 1;
    summary.pagesFetched += 1;
    const { candidates, platformOnly } = officialCandidates({
      html: page.html,
      linkRecords: page.linkRecords,
      pageUrl: page.finalUrl,
      directoryHost,
      directoryHosts,
    });
    if (platformOnly) summary.platformOnly += 1;
    const ai = aiDirectory || isAiFilmText(page.text);
    for (const candidate of candidates) {
      summary.candidates += 1;
      if (knownUrls.has(candidate.url) || newRows.has(candidate.url)) {
        summary.alreadyKnown += 1;
        continue;
      }
      if ((perHost.get(candidate.host) ?? 0) >= MAX_SOURCES_PER_HOST) {
        summary.hostCapped += 1;
        continue;
      }
      if (newRows.size >= NEW_SOURCE_LIMIT) continue;
      perHost.set(candidate.host, (perHost.get(candidate.host) ?? 0) + 1);
      newRows.set(candidate.url, harvestedSource(candidate, { ai, directoryHost }));
      stats.new += 1;
      if (ai) summary.newAiSources += 1;
    }
  }
  summary.byDirectory[directoryHost] = stats;
  if (apply) {
    const nextOffset = offset + stats.fetched >= details.length ? 0 : offset + stats.fetched;
    await supabase(`sources?id=eq.${encodeURIComponent(directory.id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        adapter_config: {
          ...(directory.adapter_config ?? {}),
          harvest: { offset: nextOffset, details: details.length, last_run: new Date().toISOString() },
        },
      }),
    });
  }
}

summary.newSources = newRows.size;
if (apply && newRows.size) {
  const rows = [...newRows.values()];
  for (let index = 0; index < rows.length; index += 200) {
    // ignore-duplicates keeps existing sources' curated settings and statistics.
    await supabase("sources?on_conflict=url", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: JSON.stringify(rows.slice(index, index + 200)),
    });
  }
}
summary.sample = [...newRows.values()].slice(0, 15).map((row) => `${row.source_family === "ai-creative-tech" ? "AI " : "   "}${row.url} <- ${row.adapter_config.found_via}`);
console.log(JSON.stringify(summary, null, 2));
