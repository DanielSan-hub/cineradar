// Daily automatic review (owner decision 2026-09-29). Settles pending records
// from evidence: approves live calls after re-checking the official page now,
// rejects listing/past-edition pages, archives duplicates, and leaves only
// genuinely undecidable records for a human. Every decision goes through the
// audited review RPC and is reversible.
//
//   node scripts/cineradar/auto-review.mjs           # dry run
//   node scripts/cineradar/auto-review.mjs --apply   # write

import { AUTO_REVIEW_VERSION, autoReviewDecision, isExpiredPublication, publicNameChanges } from "../../lib/auto-review.mjs";
import { scoreCallSignal } from "./call-signal.mjs";
import { extractDeadline } from "./decision-fields.mjs";
import { mapPool } from "./http.mjs";
import { seriesKey } from "./registry-seeds.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { supabase } from "./supabase.mjs";
import { isGenericTitle } from "./normalization.mjs";
import { fetchPage } from "./web-validation.mjs";

const apply = process.argv.includes("--apply");
const approveLimit = Math.max(0, Math.min(100, Number(process.env.AUTO_APPROVE_LIMIT ?? 15) || 0));
const REVIEWER = { p_reviewer_email: "auto-review@cineradar.invalid", p_reviewer_name: "CineRadar automatic review" };
const robots = createRobotsChecker({ userAgent: "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)" });
const fold = (value) => String(value ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();

async function all(path) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await supabase(`${path}&limit=1000&offset=${offset}`);
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

async function supportsFlags() {
  try {
    await supabase("opportunities?select=triage_flags&limit=1");
    return true;
  } catch {
    return false;
  }
}

function editionYear(row) {
  const fromTitle = [...String(row.title ?? "").matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  return row.edition_year ?? (fromTitle.length ? Math.max(...fromTitle) : null)
    ?? (row.deadline ? new Date(row.deadline).getUTCFullYear() : null);
}

/** Pending records that repeat another record of the same series and edition. */
function findDuplicates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = seriesKey(row.title);
    if (key.length < 6 || !key.includes(" ") && key.length < 8) continue;
    const id = `${key}|${editionYear(row) ?? "?"}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const duplicates = new Map();
  const rank = (row) => (row.review_decision === "approved" ? 100 : 0) + (row.deadline ? 10 : 0)
    + (row.official_url_status === "verified" ? 5 : 0) + Number(row.confidence ?? 0);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort((left, right) => rank(right) - rank(left));
    for (const row of rest) if (row.review_decision === "pending") duplicates.set(row.id, keep);
  }
  // Titles that differ only in extra words ("AIDFF" vs "AIDFF 3-9 December")
  // still name the same edition of an already published record.
  const tokens = (row) => new Set(seriesKey(row.title).split(" ").filter((token) => token.length > 2));
  const similar = (left, right) => {
    const mine = tokens(left);
    const theirs = tokens(right);
    if (mine.size < 2 || theirs.size < 2) return false;
    const shared = [...mine].filter((token) => theirs.has(token)).length;
    const overlap = shared / Math.min(mine.size, theirs.size);
    const leftYear = editionYear(left);
    const rightYear = editionYear(right);
    // A missing edition year does not separate near-identical titles.
    const sameEdition = leftYear === rightYear || ((leftYear === null || rightYear === null) && overlap >= 0.9);
    return overlap >= 0.7 && sameEdition;
  };
  // Same official site and same deadline: a record titled only as a heading
  // ("Call for Entry for FFDD27") repeats the named call on that site. Records
  // with distinct names (Tampere's three competitions) stay separate.
  const HEADING = /^(?:call\s+for\s+(?:entry|entries|submissions?|films|works)|submissions?|submit(?:\s+your\s+film)?|entries|how\s+to\s+(?:apply|submit))\b/iu;
  const siteDeadline = new Map();
  for (const row of rows) {
    if (!row.deadline) continue;
    let host = "";
    try {
      host = new URL(row.official_url ?? row.source_url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    const key = `${host}|${String(row.deadline).slice(0, 10)}`;
    if (!siteDeadline.has(key)) siteDeadline.set(key, []);
    siteDeadline.get(key).push(row);
  }
  for (const group of siteDeadline.values()) {
    const named = group.filter((row) => !HEADING.test(String(row.title ?? "").trim()))
      .sort((left, right) => rank(right) - rank(left));
    if (!named.length) continue;
    for (const row of group) {
      if (HEADING.test(String(row.title ?? "").trim()) && !duplicates.has(row.id)) duplicates.set(row.id, named[0]);
    }
  }
  // Compare every pending record with better-ranked records (approved first,
  // then stronger pending ones), so near-identical pairs keep one record.
  const ordered = [...rows].sort((left, right) => rank(right) - rank(left));
  for (const [index, row] of ordered.entries()) {
    if (row.review_decision !== "pending" || duplicates.has(row.id)) continue;
    const match = ordered.slice(0, index).find((other) => !duplicates.has(other.id) && similar(row, other));
    if (match) duplicates.set(row.id, match);
  }
  return duplicates;
}

function siteName(html) {
  const match = /<meta\b[^>]*(?:property|name)=["']og:site_name["'][^>]*content=["']([^"']{2,80})["']/iu.exec(html ?? "")
    ?? /<meta\b[^>]*content=["']([^"']{2,80})["'][^>]*(?:property|name)=["']og:site_name["']/iu.exec(html ?? "");
  const name = match?.[1]?.trim();
  return name && !/^(?:home|homepage|welcome|index)$/i.test(name) ? name : null;
}

async function checkOfficialPage(row) {
  const url = row.official_url ?? (row.source_type === "official" ? row.source_url : null);
  if (!url) return { ok: false };
  const permission = await robots(url);
  if (!permission.allowed) return { ok: false, reason: permission.reason };
  try {
    const page = await fetchPage(url);
    const text = page.text ?? "";
    const signal = scoreCallSignal(text);
    const quote = row.raw_payload?.decision_fields?.evidence?.deadline ?? row.raw_payload?.evidence?.deadline_quote ?? null;
    const reread = extractDeadline(text, { title: row.title });
    // The deadline counts as confirmed only when the extractor finds the same
    // date on the page under its own rules (banners for other calls, labels
    // and title proximity). A matching quote alone can be a site-wide banner.
    const deadlineEvidenceFound = Boolean(reread && row.deadline && reread.deadline === String(row.deadline).slice(0, 10));
    const quoteStillOnPage = Boolean(quote && fold(text).includes(fold(quote)));
    return {
      ok: true,
      url,
      finalUrl: page.finalUrl,
      httpStatus: page.httpStatus ?? 200,
      checkedAt: page.checkedAt,
      closed: signal.closed,
      callSignal: signal.pass,
      deadlineEvidenceFound,
      quoteStillOnPage,
      organizer: siteName(page.html),
    };
  } catch (error) {
    return { ok: false, httpStatus: error.httpStatus ?? null };
  }
}

async function rpc(row, action, reason, { targetStatus = null, changes = {} } = {}) {
  return supabase("rpc/apply_opportunity_review", {
    method: "POST",
    body: JSON.stringify({
      p_opportunity_id: row.id,
      p_action: action,
      ...REVIEWER,
      p_reason: `Automatic review: ${reason}`.slice(0, 2000),
      p_changes: changes,
      p_expected_updated_at: row.updated_at,
      p_target_status: targetStatus,
      p_acknowledge_conflict: false,
    }),
  }).catch((error) => ({ ok: false, error: error.message }));
}

const fields = "id,title,organizer,category,summary,status,triage_flags,deadline,deadline_status,official_url,official_url_status,source_url,source_type,source_url_status,has_conflict,confidence,review_reason,review_decision,edition_year,raw_payload,updated_at";
const rows = await all(`opportunities?select=${fields}&review_decision=in.(pending,approved)&order=id.asc`);
const pending = rows.filter((row) => row.review_decision === "pending");
const duplicates = findDuplicates(rows);
const flags = await supportsFlags();

const decisions = await mapPool(pending, 6, async (row) => {
  const first = autoReviewDecision(row, { duplicateOf: duplicates.get(row.id) ?? null, genericTitle: isGenericTitle(row.title), page: { ok: true, callSignal: true, deadlineEvidenceFound: true } });
  // Only records that could be approved need the (network) page check.
  if (first.decision !== "approve" && first.decision !== "human") return { row, ...first };
  const page = await checkOfficialPage(row);
  return { row, page, ...autoReviewDecision(row, { duplicateOf: duplicates.get(row.id) ?? null, genericTitle: isGenericTitle(row.title), page }) };
});

const summary = { mode: apply ? "apply" : "dry-run", version: AUTO_REVIEW_VERSION, pending: pending.length, approve_limit: approveLimit, counts: {}, applied: {}, errors: 0 };
for (const item of decisions) summary.counts[item.decision] = (summary.counts[item.decision] ?? 0) + 1;

if (apply) {
  let approved = 0;
  for (const item of decisions) {
    const { row, decision, reasons } = item;
    let result = null;
    if (decision === "approve") {
      if (approved >= approveLimit) continue;
      // Record the fresh official-page check first (pending rows only), then
      // approve against the new version of the row.
      const [fresh] = await supabase(`opportunities?id=eq.${row.id}&review_decision=eq.pending`, {
        method: "PATCH",
        prefer: "return=representation",
        body: JSON.stringify({
          official_url: row.official_url ?? item.page.url,
          official_url_status: "verified",
          official_url_http_status: item.page.httpStatus,
          official_url_final: item.page.finalUrl,
          official_url_last_checked_at: item.page.checkedAt,
          official_url_verified_at: item.page.checkedAt,
        }),
      });
      if (!fresh) continue;
      result = await rpc(fresh, "approve", reasons.join("; "), { targetStatus: item.targetStatus, changes: item.changes });
      if (result?.ok) approved += 1;
    } else if (decision === "reject" || decision === "archive") {
      result = await rpc(row, decision, reasons.join(" "));
    } else if (flags) {
      // watch / human: label the queue so people only see what needs them.
      const note = decision === "human" ? `Needs review: ${reasons.join(" ")}` : null;
      const current = [row];
      const kept = (current[0]?.triage_flags ?? []).filter((flag) => flag !== "needs-human" && flag !== "watching");
      const label = decision === "human" ? "needs-human" : "watching";
      const unchanged = (row.triage_flags ?? []).includes(label)
        && !(row.triage_flags ?? []).includes(label === "watching" ? "needs-human" : "watching")
        && (!note || String(row.review_reason ?? "").includes(note));
      if (unchanged) {
        summary.applied.unchanged = (summary.applied.unchanged ?? 0) + 1;
        continue;
      }
      const fp = /false-positive candidate/i.test(String(current[0]?.review_reason ?? "")) ? `${String(current[0].review_reason).replace(/s*Needs review:.*$/s, "")} ` : "";
      await supabase(`opportunities?id=eq.${row.id}&review_decision=eq.pending`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          triage_flags: [...kept, decision === "human" ? "needs-human" : "watching"],
          ...(note ? { review_reason: `${fp}${note}`.slice(0, 1000) } : {}),
        }),
      });
      result = { ok: true };
    }
    if (result) {
      if (result.ok) summary.applied[decision] = (summary.applied[decision] ?? 0) + 1;
      else summary.errors += 1;
    }
  }
}

// Re-check records this automation published earlier against the current
// rules, so a rule fix also corrects what older versions let through.
const autoApproved = new Set((await all(
  "opportunity_review_events?select=opportunity_id&action=eq.approve&reviewer_email=eq.auto-review@cineradar.invalid&order=created_at.asc",
)).map((event) => event.opportunity_id));
// Every published record (whoever approved it): a call whose deadline passed
// leaves the public catalogue (archived, reversible), and page labels or a
// wrong category in its name are corrected.
const published = rows.filter((row) => row.review_decision === "approved");
const expired = published.filter((row) => isExpiredPublication(row));
const expiredIds = new Set(expired.map((row) => row.id));
// Same organizer, same deadline day and the same name once years are ignored:
// one call published twice. Keep the more specific name (the longer title).
const publishedGroups = new Map();
for (const row of published) {
  if (expiredIds.has(row.id) || !row.deadline) continue;
  const key = [fold(row.organizer), String(row.deadline).slice(0, 10), fold(row.title).replace(/\b(?:19|20)\d\d\b/g, "").replace(/\s+/g, " ").trim()].join("|");
  if (!publishedGroups.has(key)) publishedGroups.set(key, []);
  publishedGroups.get(key).push(row);
}
for (const group of publishedGroups.values()) {
  if (group.length < 2) continue;
  group.sort((left, right) => right.title.length - left.title.length || String(left.id).localeCompare(String(right.id)));
  for (const row of group.slice(1)) {
    expired.push({ ...row, duplicateOf: group[0] });
    expiredIds.add(row.id);
  }
}
const renames = published
  .filter((row) => !expiredIds.has(row.id) && !autoApproved.has(row.id))
  .map((row) => ({ row, changes: publicNameChanges(row) }))
  .filter((item) => Object.keys(item.changes).length);
summary.published_maintenance = {
  expired: expired.filter((row) => !row.duplicateOf).map((row) => `${row.title.slice(0, 55)} — deadline ${String(row.deadline).slice(0, 10)}`),
  duplicates: expired.filter((row) => row.duplicateOf).map((row) => `${row.title.slice(0, 55)} = ${row.duplicateOf.title.slice(0, 55)}`),
  rename: renames.map((item) => `${item.row.title.slice(0, 50)} → ${JSON.stringify(item.changes).slice(0, 110)}`),
};
if (apply) {
  for (const row of expired) {
    const reason = row.duplicateOf
      ? `${AUTO_REVIEW_VERSION}: duplicate of the published "${row.duplicateOf.title}" (same organizer, deadline and name)`
      : `${AUTO_REVIEW_VERSION}: the deadline (${String(row.deadline).slice(0, 10)}) has passed; the call is no longer open`;
    const result = await rpc(row, "archive", reason);
    if (!result?.ok) summary.errors += 1;
  }
  for (const item of renames) {
    const result = await rpc(item.row, "edit", `${AUTO_REVIEW_VERSION} public name clean-up (page labels removed, category from the event's own name)`, { changes: item.changes });
    if (!result?.ok) summary.errors += 1;
  }
}

const recheck = rows
  .filter((row) => row.review_decision === "approved" && autoApproved.has(row.id) && !expiredIds.has(row.id))
  .map((row) => ({
    row,
    ...autoReviewDecision(row, {
      duplicateOf: duplicates.get(row.id) ?? null,
      genericTitle: isGenericTitle(row.title),
      page: { ok: true, httpStatus: 200, finalUrl: row.official_url, callSignal: true, deadlineEvidenceFound: true, closed: false, organizer: null },
    }),
  }));
summary.recheck = {
  published_by_automation: recheck.length,
  withdraw: recheck.filter((item) => item.decision !== "approve").map((item) => `${item.row.title.slice(0, 55)} — ${item.reasons.join(" ").slice(0, 100)}`),
  rename: recheck.filter((item) => item.decision === "approve" && Object.keys(item.changes ?? {}).length)
    .map((item) => `${item.row.title.slice(0, 50)} → ${JSON.stringify(item.changes).slice(0, 110)}`),
};
if (apply) {
  for (const item of recheck) {
    if (item.decision === "archive") {
      const result = await rpc(item.row, "archive", `re-check under ${AUTO_REVIEW_VERSION}: ${item.reasons.join(" ")}`);
      if (!result?.ok) summary.errors += 1;
    } else if (item.decision !== "approve") {
      const result = await rpc(item.row, "reopen", `re-check under ${AUTO_REVIEW_VERSION}: ${item.reasons.join(" ")}`);
      if (!result?.ok) summary.errors += 1;
    } else if (Object.keys(item.changes ?? {}).length) {
      const result = await rpc(item.row, "edit", `${AUTO_REVIEW_VERSION} name clean-up from the page's own organizer and title`, { changes: item.changes });
      if (!result?.ok) summary.errors += 1;
    }
  }
}

const show = (decision) => decisions.filter((item) => item.decision === decision)
  .map((item) => `${item.row.title.slice(0, 55)} — ${item.reasons.join(" ").slice(0, 110)}`);
summary.approve = show("approve");
summary.reject = show("reject");
summary.archive = show("archive");
summary.human = show("human");
summary.watch_count = decisions.filter((item) => item.decision === "watch").length;
console.log(JSON.stringify(summary, null, 2));
