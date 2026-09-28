// Daily automatic review (owner decision 2026-09-29). Settles pending records
// from evidence: approves live calls after re-checking the official page now,
// rejects listing/past-edition pages, archives duplicates, and leaves only
// genuinely undecidable records for a human. Every decision goes through the
// audited review RPC and is reversible.
//
//   node scripts/cineradar/auto-review.mjs           # dry run
//   node scripts/cineradar/auto-review.mjs --apply   # write

import { AUTO_REVIEW_VERSION, autoReviewDecision } from "../../lib/auto-review.mjs";
import { scoreCallSignal } from "./call-signal.mjs";
import { extractDeadline } from "./decision-fields.mjs";
import { mapPool } from "./http.mjs";
import { seriesKey } from "./registry-seeds.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { supabase } from "./supabase.mjs";
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
    return shared / Math.min(mine.size, theirs.size) >= 0.7 && (editionYear(left) ?? 0) === (editionYear(right) ?? 0);
  };
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
    const deadlineEvidenceFound = Boolean(quote && fold(text).includes(fold(quote)))
      || Boolean(reread && row.deadline && reread.deadline === String(row.deadline).slice(0, 10));
    return {
      ok: true,
      url,
      finalUrl: page.finalUrl,
      httpStatus: page.httpStatus ?? 200,
      checkedAt: page.checkedAt,
      closed: signal.closed,
      callSignal: signal.pass,
      deadlineEvidenceFound,
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

const fields = "id,title,organizer,category,summary,status,deadline,deadline_status,official_url,official_url_status,source_url,source_type,source_url_status,has_conflict,confidence,review_reason,review_decision,edition_year,raw_payload,updated_at";
const rows = await all(`opportunities?select=${fields}&review_decision=in.(pending,approved)&order=id.asc`);
const pending = rows.filter((row) => row.review_decision === "pending");
const duplicates = findDuplicates(rows);
const flags = await supportsFlags();

const decisions = await mapPool(pending, 6, async (row) => {
  const first = autoReviewDecision(row, { duplicateOf: duplicates.get(row.id) ?? null, page: { ok: true, callSignal: true, deadlineEvidenceFound: true } });
  // Only records that could be approved need the (network) page check.
  if (first.decision !== "approve" && first.decision !== "human") return { row, ...first };
  const page = await checkOfficialPage(row);
  return { row, page, ...autoReviewDecision(row, { duplicateOf: duplicates.get(row.id) ?? null, page }) };
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
      const current = await supabase(`opportunities?select=triage_flags,review_reason&id=eq.${row.id}`);
      const kept = (current[0]?.triage_flags ?? []).filter((flag) => flag !== "needs-human" && flag !== "watching");
      const fp = /false-positive candidate/i.test(String(current[0]?.review_reason ?? "")) ? `${current[0].review_reason} ` : "";
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

const show = (decision) => decisions.filter((item) => item.decision === decision)
  .map((item) => `${item.row.title.slice(0, 55)} — ${item.reasons.join(" ").slice(0, 110)}`);
summary.approve = show("approve");
summary.reject = show("reject");
summary.archive = show("archive");
summary.human = show("human");
summary.watch_count = decisions.filter((item) => item.decision === "watch").length;
console.log(JSON.stringify(summary, null, 2));
