// Daily queue triage. Archives pending records whose recorded deadline has
// passed or whose source says the call is closed (through the audited review
// RPC, reversible with "Back to pending"), and writes a readiness score and
// flags that order the review queue. Never publishes anything.
//
//   node scripts/cineradar/triage.mjs           # dry run
//   node scripts/cineradar/triage.mjs --apply   # write

import { TRIAGE_VERSION, triageRecord } from "../../lib/review-triage.mjs";
import { supabase } from "./supabase.mjs";

const apply = process.argv.includes("--apply");
const TRIAGE_REVIEWER = {
  p_reviewer_email: "pipeline-triage@cineradar.invalid",
  p_reviewer_name: "CineRadar automatic triage",
};

async function supportsTriageColumns() {
  try {
    await supabase("opportunities?select=readiness_score,triage_flags&limit=1");
    return true;
  } catch (error) {
    if (/readiness_score|triage_flags|42703|PGRST204/i.test(String(error.message))) return false;
    throw error;
  }
}

const columns = await supportsTriageColumns();
const rows = [];
for (let offset = 0; ; offset += 1000) {
  const batch = await supabase(
    `opportunities?select=id,title,status,deadline,deadline_status,official_url,official_url_status,source_type,source_url_status,organizer,has_conflict,max_runtime_minutes,ai_policy,entry_fee_amount,application_url,eligibility,confidence,review_reason,updated_at&review_decision=eq.pending&order=id.asc&limit=1000&offset=${offset}`,
  );
  rows.push(...batch);
  if (batch.length < 1000) break;
}

const summary = { mode: apply ? "apply" : "dry-run", version: TRIAGE_VERSION, pending: rows.length, triage_columns: columns, archived: 0, archive_errors: 0, scored: 0, flags: {} };
const toArchive = [];
const scores = [];
for (const row of rows) {
  const result = triageRecord(row);
  for (const flag of result.flags) summary.flags[flag] = (summary.flags[flag] ?? 0) + 1;
  if (result.archive) toArchive.push({ row, reason: result.archive });
  else scores.push({ row, ...result });
}
summary.to_archive = toArchive.length;

if (apply) {
  for (const { row, reason } of toArchive) {
    const result = await supabase("rpc/apply_opportunity_review", {
      method: "POST",
      body: JSON.stringify({
        p_opportunity_id: row.id,
        p_action: "archive",
        ...TRIAGE_REVIEWER,
        p_reason: reason,
        p_changes: {},
        p_expected_updated_at: row.updated_at,
        p_target_status: null,
        p_acknowledge_conflict: false,
      }),
    }).catch((error) => ({ ok: false, error: error.message }));
    if (result?.ok) summary.archived += 1;
    else summary.archive_errors += 1;
  }
  if (columns) {
    const triagedAt = new Date().toISOString();
    for (const { row, score, flags } of scores) {
      // Pending rows only: a record approved meanwhile is left untouched.
      await supabase(`opportunities?id=eq.${row.id}&review_decision=eq.pending`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ readiness_score: score, triage_flags: flags, triaged_at: triagedAt }),
      });
      summary.scored += 1;
    }
  }
}

summary.top = scores
  .sort((left, right) => right.score - left.score)
  .slice(0, 10)
  .map(({ row, score, flags }) => `${String(score).padStart(3)} ${row.title.slice(0, 55)} [${flags.join(", ")}]`);
summary.archive_sample = toArchive.slice(0, 12).map(({ row, reason }) => `${row.title.slice(0, 55)} — ${reason.slice(0, 70)}`);
console.log(JSON.stringify(summary, null, 2));
