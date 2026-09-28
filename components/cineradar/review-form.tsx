"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, Archive, CheckCircle2, RotateCcw, Save, XCircle } from "lucide-react";

import { submitReview, type ReviewFormState } from "@/app/team/review/[id]/actions";
import {
  AI_POLICIES,
  BLOCKER_MESSAGES,
  CATEGORIES,
  DEADLINE_STATUSES,
  PUBLIC_TARGET_STATUSES,
  publicationBlockers,
} from "@/lib/review-workflow.mjs";

type Props = {
  id: string;
  updatedAt: string;
  reviewDecision: string;
  hasConflict: boolean;
  /** Saved row, used only for publication-gate hints. */
  savedRow: Record<string, unknown>;
  initialValues: Record<string, string>;
  disabled?: boolean;
};

const inputClass =
  "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-300/50 focus:outline-none aria-invalid:border-rose-400/60 [&>option]:bg-[#0b1620]";
const initialState: ReviewFormState = { status: "idle" };

function blockerText(code: string) {
  return BLOCKER_MESSAGES[code as keyof typeof BLOCKER_MESSAGES] ?? code;
}

export function ReviewForm({ id, updatedAt, reviewDecision, hasConflict, savedRow, initialValues, disabled }: Props) {
  const [state, formAction, pending] = useActionState(submitReview, initialState);
  const values = state.status === "error" && state.values ? state.values : initialValues;
  const errors = state.fieldErrors ?? {};
  const [targetStatus, setTargetStatus] = useState(values.target_status || "open");
  const [acknowledged, setAcknowledged] = useState(values.acknowledge_conflict === "on");
  const hints = publicationBlockers(
    { ...savedRow, status: targetStatus },
    { acknowledgeConflict: acknowledged },
  );

  const field = (name: string, label: string, input: React.ReactNode, hint?: string) => (
    <label className="block text-sm">
      <span className="mb-1.5 block text-slate-400">{label}</span>
      {input}
      {errors[name] ? (
        <span className="mt-1 block text-xs text-rose-300">{errors[name]}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
  const text = (name: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input name={name} defaultValue={values[name] ?? ""} aria-invalid={Boolean(errors[name])} className={inputClass} disabled={disabled} {...props} />
  );
  const select = (name: string, options: readonly string[], labels?: Record<string, string>) => (
    <select name={name} defaultValue={values[name] ?? ""} aria-invalid={Boolean(errors[name])} className={inputClass} disabled={disabled}>
      {options.map((option) => <option key={option} value={option}>{labels?.[option] ?? (option || "—")}</option>)}
    </select>
  );
  const list = (name: string) => (
    <textarea name={name} rows={3} defaultValue={values[name] ?? ""} aria-invalid={Boolean(errors[name])} className={inputClass} disabled={disabled} placeholder="One per line" />
  );

  return (
    <form key={`${updatedAt}:${state.nonce ?? 0}`} action={formAction} className="space-y-6">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="expected_updated_at" value={updatedAt} />

      {state.message && (
        <div role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "rounded-xl border border-rose-300/20 bg-rose-300/5 px-4 py-3 text-sm text-rose-100" : "rounded-xl border border-emerald-300/20 bg-emerald-300/5 px-4 py-3 text-sm text-emerald-100"}>
          <p>{state.message}</p>
          {state.blockers?.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">{state.blockers.map((code) => <li key={code}>{blockerText(code)}</li>)}</ul>
          ) : null}
        </div>
      )}

      <fieldset className="grid gap-4 sm:grid-cols-2" disabled={disabled || pending}>
        <legend className="mb-3 text-base font-medium text-white">Source-grounded fields</legend>
        <div className="sm:col-span-2">{field("title", "Title", text("title", { required: true, maxLength: 300 }))}</div>
        {field("organizer", "Organizer", text("organizer", { required: true, maxLength: 300 }))}
        {field("location", "Location", text("location", { required: true, maxLength: 300 }))}
        {field("category", "Category", select("category", CATEGORIES))}
        {field("ai_policy", "AI policy", select("ai_policy", AI_POLICIES))}
        {field("remote", "Remote participation", select("remote", ["true", "false"], { true: "Yes", false: "No" }))}
        {field("edition_year", "Edition year", text("edition_year", { inputMode: "numeric" }))}
        {field("deadline", "Deadline", text("deadline", { placeholder: "2026-10-15T23:59:00+02:00" }), "ISO 8601 with the organizer's timezone offset. Stored and shown back in UTC.")}
        {field("deadline_status", "Deadline status", select("deadline_status", DEADLINE_STATUSES))}
        {field("opens_at", "Opens at", text("opens_at", { placeholder: "2026-09-01T00:00:00Z" }))}
        {field("deadline_source_url", "Deadline source URL", text("deadline_source_url", { type: "url" }))}
        {field("official_url", "Official URL", text("official_url", { type: "url" }), "Changing it resets its check to unchecked until URL revalidation runs.")}
        {field("application_url", "Application URL", text("application_url", { type: "url" }), "Changing it resets its check to unchecked until URL revalidation runs.")}
        {field("prize_amount", "Prize amount", text("prize_amount", { inputMode: "decimal" }))}
        {field("prize_currency", "Prize currency", text("prize_currency", { maxLength: 3, placeholder: "EUR" }))}
        {field("entry_fee_amount", "Entry fee", text("entry_fee_amount", { inputMode: "decimal" }))}
        {field("entry_fee_currency", "Entry fee currency", text("entry_fee_currency", { maxLength: 3, placeholder: "EUR" }))}
        {field("max_runtime_minutes", "Max runtime (minutes)", text("max_runtime_minutes", { inputMode: "numeric" }))}
        <div className="sm:col-span-2">{field("summary", "Summary", <textarea name="summary" rows={4} defaultValue={values.summary ?? ""} aria-invalid={Boolean(errors.summary)} className={inputClass} maxLength={4000} disabled={disabled} />)}</div>
        {field("eligibility", "Eligibility", list("eligibility"))}
        {field("formats", "Formats", list("formats"))}
        {field("tags", "Tags", list("tags"))}
      </fieldset>

      <fieldset className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.025] p-5" disabled={disabled || pending}>
        <legend className="px-1 text-base font-medium text-white">Decision</legend>
        {field("reason", "Reason and what you checked (saved in the audit trail)", <textarea name="reason" rows={3} required minLength={3} maxLength={2000} defaultValue={values.reason ?? ""} aria-invalid={Boolean(errors.reason)} className={inputClass} placeholder="e.g. Deadline and fee confirmed on the official call page, 26 Sep 2026" />)}
        <div className="grid gap-4 sm:grid-cols-2">
          {field("target_status", "Publish as", (
            <select name="target_status" value={targetStatus} onChange={(event) => setTargetStatus(event.target.value)} className={inputClass}>
              {PUBLIC_TARGET_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          ))}
          {hasConflict && (
            <label className="flex items-start gap-2 self-end text-sm text-amber-100">
              <input type="checkbox" name="acknowledge_conflict" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" />
              I checked the conflicting claims and the fields above reflect the current official source.
            </label>
          )}
        </div>

        {hints.length > 0 && (
          <div className="rounded-xl border border-amber-300/15 bg-amber-300/5 px-4 py-3 text-sm text-amber-100">
            <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> Publication gate (saved values)</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">{hints.map((code) => <li key={code}>{blockerText(code)}</li>)}</ul>
            <p className="mt-2 text-xs text-amber-100/70">Edits in this form are checked again by the database when you approve.</p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <ActionButton intent="edit" icon={<Save />}>Save edits</ActionButton>
          <ActionButton intent="approve" icon={<CheckCircle2 />} tone="primary">Approve &amp; publish</ActionButton>
          {reviewDecision !== "rejected" && <ActionButton intent="reject" icon={<XCircle />} tone="danger">Reject</ActionButton>}
          {reviewDecision !== "archived" && <ActionButton intent="archive" icon={<Archive />}>Archive</ActionButton>}
          {reviewDecision !== "pending" && <ActionButton intent="reopen" icon={<RotateCcw />}>Back to pending</ActionButton>}
        </div>
        {pending && <p className="text-sm text-slate-400" aria-live="polite">Saving…</p>}
      </fieldset>
    </form>
  );
}

function ActionButton({ intent, icon, tone = "default", children }: { intent: string; icon: React.ReactNode; tone?: "default" | "primary" | "danger"; children: React.ReactNode }) {
  const toneClass = tone === "primary"
    ? "border-cyan-300/40 bg-cyan-300/15 text-cyan-50 hover:bg-cyan-300/25"
    : tone === "danger"
      ? "border-rose-300/30 bg-rose-300/10 text-rose-100 hover:bg-rose-300/20"
      : "border-white/12 bg-white/4 text-white hover:bg-white/8";
  return (
    <button type="submit" name="intent" value={intent} className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 [&_svg]:size-4 ${toneClass}`}>
      {icon}{children}
    </button>
  );
}
