import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, History, Quote, Radar } from "lucide-react";

import { requireTeamUser } from "@/app/chatgpt-auth";
import { ReviewForm } from "@/components/cineradar/review-form";
import { Badge } from "@/components/ui/badge";
import { EDITABLE_FIELDS, isUuid, timestampInputValue } from "@/lib/review-workflow.mjs";
import { getReviewRecord, type ReviewEvent } from "@/lib/server/review";

export const metadata: Metadata = { title: "Review record" };
export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function formInitialValues(row: JsonRecord) {
  const values: Record<string, string> = {};
  for (const [field, kind] of Object.entries(EDITABLE_FIELDS)) {
    const value = row[field];
    if (kind === "timestamp") values[field] = timestampInputValue(value);
    else if (kind === "list") values[field] = Array.isArray(value) ? value.map(String).join("\n") : "";
    else if (kind === "boolean") values[field] = value ? "true" : "false";
    else values[field] = value === null || value === undefined ? "" : String(value);
  }
  return values;
}

const GATE_FIELDS = [
  "title", "organizer", "status", "source_type", "source_url_status", "official_url",
  "official_url_status", "has_conflict", "deadline", "deadline_status",
] as const;

/** Only what the client-side publication hint needs; raw evidence stays on the server. */
function gateFields(row: JsonRecord) {
  return Object.fromEntries(GATE_FIELDS.map((field) => [field, row[field] ?? null]));
}

function httpUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatDate(value: unknown) {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
}

/** Short quoted evidence captured by the extractor, keyed by what it supports. */
function evidenceQuotes(row: JsonRecord) {
  const payload = asRecord(row.raw_payload);
  const evidence = asRecord(payload.evidence);
  const extraction = asRecord(payload.extraction);
  const fieldEvidence = asRecord(extraction.field_evidence);
  const quotes: Array<{ label: string; text: string }> = [];
  const push = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) quotes.push({ label, text: value.trim().slice(0, 500) });
  };
  push("Deadline", evidence.deadline_quote ?? extraction.deadline_evidence);
  push("Status", extraction.status_evidence);
  for (const [key, value] of Object.entries(fieldEvidence)) push(key.replaceAll("_", " "), value);
  return quotes;
}

