"use server";

import { revalidatePath } from "next/cache";

import { getTeamUser } from "@/app/chatgpt-auth";
import {
  diffReviewFields,
  EDITABLE_FIELDS,
  isUuid,
  validateReviewIntent,
} from "@/lib/review-workflow.mjs";
import { applyReview, getReviewRecord } from "@/lib/server/review";

export type ReviewFormState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  blockers?: string[];
  values?: Record<string, string>;
  /** Changes on every response so the form remounts with the returned values. */
  nonce?: number;
};

const ERROR_MESSAGES: Record<string, string> = {
  stale: "Someone (or the pipeline) changed this record after you opened it. Reload the page and review the current values.",
  "not-found": "This record no longer exists.",
  "reason-required": "Explain what you checked (at least 3 characters).",
  "invalid-target-status": "Choose the public status to publish with.",
  "field-not-editable": "The form contained a field that cannot be edited.",
  "database-error": "The database rejected the change. Nothing was saved.",
  unavailable: "The review workflow migration has not been applied yet.",
};

function formValues(formData: FormData) {
  const values: Record<string, string> = {};
  for (const field of [...Object.keys(EDITABLE_FIELDS), "reason", "target_status", "acknowledge_conflict"]) {
    const value = formData.get(field);
    if (typeof value === "string") values[field] = value;
  }
  return values;
}

export async function submitReview(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  // Identity comes only from the Sites headers on this request.
  const user = await getTeamUser();
  if (!user) return { status: "error", message: "Not authorized.", nonce: Date.now() };

  const values = formValues(formData);
  const id = String(formData.get("id") ?? "");
  const expectedUpdatedAt = String(formData.get("expected_updated_at") ?? "");
  const action = String(formData.get("intent") ?? "");
  const targetStatus = String(formData.get("target_status") ?? "") || null;
  const acknowledgeConflict = formData.get("acknowledge_conflict") === "on";
  if (!isUuid(id) || !expectedUpdatedAt) {
    return { status: "error", message: "Malformed request.", values, nonce: Date.now() };
  }

  const intent = validateReviewIntent({
    action,
    reason: formData.get("reason"),
    targetStatus,
  });
  const record = await getReviewRecord(id).catch((error: unknown) => {
    console.error("Unable to load record for review", error);
    return null;
  });
  if (!record) return { status: "error", message: ERROR_MESSAGES["not-found"], values, nonce: Date.now() };
  if (!record.reviewWorkflow) return { status: "error", message: ERROR_MESSAGES.unavailable, values, nonce: Date.now() };

  const { changes, errors } = diffReviewFields(record.row, values);
  const fieldErrors = { ...errors, ...intent.errors };
  if (Object.keys(fieldErrors).length) {
    return { status: "error", message: "Fix the highlighted fields.", fieldErrors, values, nonce: Date.now() };
  }
  if (action === "edit" && !Object.keys(changes).length) {
    return { status: "error", message: "No field was changed.", values, nonce: Date.now() };
  }

  const result = await applyReview({
    opportunityId: id,
    action,
    reviewerEmail: user.email,
    reviewerName: user.fullName,
    reason: intent.reason,
    changes,
    expectedUpdatedAt,
    targetStatus: action === "approve" ? targetStatus : null,
    acknowledgeConflict,
  });

  if (!result.ok) {
    if (result.error === "blocked") {
      return {
        status: "error",
        message: "Not published: the record does not pass the publication gate.",
        blockers: result.blockers ?? [],
        values,
        nonce: Date.now(),
      };
    }
    return {
      status: "error",
      message: ERROR_MESSAGES[result.error] ?? "The action failed. Nothing was saved.",
      values,
      nonce: Date.now(),
    };
  }

  revalidatePath("/team");
  revalidatePath(`/team/review/${id}`);
  revalidatePath("/");
  const summary = result.changedFields.length
    ? `Changed: ${result.changedFields.join(", ")}.`
    : "No field changed.";
  return {
    status: "success",
    message: `Saved as ${result.reviewDecision}. ${summary}`,
    nonce: Date.now(),
  };
}
