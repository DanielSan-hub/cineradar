// Deterministic triage of the pending review queue. Automation may only keep
// records private (archive) and order the queue; it never publishes. Pure:
// shared by the daily triage job and tests.

import { isTeamOnlyRecord, publicationBlockers } from "./review-workflow.mjs";

export const TRIAGE_VERSION = "triage-v1";
const DAY = 86_400_000;
// Grace period so a deadline recorded without a time zone is never archived
// while it may still be open somewhere.
const ARCHIVE_GRACE_DAYS = 2;

function known(value) {
  return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

/**
 * @param {Record<string, any>} row pending opportunity row (snake_case)
 * @returns {{ score: number, flags: string[], archive: string | null }}
 */
export function triageRecord(row, { now = Date.now() } = {}) {
  // Festhome data stays inside the team (never published): its own tab.
  const flags = isTeamOnlyRecord(row) ? ["team-only"] : [];
  const deadline = row.deadline ? Date.parse(String(row.deadline)) : NaN;
  const hasDeadline = Number.isFinite(deadline);

  if (hasDeadline && deadline < now - ARCHIVE_GRACE_DAYS * DAY && row.deadline_status !== "rolling") {
    return {
      score: 0,
      flags: ["deadline-passed"],
      archive: `Automatic triage: the recorded deadline (${new Date(deadline).toISOString().slice(0, 10)}) has passed. Reopen if a new edition is confirmed.`,
    };
  }
  if (row.status === "closed") {
    return {
      score: 0,
      flags: ["closed"],
      archive: "Automatic triage: the source states this call is closed. Reopen if a new edition is confirmed.",
    };
  }

  const asVerified = publicationBlockers({ ...row, status: "verified" }, { now });
  const asOpen = publicationBlockers({ ...row, status: "open" }, { now });
  let score = 0;
  if (!asVerified.length) {
    flags.push("publishable");
    score += 40;
    if (!asOpen.length) score += 15;
  }
  if (asVerified.includes("no-verified-official-page")) flags.push("needs-official-url");
  if (asVerified.includes("missing-organizer")) flags.push("missing-organizer");
  if (row.has_conflict) {
    flags.push("conflict");
    score -= 10;
  }
  if (!hasDeadline && row.deadline_status !== "rolling") flags.push("needs-deadline");
  if (hasDeadline && deadline >= now) {
    const days = (deadline - now) / DAY;
    if (days <= 14) flags.push("closing-soon");
    score += days <= 45 ? 15 : days <= 90 ? 8 : 0;
  }
  // Decision-grade completeness: each known fact makes the record more useful.
  const facts = [
    hasDeadline || row.deadline_status === "rolling",
    known(row.max_runtime_minutes),
    known(row.ai_policy) && row.ai_policy !== "unclear",
    known(row.entry_fee_amount),
    known(row.application_url),
    known(row.eligibility),
  ];
  score += facts.filter(Boolean).length * 3;
  score += Math.round(Math.max(0, Math.min(1, Number(row.confidence ?? 0))) * 10);
  if (/false-positive candidate/i.test(String(row.review_reason ?? ""))) {
    flags.push("generic-page");
    score -= 30;
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), flags, archive: null };
}

export const TRIAGE_FLAG_LABELS = Object.freeze({
  "needs-human": "Needs you",
  "team-only": "Team only (Festhome)",
  watching: "Watching for a deadline",
  publishable: "Ready to publish",
  "closing-soon": "Closing within 14 days",
  "needs-official-url": "Needs a verified official URL",
  "needs-deadline": "No deadline recorded",
  "missing-organizer": "Organizer unknown",
  conflict: "Conflicting sources",
  "generic-page": "Possibly a generic page",
});
