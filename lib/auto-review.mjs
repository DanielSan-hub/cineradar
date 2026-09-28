// Automatic review of pending opportunities (owner decision 2026-09-29):
// the pipeline approves, rejects or archives records it can settle from
// evidence, and escalates to a human only when it cannot evaluate. Pure: the
// caller supplies a fresh check of the official page.

import { publicationBlockers } from "./review-workflow.mjs";

export const AUTO_REVIEW_VERSION = "auto-review-v2";
const DAY = 86_400_000;

// Pages that list or describe many calls, or a finished edition, are sources
// to monitor, not opportunities to publish.
const LISTING_TITLE = /^(?:festival\s+(?:list|directory)|funding\s+(?:overview|deadlines)|get\s+funding(?:\s+and\s+support)?|festival\s+submissions?\s*(?:&|and)\s*deadlines(?:\s+20\d{2})?|open\s+calls\s*[|:–-].*|opportunities|all\s+opportunities|awesome\b.*|.*\bdata\s+api\b.*|.*\bdirectory\b.*|.*\boverview\b.*)$/iu;
const RETROSPECTIVE_TITLE = /\b(?:these\s+are|programme|program\s+schedule|line-?up|winners?|award-winning|highlights|recap|in\s+competition)\b/iu;
// A deadline tier is not the name of an opportunity ("Late Deadline: Jan 10").
const DEADLINE_LABEL_TITLE = /^(?:early\s*-?\s*bird|earlybird|regular|late|final|extended|standard|last)?\s*deadlines?\b/iu;
// Several generic plural nouns describe a list, not one call.
const GENERIC_PLURALS = /\b(?:festivals|events|competitions|contests|awards|grants|residencies|opportunities|calls|deadlines|challenges)\b/giu;
// Things people apply for that are not submitting work as filmmakers.
const NOT_A_FILMMAKER_CALL = /\b(?:accreditations?|jur(?:y|ies)|volunteers?|tickets?|press\s+pass(?:es)?|internships?|jobs?|careers?|vacanc(?:y|ies)|hiring)\b/iu;
// Moving-image relevance: film, video, animation, media art, AI video...
const FILM_RELEVANT = /\b(?:films?|filmmak\w*|cinem\w*|movies?|videos?|moving\s+image|animat\w*|screen\w*|audiovisual|documentar\w*|shorts?|music\s+videos?|media\s+arts?|new\s+media|digital\s+arts?|xr|vr|immersive|cortometr\w*|largometr\w*|court[- ]m[ée]trage|kurzfilm\w*|curta|longa)\b|映像|映画|動画|アニメ|영화|영상|애니메이션|电影|影像|動畫|视频/iu;
// Other disciplines: out of scope unless film is mentioned too.
const OTHER_DISCIPLINE = /\b(?:illustrat\w*|literature|literary|poetry|painting|sculpture|ceramics|architecture|photograph\w*|comics?|manga)\b|イラスト|文学|絵画|写真/iu;
// An "official page" that is a news list or listing index proves nothing about one call.
const LISTING_URL = /[?&]page=|\/news\/?(?:[?#]|$)|\/(?:opportunities|open-calls|calls|listings?)\/?(?:[?#]|$)/iu;

function titleYears(title) {
  return [...String(title ?? "").matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
}

/**
 * @param {Record<string, any>} row pending opportunity
 * @param {{
 *   now?: number,
 *   duplicateOf?: { id: string, title: string } | null,
 *   page?: { ok: boolean, httpStatus?: number, finalUrl?: string, closed?: boolean,
 *            callSignal?: boolean, deadlineEvidenceFound?: boolean, organizer?: string | null } | null,
 * }} context
 */
export function autoReviewDecision(row, { now = Date.now(), duplicateOf = null, page = null, genericTitle = false } = {}) {
  const reasons = [];
  const title = String(row.title ?? "").trim();

  if (genericTitle) {
    return { decision: "reject", reasons: ["The title is a section heading or deadline tier, not the name of an opportunity; the named call is tracked separately."] };
  }

  if (duplicateOf) {
    return { decision: "archive", reasons: [`Duplicate of "${duplicateOf.title}" (${duplicateOf.id.slice(0, 8)}).`] };
  }
  if (LISTING_TITLE.test(title) || (title.match(GENERIC_PLURALS) ?? []).length >= 2) {
    return { decision: "reject", reasons: ["Listing or overview page, not a single call; its calls are found through the source registry."] };
  }
  if (DEADLINE_LABEL_TITLE.test(title)) {
    return { decision: "reject", reasons: ["The title is a deadline label, not the name of an opportunity; the call itself is tracked under its own record."] };
  }
  if (NOT_A_FILMMAKER_CALL.test(title)) {
    return { decision: "reject", reasons: ["Not an opportunity to submit work (accreditation, jury, job or similar)."] };
  }
  const topic = `${title} ${row.summary ?? ""} ${row.category ?? ""}`;
  const filmRelevant = FILM_RELEVANT.test(topic) || /AI film festival/i.test(String(row.category ?? ""));
  if (!filmRelevant && OTHER_DISCIPLINE.test(topic)) {
    return { decision: "reject", reasons: ["Out of scope: a call for another discipline with no film or moving-image component stated."] };
  }
  const years = titleYears(title);
  const currentYear = new Date(now).getUTCFullYear();
  if (RETROSPECTIVE_TITLE.test(title) || (years.length && Math.max(...years) < currentYear)) {
    return { decision: "reject", reasons: ["Programme, results or past-edition page, not an open call."] };
  }

  const deadline = row.deadline ? Date.parse(String(row.deadline)) : NaN;
  const rolling = row.deadline_status === "rolling";
  const hasFutureDeadline = Number.isFinite(deadline) && deadline > now + 2 * DAY && row.deadline_status === "confirmed";
  if (!hasFutureDeadline && !rolling) {
    // Nothing to decide yet: re-evaluated automatically as sources change.
    return { decision: "watch", reasons: [Number.isFinite(deadline) ? "Deadline too close or unconfirmed." : "No confirmed deadline published yet."] };
  }

  // From here the record looks like a live call: approve only on fresh proof.
  if (!filmRelevant) reasons.push("No film or moving-image element stated in the title or summary.");
  if (LISTING_URL.test(String(row.official_url ?? page?.finalUrl ?? ""))) {
    reasons.push("The official page is a news list or listing, not the call's own page.");
  }
  if (row.has_conflict) reasons.push("Sources conflict on status or deadline.");
  if (/false-positive candidate/i.test(String(row.review_reason ?? ""))) reasons.push("Flagged as a possible generic page.");
  if (Number(row.confidence ?? 0) < 0.6) reasons.push(`Low extraction confidence (${Number(row.confidence ?? 0).toFixed(2)}).`);
  if (!page?.ok) reasons.push(`Official page not reachable now${page?.httpStatus ? ` (HTTP ${page.httpStatus})` : ""}.`);
  if (page?.ok && page.closed) reasons.push("The official page now says the call is closed.");
  if (page?.ok && !page.callSignal) reasons.push("The official page no longer shows an open call.");
  if (page?.ok && !rolling && !page.deadlineEvidenceFound) reasons.push("The deadline is no longer stated on the official page.");

  const organizer = String(row.organizer ?? "").trim();
  const organizerKnown = organizer && !/^unknown(?:\s+organizer)?$/i.test(organizer);
  const organizerPatch = !organizerKnown && page?.organizer ? { organizer: page.organizer } : {};
  if (!organizerKnown && !page?.organizer) reasons.push("Organizer not stated on the page.");

  const days = Number.isFinite(deadline) ? (deadline - now) / DAY : Infinity;
  const targetStatus = !rolling && days <= 14 ? "closing-soon" : "open";
  const candidate = {
    ...row,
    ...organizerPatch,
    status: targetStatus,
    official_url_status: page?.ok ? "verified" : row.official_url_status,
    official_url: row.official_url ?? page?.finalUrl ?? null,
  };
  const blockers = publicationBlockers(candidate, { now });
  for (const blocker of blockers) {
    if (blocker !== "missing-organizer") reasons.push(`Publication gate: ${blocker}.`);
  }

  if (reasons.length) return { decision: "human", reasons };
  return {
    decision: "approve",
    targetStatus,
    changes: organizerPatch,
    reasons: [
      `Official page reachable (HTTP ${page.httpStatus ?? 200}) and shows an open call`,
      rolling ? "rolling deadline" : `deadline ${new Date(deadline).toISOString().slice(0, 10)} confirmed on the page`,
      organizerPatch.organizer ? `organizer "${organizerPatch.organizer}" from the page metadata` : null,
      "no conflicts",
    ].filter(Boolean),
  };
}
