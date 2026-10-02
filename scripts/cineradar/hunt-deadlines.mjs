// Deadline hunt: most pending records were extracted from a homepage that does
// not print the deadline. For each one (AI calls first), open the official
// page and up to three of its own "Submit / Rules / Dates" subpages and read
// the deadline there, with the quote and the page it came from. Only empty
// fields are filled; nothing is published here (the automatic review decides).
// A record is hunted again only after a week, or sooner when it changed.
//
//   node scripts/cineradar/hunt-deadlines.mjs           # dry run
//   node scripts/cineradar/hunt-deadlines.mjs --apply   # write

import { isAiFilmText } from "./call-signal.mjs";
import { evidenceNearTitle, huntDeadline, huntLinks, isApplyPage } from "./deadline-hunt.mjs";
import { extractDecisionFields, DECISION_FIELDS_VERSION } from "./decision-fields.mjs";
import { mapPool } from "./http.mjs";
import { BLOCKED_HOSTS } from "./registry-seeds.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { supabase } from "./supabase.mjs";
import { fetchPageOrRender } from "./browser-render.mjs";

const apply = process.argv.includes("--apply");
const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};
const LIMIT = number("HUNT_LIMIT", 60);
const RECHECK_DAYS = number("HUNT_RECHECK_DAYS", 7);
const deadlineAt = Date.now() + number("HUNT_TIME_BUDGET_SECONDS", 150) * 1000;
const robots = createRobotsChecker({ userAgent: "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const blocked = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return BLOCKED_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return true;
  }
};

const fields = "id,title,organizer,category,summary,deadline,deadline_status,official_url,source_url,source_type,application_url,max_runtime_minutes,entry_fee_amount,ai_policy,readiness_score,updated_at,created_at,raw_payload";
const rows = [];
for (let offset = 0; ; offset += 1000) {
  const batch = await supabase(`opportunities?select=${fields}&review_decision=eq.pending&or=(deadline.is.null,deadline_status.eq.unknown)&order=id.asc&limit=1000&offset=${offset}`);
  rows.push(...batch);
  if (batch.length < 1000) break;
}
const now = Date.now();
const startUrl = (row) => row.official_url ?? (row.source_type === "official" ? row.source_url : null);
// Sites with several records publish several calls: a date found there must
// be printed next to this record's own name.
const siteOf = (url) => {
  try {
    const labels = new URL(url).hostname.toLowerCase().replace(/^www\./, "").split(".");
    return labels.slice(-(labels.at(-1).length === 2 && (labels.at(-2) ?? "").length <= 3 ? 3 : 2)).join(".");
  } catch {
    return null;
  }
};
const siteTitles = new Map();
for (const row of await supabase("opportunities?select=title,official_url,source_url,source_type&review_decision=in.(pending,approved)&limit=5000")) {
  const key = siteOf(startUrl(row));
  if (!key) continue;
  if (!siteTitles.has(key)) siteTitles.set(key, []);
  siteTitles.get(key).push(row.title);
}
const lastHunt = (row) => Date.parse(row.raw_payload?.deadline_hunt?.checked_at ?? "");
const isAi = (row) => row.category === "AI film festival" || isAiFilmText(`${row.title} ${row.organizer ?? ""} ${row.summary ?? ""}`);
const candidates = rows
  .filter((row) => startUrl(row) && !blocked(startUrl(row)))
  .filter((row) => {
    const hunted = lastHunt(row);
    // Re-hunt weekly, or at once when the record changed after the last hunt.
    return !Number.isFinite(hunted) || hunted < now - RECHECK_DAYS * 86_400_000 || Date.parse(row.updated_at) > hunted + 60_000;
  })
  .sort((left, right) => Number(isAi(right)) - Number(isAi(left))
    || Number(right.readiness_score ?? 0) - Number(left.readiness_score ?? 0)
    || Date.parse(right.created_at) - Date.parse(left.created_at))
  .slice(0, LIMIT);

const summary = { mode: apply ? "apply" : "dry-run", eligible: rows.length, hunted: 0, found: 0, byMethod: {}, applicationUrls: 0, otherFields: 0, pagesFetched: 0, stoppedByTimeBudget: false };
const found = [];
const patches = [];

async function read(url, { allowRender = false } = {}) {
  if (blocked(url) || !(await robots(url)).allowed) return null;
  try {
    summary.pagesFetched += 1;
    const page = await fetchPageOrRender(url, {}, { allowRender });
    if (page.rendered) summary.rendered = (summary.rendered ?? 0) + 1;
    return page;
  } catch {
    return null;
  }
}