export default async function ReviewRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireTeamUser(`/team/review/${isUuid(id) ? id : ""}`);
  if (!isUuid(id)) notFound();
  const record = await getReviewRecord(id);
  if (!record) notFound();

  const { row, opportunity, events, provenance, observations, reviewWorkflow } = record;
  const decision = String(row.review_decision ?? "pending");
  const conflicts = Array.isArray(row.conflict_details) ? row.conflict_details : [];
  const quotes = evidenceQuotes(row);
  const extraction = asRecord(asRecord(row.raw_payload).extraction);
  const links = [
    { label: "Source", url: httpUrl(row.source_url), status: row.source_url_status, http: row.source_url_http_status, checked: row.source_url_last_checked_at },
    { label: "Official", url: httpUrl(row.official_url), status: row.official_url_status, http: row.official_url_http_status, checked: row.official_url_last_checked_at },
    { label: "Application", url: httpUrl(row.application_url), status: row.application_url_status, http: row.application_url_http_status, checked: row.application_url_last_checked_at },
    { label: "Deadline source", url: httpUrl(row.deadline_source_url), status: null, http: null, checked: row.deadline_last_verified_at },
  ];

  return (
    <main className="min-h-screen bg-[#071018] text-slate-100">
      <header className="border-b border-white/8 bg-[#071018]/95">
        <div className="mx-auto flex h-[68px] max-w-[1280px] items-center gap-4 px-4 sm:px-6">
          {/* Full-page navigation inside the Sites auth boundary, like the Team links. */}
          <a href="/team" className="flex items-center gap-2 text-sm text-slate-400 hover:text-white">
            <ArrowLeft className="size-4" /> Queue
          </a>
          <div className="mx-auto flex items-center gap-2 text-sm font-medium text-white">
            <Radar className="size-4 text-cyan-300" /> Review record
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="border-white/10 bg-white/4 text-slate-300">{decision}</Badge>
          <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 text-sky-200">{opportunity.status}</Badge>
          <Badge variant="outline" className="border-white/10 bg-white/4 text-slate-400">{Math.round(opportunity.confidence * 100)}% confidence</Badge>
          {opportunity.hasConflict && <Badge variant="outline" className="border-amber-300/40 bg-amber-300/10 text-amber-100">Conflicting sources</Badge>}
        </div>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-white">{opportunity.title}</h1>
        <p className="mt-1 text-slate-400">{opportunity.organizer} · {opportunity.category} · discovered {formatDate(row.discovered_at)}</p>
        {typeof row.review_reason === "string" && row.review_reason && (
          <p className="mt-3 text-sm text-amber-200">Review note: {row.review_reason}</p>
        )}
        {!reviewWorkflow && (
          <p role="alert" className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-sm text-amber-100">
            Review actions are disabled until the review workflow migration is applied to the database.
          </p>
        )}

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          <ReviewForm
            id={id}
            updatedAt={String(row.updated_at)}
            reviewDecision={decision}
            hasConflict={Boolean(row.has_conflict)}
            savedRow={gateFields(row)}
            initialValues={formInitialValues(row)}
            disabled={!reviewWorkflow}
          />

          <aside className="space-y-4">
            <Panel title="Links">
              <ul className="space-y-3 text-sm">
                {links.map((link) => (
                  <li key={link.label}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-400">{link.label}</span>
                      {link.status ? <UrlStatus status={String(link.status)} http={link.http} /> : null}
                    </div>
                    {link.url ? (
                      <a href={link.url} target="_blank" rel="noreferrer" className="mt-0.5 flex items-start gap-1 break-all text-cyan-200 hover:text-cyan-100">
                        {link.url} <ArrowUpRight className="mt-0.5 size-3.5 shrink-0" />
                      </a>
                    ) : <p className="mt-0.5 text-slate-600">Not recorded</p>}
                    {link.url && <p className="text-xs text-slate-600">Checked {formatDate(link.checked)}</p>}
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Extracted evidence" icon={<Quote className="size-4 text-cyan-300" />}>
              {quotes.length ? (
                <ul className="space-y-3 text-sm">
                  {quotes.map((quote, index) => (
                    <li key={`${quote.label}-${index}`}>
                      <p className="text-xs uppercase tracking-wide text-slate-500">{quote.label}</p>
                      <blockquote className="mt-1 border-l-2 border-white/10 pl-3 text-slate-300">{quote.text}</blockquote>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-slate-500">No quoted evidence was stored. Verify every field on the official page.</p>}
              {typeof extraction.deadline === "string" && (
                <p className="mt-3 text-xs text-slate-500">Extracted deadline text: {extraction.deadline}</p>
              )}
            </Panel>

            {(conflicts.length > 0 || observations.length > 0) && (
              <Panel title="Observations">
                {conflicts.length > 0 && (
                  <pre className="mb-3 max-h-48 overflow-auto rounded-lg bg-black/30 p-3 text-xs text-amber-100">{JSON.stringify(conflicts, null, 2)}</pre>
                )}
                <ul className="space-y-2 text-xs text-slate-400">
                  {observations.map((observation, index) => (
                    <li key={index}>
                      {formatDate(observation.observed_at)} · {String(observation.observed_status ?? "—")} · deadline {formatDate(observation.observed_deadline)} ({String(observation.deadline_status ?? "—")})
                      {observation.is_primary_evidence ? " · primary" : ""}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {provenance.length > 0 && (
              <Panel title="Discovery provenance">
                <ul className="space-y-2 text-xs text-slate-400">
                  {provenance.map((item, index) => (
                    <li key={index} className="break-all">
                      {formatDate(item.observed_at)} · {String(item.provider)}{item.query_text ? ` · “${String(item.query_text)}”` : ""}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            <Panel title="Audit trail" icon={<History className="size-4 text-cyan-300" />}>
              {events.length ? (
                <ol className="space-y-4 text-sm">{events.map((event) => <AuditEvent key={event.id} event={event} />)}</ol>
              ) : <p className="text-sm text-slate-500">No reviewer action recorded yet.</p>}
            </Panel>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Panel({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/8 bg-white/[0.025] p-5">
      <h2 className="mb-4 flex items-center gap-2 text-base font-medium text-white">{icon}{title}</h2>
      {children}
    </section>
  );
}

function UrlStatus({ status, http }: { status: string; http: unknown }) {
  const good = status === "verified" || status === "redirected";
  return (
    <span className={good ? "text-xs text-emerald-300" : "text-xs text-amber-300"}>
      {status}{typeof http === "number" ? ` · ${http}` : ""}
    </span>
  );
}

function AuditEvent({ event }: { event: ReviewEvent }) {
  return (
    <li className="border-l-2 border-white/10 pl-3">
      <p className="text-white">
        <span className="font-medium">{event.action}</span>
        <span className="text-slate-500"> · {event.decisionBefore} → {event.decisionAfter}</span>
      </p>
      <p className="text-xs text-slate-500">{event.reviewer} · {formatDate(event.createdAt)}</p>
      <p className="mt-1 text-slate-300">{event.reason}</p>
      {event.changedFields.length > 0 && (
        <details className="mt-1 text-xs text-slate-400">
          <summary className="cursor-pointer">Changed: {event.changedFields.join(", ")}</summary>
          <ul className="mt-1 space-y-1">
            {event.changedFields.map((fieldName) => (
              <li key={fieldName} className="break-all">
                <span className="text-slate-500">{fieldName}:</span> {JSON.stringify(event.before[fieldName] ?? null)} → {JSON.stringify(event.after[fieldName] ?? null)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
