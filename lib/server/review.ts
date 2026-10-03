import "server-only";

import { isTeamOnlyRecord, isUuid } from "@/lib/review-workflow.mjs";
import {
  mapOpportunityRecord,
  supabaseRequest,
  supportsReviewWorkflow,
} from "@/lib/server/data";
import type { Opportunity } from "@/lib/types";

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type JsonRecord = Record<string, unknown>;

export type ReviewEvent = {
  id: string;
  action: string;
  reviewer: string;
  reason: string;
  decisionBefore: string;
  decisionAfter: string;
  changedFields: string[];
  before: JsonRecord;
  after: JsonRecord;
  createdAt: string;
};

export type ReviewRecord = {
  row: JsonRecord;
  opportunity: Opportunity;
  events: ReviewEvent[];
  provenance: JsonRecord[];
  observations: JsonRecord[];
  reviewWorkflow: boolean;
};

async function readJson(path: string): Promise<JsonRecord[]> {
  const response = await supabaseRequest(path, SUPABASE_SERVICE_ROLE_KEY, { fresh: true });
  return (await response.json()) as JsonRecord[];
}

/** Optional evidence tables may be absent on older schemas; never fail the page on them. */
async function readOptional(path: string): Promise<JsonRecord[]> {
  try {
    return await readJson(path);
  } catch (error) {
    console.error("Optional review evidence unavailable", error);
    return [];
  }
}

function mapEvent(record: JsonRecord): ReviewEvent {
  return {
    id: String(record.id),
    action: String(record.action),
    reviewer: String(record.reviewer_name ?? record.reviewer_email ?? "Unknown reviewer"),
    reason: String(record.reason ?? ""),
    decisionBefore: String(record.decision_before ?? ""),
    decisionAfter: String(record.decision_after ?? ""),
    changedFields: Array.isArray(record.changed_fields) ? record.changed_fields.map(String) : [],
    before: (record.before_fields as JsonRecord) ?? {},
    after: (record.after_fields as JsonRecord) ?? {},
    createdAt: String(record.created_at),
  };
}

export async function getReviewRecord(id: string): Promise<ReviewRecord | null> {
  if (!isUuid(id)) return null;
  const rows = await readJson(`opportunities?select=*&id=eq.${id}&limit=1`);
  const row = rows[0];
  if (!row) return null;

  const reviewWorkflow = await supportsReviewWorkflow();
  const [events, provenance, observations] = await Promise.all([
    reviewWorkflow
      ? readOptional(`opportunity_review_events?select=*&opportunity_id=eq.${id}&order=created_at.desc&limit=50`)
      : Promise.resolve([]),
    readOptional(`opportunity_provenance?select=provider,query_text,source_url,result_rank,observed_at&opportunity_id=eq.${id}&order=observed_at.desc&limit=10`),
    readOptional(`opportunity_observations?select=observed_at,source_url,observed_status,observed_deadline,deadline_status,is_primary_evidence,conflicts&opportunity_id=eq.${id}&order=observed_at.desc&limit=10`),
  ]);

  return {
    row,
    opportunity: mapOpportunityRecord(row),
    events: events.map(mapEvent),
    provenance,
    observations,
    reviewWorkflow,
  };
}

export type ApplyReviewInput = {
  opportunityId: string;
  action: string;
  reviewerEmail: string;
  reviewerName: string | null;
  reason: string;
  changes: JsonRecord;
  expectedUpdatedAt: string;
  targetStatus: string | null;
  acknowledgeConflict: boolean;
};

export type ApplyReviewResult =
  | { ok: true; reviewDecision: string; changedFields: string[] }
  | { ok: false; error: string; blockers?: string[]; fields?: string[] };

/**
 * Calls the atomic review RPC. reviewerEmail must come from the verified
 * ChatGPT Sites identity, never from form input.
 */
export async function applyReview(input: ApplyReviewInput): Promise<ApplyReviewResult> {
  // Festhome data is for the team only: such a record is never published.
  if (input.action === "approve") {
    const rows = await readJson(`opportunities?select=tags,source_url,deadline_source_url&id=eq.${input.opportunityId}&limit=1`).catch(() => []);
    if (rows[0] && isTeamOnlyRecord(rows[0])) {
      return { ok: false, error: "This record rests on Festhome data, which is for the team only and is never published.", blockers: ["team-only-source"] };
    }
  }
  try {
    const response = await supabaseRequest(
      "rpc/apply_opportunity_review",
      SUPABASE_SERVICE_ROLE_KEY,
      {
        method: "POST",
        fresh: true,
        body: JSON.stringify({
          p_opportunity_id: input.opportunityId,
          p_action: input.action,
          p_reviewer_email: input.reviewerEmail,
          p_reviewer_name: input.reviewerName,
          p_reason: input.reason,
          p_changes: input.changes,
          p_expected_updated_at: input.expectedUpdatedAt,
          p_target_status: input.targetStatus,
          p_acknowledge_conflict: input.acknowledgeConflict,
        }),
      },
    );
    const result = (await response.json()) as JsonRecord;
    if (result.ok === true) {
      return {
        ok: true,
        reviewDecision: String(result.review_decision),
        changedFields: Array.isArray(result.changed_fields) ? result.changed_fields.map(String) : [],
      };
    }
    return {
      ok: false,
      error: String(result.error ?? "unknown"),
      blockers: Array.isArray(result.blockers) ? result.blockers.map(String) : undefined,
      fields: Array.isArray(result.fields) ? result.fields.map(String) : undefined,
    };
  } catch (error) {
    // Constraint violations surface here; the row is unchanged because the
    // RPC runs in one transaction.
    console.error("Review action failed", error);
    return { ok: false, error: "database-error" };
  }
}