await mapPool(candidates, 4, async (row) => {
  if (Date.now() > deadlineAt) {
    summary.stoppedByTimeBudget = true;
    return;
  }
  summary.hunted += 1;
  const home = await read(startUrl(row), { allowRender: isAi(row) });
  const subpages = [];
  if (home) {
    for (const link of huntLinks(home.linkRecords, { pageUrl: home.finalUrl })) {
      await sleep(400);
      const page = await read(link.url, { allowRender: isAi(row) });
      if (page) subpages.push(page);
    }
  }
  // Subpages first: a "Rules" page states this call's own dates, while a
  // homepage may announce several calls.
  let hit = null;
  let hitPage = null;
  const titlesOnSite = siteTitles.get(siteOf(startUrl(row))) ?? [];
  const sharedSite = titlesOnSite.length > 1;
  const siblings = titlesOnSite.filter((title) => title !== row.title);
  const exclude = [siteOf(startUrl(row)) ?? "", row.organizer ?? ""];
  for (const page of [...subpages, ...(home ? [home] : [])]) {
    // A site with several records lists several calls: only a date printed
    // next to a word that distinguishes this call belongs to it.
    const accept = sharedSite
      ? (evidence) => evidenceNearTitle(page.text, evidence, row.title, { exclude, siblings })
      : () => true;
    const candidate = huntDeadline(page, { title: row.title, now, accept });
    if (!candidate && sharedSite && huntDeadline(page, { title: row.title, now })) {
      summary.sharedSiteSkipped = (summary.sharedSiteSkipped ?? 0) + 1;
    }
    if (candidate) {
      hit = candidate;
      hitPage = page;
      break;
    }
  }
  const checkedAt = new Date().toISOString();
  const patch = {};
  const evidence = { ...(row.raw_payload?.decision_fields?.evidence ?? {}) };
  if (hit) {
    summary.found += 1;
    summary.byMethod[hit.method] = (summary.byMethod[hit.method] ?? 0) + 1;
    patch.deadline = `${hit.deadline}T23:59:59.000Z`;
    patch.deadline_status = hit.deadline_status;
    patch.deadline_source_url = hitPage.finalUrl;
    patch.deadline_last_verified_at = hitPage.checkedAt;
    evidence.deadline = hit.evidence;
    // The same page usually states the other rules of this call.
    const facts = extractDecisionFields(hitPage.text ?? "", { title: row.title, now });
    if (facts.runtime && row.max_runtime_minutes === null) {
      patch.max_runtime_minutes = facts.runtime.max_runtime_minutes;
      evidence.max_runtime = facts.runtime.evidence;
      summary.otherFields += 1;
    }
    if (facts.fee && row.entry_fee_amount === null) {
      patch.entry_fee_amount = facts.fee.entry_fee_amount;
      patch.entry_fee_currency = facts.fee.entry_fee_currency;
      evidence.entry_fee = facts.fee.evidence;
      summary.otherFields += 1;
    }
    if (facts.ai_policy && (!row.ai_policy || row.ai_policy === "unclear")) {
      patch.ai_policy = facts.ai_policy.ai_policy;
      evidence.ai_policy = facts.ai_policy.evidence;
      summary.otherFields += 1;
    }
    found.push(`${hit.method.padEnd(13)} ${hit.deadline} ${row.title.slice(0, 45)} «${hit.evidence.slice(0, 70)}»`);
  }
  // The apply page we just opened is a grounded, reachable application URL.
  const applyPage = subpages.find((page) => isApplyPage(page.finalUrl));
  if (!row.application_url && applyPage) {
    patch.application_url = applyPage.finalUrl;
    patch.application_url_status = "verified";
    patch.application_url_http_status = applyPage.httpStatus ?? 200;
    patch.application_url_last_checked_at = applyPage.checkedAt;
    summary.applicationUrls += 1;
  }
  patch.raw_payload = {
    ...(row.raw_payload ?? {}),
    ...(hit ? {
      decision_fields: {
        ...(row.raw_payload?.decision_fields ?? {}),
        version: DECISION_FIELDS_VERSION,
        page_url: hitPage.finalUrl,
        checked_at: hitPage.checkedAt,
        evidence,
      },
    } : {}),
    deadline_hunt: {
      checked_at: checkedAt,
      found: Boolean(hit),
      method: hit?.method ?? null,
      page_url: hitPage?.finalUrl ?? null,
      pages: subpages.length + (home ? 1 : 0),
    },
  };
  patches.push({ id: row.id, patch });
});

if (apply) {
  for (const { id, patch } of patches) {
    // Pending only: a record approved meanwhile is left untouched.
    await supabase(`opportunities?id=eq.${id}&review_decision=eq.pending`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify(patch),
    }).catch((error) => {
      summary.writeErrors = (summary.writeErrors ?? 0) + 1;
      console.warn(`Hunt write failed for ${id}: ${String(error.message).slice(0, 200)}`);
    });
  }
}
summary.sample = found.slice(0, 25);
console.log(JSON.stringify(summary, null, 2));
