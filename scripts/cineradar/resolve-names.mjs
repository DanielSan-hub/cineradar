// Finds the own website of calls the pipeline knows only by name, and
// registers it as a monitored source (no fact is copied: the site's own pages
// are read later by the monitor and the series extraction). Runs in CI from
// the database only; the owner's datasets are never read here.
//
// Inputs, in order:
//   1. (none: Festhome pages are never read, see registry-seeds BLOCKED_HOSTS)
//   2. Pending records with a known name whose official page is missing or
//      sits on another organization's site (directory, article).
// Search: Tavily first (free plan, credit cap), then Exa "instant" (free
// monthly credits, ledger pool) for names Tavily leaves unresolved. A found
// site is accepted only when its domain carries the name (pickOfficialSite)
// and our own robots-aware fetch of it shows the name in its title/heading.
//
//   node scripts/cineradar/resolve-names.mjs            # dry run (no search, no write)
//   node scripts/cineradar/resolve-names.mjs --apply    # search and register

import { config } from "./config.mjs";
import { usageIdempotencyKey } from "./cost-control.mjs";
import { exaIsExhausted, ledgeredExaSearch } from "./exa.mjs";
import { hostOf, isPlatformHost, pickOfficialSite, seriesKey } from "./registry-seeds.mjs";
import { hostNamesSeries, pageNamesSeries, RESOLVER_EXCLUDE, resolvedSourceRow, resolverName, resolverQuery, siteRoot } from "./site-resolution.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { nameFitsHost } from "./series-extraction.mjs";
import { finishRun, startRun, supabase } from "./supabase.mjs";
import { ledgeredTavilySearch, tavilyAvailable } from "./tavily.mjs";
import { fetchPage } from "./web-validation.mjs";

const apply = process.argv.includes("--apply");
const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
};
const SEARCH_LIMIT = number("RESOLVE_SEARCH_LIMIT", 15);
const EXA_LIMIT = number("RESOLVE_EXA_LIMIT", 15);
const RETRY_DAYS = number("RESOLVE_RETRY_DAYS", 120);
const deadlineAt = Date.now() + number("RESOLVE_TIME_BUDGET_SECONDS", 420) * 1000;
const UA = "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)";
const robots = createRobotsChecker({ userAgent: UA });

async function all(path) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await supabase(`${path}&limit=1000&offset=${offset}`);
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

const summary = {
  mode: apply ? "apply" : "dry-run",
    namesConsidered: 0, namesSkippedRecent: 0, searched: { tavily: 0, exa: 0 }, blocked: [],
  resolved: 0, rejectedByPageCheck: 0, alreadyRegistered: 0, sourcesRegistered: 0, stoppedByTimeBudget: false,
  examples: [],
};

const knownHosts = new Set((await all("sources?select=url&order=id.asc")).map((row) => hostOf(row.url)).filter(Boolean));
const fresh = [];
const register = (site) => {
  const host = hostOf(site.url);
  if (!host || knownHosts.has(host)) {
    summary.alreadyRegistered += 1;
    return false;
  }
  knownHosts.add(host);
  fresh.push(resolvedSourceRow(site));
  return true;
};

/** The first result the general rule accepts whose domain carries a distinctive word of the name. */
function pickSite(name, results) {
  const usable = (results ?? []).filter((result) => !RESOLVER_EXCLUDE.some((host) => hostOf(result.url) === host || hostOf(result.url)?.endsWith(`.${host}`))
    && hostNamesSeries(name, result.url));
  return pickOfficialSite(name, usable);
}

async function readSite(url) {
  if (!url || isPlatformHost(hostOf(url) ?? "") || RESOLVER_EXCLUDE.some((host) => hostOf(url) === host || hostOf(url)?.endsWith(`.${host}`))) return null;
  if (!(await robots(url)).allowed) return null;
  return fetchPage(url).catch(() => null);
}

const run = apply ? await startRun("discovery") : { id: null };

// 1. (Festhome records are no longer re-read: Festhome's terms forbid
//    automated collection without written consent.)

// 2. Names without an own site.
const since = new Date(Date.now() - RETRY_DAYS * 86_400_000).toISOString();
const tried = new Set((await all(`provider_usage_events?select=key:metadata->>series_key&operation=eq.site-resolution&occurred_at=gte.${encodeURIComponent(since)}&order=id.asc`))
  .map((row) => row.key).filter(Boolean));
