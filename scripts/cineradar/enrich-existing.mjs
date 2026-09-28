// Fill missing decision fields on existing pending records from their live
// source page, with verbatim evidence. Only empty fields are filled; pages
// shared by several records (listings) are skipped because page-level facts
// cannot be attributed to one of them.
//
//   node scripts/cineradar/enrich-existing.mjs          # dry run
//   node scripts/cineradar/enrich-existing.mjs --apply  # write

import { DECISION_FIELDS_VERSION, extractDecisionFields } from "./decision-fields.mjs";
import { mapPool } from "./http.mjs";
import { createRobotsChecker } from "./robots.mjs";
import { supabase } from "./supabase.mjs";
import { canonicalizeUrl, fetchPage } from "./web-validation.mjs";

const apply = process.argv.includes("--apply");
const robots = createRobotsChecker({ userAgent: "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)" });

const rows = await supabase(
  "opportunities?select=id,title,source_url,official_url,deadline,deadline_status,max_runtime_minutes,entry_fee_amount,ai_policy,eligibility,raw_payload&review_decision=eq.pending&order=id.asc&limit=1000",
);
const pageUse = new Map();
for (const row of rows) {
  const url = canonicalizeUrl(row.source_url);
  pageUse.set(url, (pageUse.get(url) ?? 0) + 1);
}

const summary = { mode: apply ? "apply" : "dry-run", pending: rows.length, shared_page_skipped: 0, fetched: 0, unreachable: 0, updated: 0, filled: {} };
const changes = [];
await mapPool(rows, 6, async (row) => {
  if ((pageUse.get(canonicalizeUrl(row.source_url)) ?? 0) > 1) {
    summary.shared_page_skipped += 1;
    return;
  }
  const url = row.official_url ?? row.source_url;
  if (!(await robots(url)).allowed) {
    summary.unreachable += 1;
    return;
  }
  let page;
  try {
    page = await fetchPage(url);
  } catch {
    summary.unreachable += 1;
    return;
  }
  summary.fetched += 1;
  const facts = extractDecisionFields(page.text ?? "", { title: row.title });
  const patch = {};
  const evidence = {};
  if (facts.deadline && !row.deadline && row.deadline_status !== "rolling") {
    patch.deadline = `${facts.deadline.deadline}T23:59:59.000Z`;
    patch.deadline_status = "confirmed";
    patch.deadline_source_url = page.finalUrl;
    patch.deadline_last_verified_at = page.checkedAt;
    evidence.deadline = facts.deadline.evidence;
  }
  if (facts.runtime && row.max_runtime_minutes === null) {
    patch.max_runtime_minutes = facts.runtime.max_runtime_minutes;
    evidence.max_runtime = facts.runtime.evidence;
  }
  if (facts.fee && row.entry_fee_amount === null) {
    patch.entry_fee_amount = facts.fee.entry_fee_amount;
    patch.entry_fee_currency = facts.fee.entry_fee_currency;
    evidence.entry_fee = facts.fee.evidence;
  }
  if (facts.ai_policy && (!row.ai_policy || row.ai_policy === "unclear")) {
    patch.ai_policy = facts.ai_policy.ai_policy;
    evidence.ai_policy = facts.ai_policy.evidence;
  }
  if (facts.eligibility && !(row.eligibility ?? []).length) {
    patch.eligibility = facts.eligibility.eligibility;
    evidence.eligibility = facts.eligibility.evidence;
  }
  const premiere = facts.premiere ? { premiere_requirement: facts.premiere.premiere_requirement } : {};
  if (facts.premiere) evidence.premiere = facts.premiere.evidence;
  if (!Object.keys(evidence).length) return;
  for (const field of Object.keys(evidence)) summary.filled[field] = (summary.filled[field] ?? 0) + 1;
  patch.raw_payload = {
    ...(row.raw_payload ?? {}),
    decision_fields: {
      version: DECISION_FIELDS_VERSION,
      page_url: page.finalUrl,
      checked_at: page.checkedAt,
      evidence,
      ...premiere,
    },
  };
  changes.push({ id: row.id, title: row.title, patch, evidence });
});

if (apply) {
  for (const change of changes) {
    await supabase(`opportunities?id=eq.${change.id}&review_decision=eq.pending`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify(change.patch),
    });
  }
  summary.updated = changes.length;
}
summary.records_with_new_facts = changes.length;
console.log(JSON.stringify(summary, null, 2));
if (!apply) {
  for (const change of changes.slice(0, 40)) {
    const fields = Object.keys(change.evidence).map((field) => `${field}: «${change.evidence[field].slice(0, 90)}»`).join("\n    ");
    console.log(`- ${change.title.slice(0, 60)}\n    ${fields}`);
  }
}