const pending = await all("opportunities?select=id,title,organizer,category,location,official_url,source_url,review_reason,deadline&review_decision=eq.pending&order=deadline.asc.nullslast,id.asc");
const candidates = new Map();
for (const row of pending) {
  const name = resolverName(row);
  const key = seriesKey(name);
  if (!key || key.length < 4 || candidates.has(key)) continue;
  const official = row.official_url ? hostOf(row.official_url) : null;
  const foreign = /domain does not belong|directory|news or blog post|listing/i.test(String(row.review_reason ?? ""));
  const ownSiteKnown = official && !foreign && nameFitsHost(name, row.official_url);
  if (ownSiteKnown) continue;
  candidates.set(key, { key, name, category: row.category, location: row.location, live: Boolean(row.deadline && Date.parse(row.deadline) > Date.now()) });
}
// 3. Festivals from Wikidata whose registered domain no longer resolves
//    (DEAD_DOMAIN): the series may have moved to a new site.
const deadSources = await all("sources?select=name,opportunity_categories&health_message=eq.DEAD_DOMAIN&adapter_config->>seed=eq.wikidata&order=id.asc");
for (const source of deadSources) {
  const key = seriesKey(source.name);
  if (!key || key.length < 4 || candidates.has(key)) continue;
  const category = (source.opportunity_categories ?? []).includes("ai-film") ? "AI film festival" : "Traditional festival";
  candidates.set(key, { key, name: String(source.name).slice(0, 120), category, location: null, live: false, origin: "dead-domain" });
}
// Calls with a live deadline first: their own site is where they are confirmed.
const queue = [...candidates.values()].sort((left, right) => Number(right.live) - Number(left.live));
summary.namesConsidered = queue.length;

let tavilyLeft = SEARCH_LIMIT;
let exaLeft = EXA_LIMIT;
const month = new Date().toISOString().slice(0, 7);
for (const entry of queue) {
  if (Date.now() > deadlineAt) {
    summary.stoppedByTimeBudget = true;
    break;
  }
  if (tried.has(entry.key)) {
    summary.namesSkippedRecent += 1;
    continue;
  }
  if (tavilyLeft <= 0 && (exaLeft <= 0 || exaIsExhausted())) break;
  if (!apply) {
    if (summary.examples.length < 15) summary.examples.push(`would search: ${resolverQuery(entry.name, entry)}`);
    continue;
  }
  const text = resolverQuery(entry.name, entry);
  const metadata = { series_key: entry.key, origin: entry.origin ?? "pending-record" };
  let results = null;
  let provider = null;
  if (tavilyLeft > 0 && await tavilyAvailable()) {
    const found = await ledgeredTavilySearch({
      idempotencyKey: usageIdempotencyKey(["site-resolution", "tavily", entry.key, month]),
      runId: run.id,
      text,
      excludeDomains: RESOLVER_EXCLUDE,
      metadata,
    }).catch((error) => ({ blocked: true, reason: String(error.message).slice(0, 80) }));
    if (!found.blocked) {
      tavilyLeft -= 1;
      summary.searched.tavily += 1;
      results = found.results;
      provider = "tavily";
    } else if (!summary.blocked.includes(found.reason)) {
      summary.blocked.push(found.reason);
      if (/CAP|EXHAUSTED|432|433|401|KEY_MISSING/.test(found.reason)) tavilyLeft = 0;
    }
  }
  let url = results ? pickSite(entry.name, results) : null;
  if (!url && exaLeft > 0 && config.exaApiKey && !exaIsExhausted()) {
    const found = await ledgeredExaSearch({
      idempotencyKey: usageIdempotencyKey(["site-resolution", "exa", entry.key, month]),
      runId: run.id,
      operation: "site-resolution",
      text,
      type: "instant",
      numResults: 10,
      excludeDomains: RESOLVER_EXCLUDE,
      metadata,
    }).catch((error) => ({ blocked: true, reason: String(error.message).slice(0, 80) }));
    if (!found.blocked) {
      exaLeft -= 1;
      summary.searched.exa += 1;
      url = pickSite(entry.name, found.results);
      provider = "exa";
    } else if (!summary.blocked.includes(found.reason)) {
      summary.blocked.push(found.reason);
      exaLeft = 0;
    }
  }
  tried.add(entry.key);
  if (!url) continue;
  // The series' own homepage is checked and registered, not a deep page.
  const site = await readSite(siteRoot(url));
  if (!site || !pageNamesSeries(site, entry.name)) {
    summary.rejectedByPageCheck += 1;
    continue;
  }
  summary.resolved += 1;
  if (register({ name: entry.name, url: site.finalUrl, category: entry.category, origin: provider }) && summary.examples.length < 15) {
    summary.examples.push(`${entry.name.slice(0, 50)} -> ${hostOf(site.finalUrl)} (${provider})`);
  }
}

if (apply && fresh.length) {
  for (let index = 0; index < fresh.length; index += 200) {
    await supabase("sources?on_conflict=url", { method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: JSON.stringify(fresh.slice(index, index + 200)) });
  }
}
summary.sourcesRegistered = apply ? fresh.length : 0;
if (apply) await finishRun(run.id, { status: "succeeded", candidates: summary.namesConsidered, records_written: 0, discovered: summary.resolved, fetched: 0 });
console.log(JSON.stringify(summary, null, 2));
