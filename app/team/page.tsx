import type { Metadata } from "next";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  LogOut,
  Radar,
  SearchCheck,
  ShieldAlert,
} from "lucide-react";

import { chatGPTSignOutPath, requireTeamUser } from "@/app/chatgpt-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  parseReviewPage,
  parseReviewView,
  REVIEW_PAGE_SIZE,
} from "@/lib/review-workflow.mjs";
import { TRIAGE_FLAG_LABELS } from "@/lib/review-triage.mjs";
import { getLatestBrief } from "@/lib/server/brief";
import { getPipelineHealth, getReviewQueue } from "@/lib/server/data";
import type { Opportunity, ReviewView } from "@/lib/types";

const VIEW_LABELS: Record<ReviewView, string> = {
  human: "Needs you",
  pending: "All pending (automatic)",
  approved: "Published",
  rejected: "Rejected & archived",
};

function teamHref(view: ReviewView, page = 1) {
  const params = new URLSearchParams();
  if (view !== "human") params.set("view", view);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/team?${query}` : "/team";
}

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export const metadata: Metadata = { title: "Team room" };
export const dynamic = "force-dynamic";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const view = parseReviewView(single(query.view)) as ReviewView;
  const page = parseReviewPage(single(query.page));
  const user = await requireTeamUser(teamHref(view, page));
  const [reviewPage, health, brief] = await Promise.all([
    getReviewQueue({ view, limit: REVIEW_PAGE_SIZE, offset: (page - 1) * REVIEW_PAGE_SIZE }),
    getPipelineHealth(),
    getLatestBrief(),
  ]);
  const briefActions = brief?.items.filter((item) => item.section === "action_now").slice(0, 3) ?? [];
  const queue = reviewPage.opportunities;
  const pageCount = Math.max(1, Math.ceil(reviewPage.total / REVIEW_PAGE_SIZE));

  return (
    <main className="min-h-screen bg-[#071018] text-slate-100">
      <header className="border-b border-white/8 bg-[#071018]/95">
        <div className="mx-auto flex h-[68px] max-w-[1280px] items-center gap-4 px-4 sm:px-6">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Sites needs a full-page navigation from Team to Radar. */}
          <a href="/" className="flex items-center gap-2 text-sm text-slate-400 hover:text-white">
            <ArrowLeft className="size-4" /> Radar
          </a>
          <div className="mx-auto flex items-center gap-2 text-sm font-medium text-white">
            <Radar className="size-4 text-cyan-300" /> Team room
          </div>
          <Button asChild variant="ghost" size="sm" className="text-slate-400 hover:bg-white/5 hover:text-white">
            <a href={chatGPTSignOutPath("/")}><LogOut /> Sign out</a>
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm text-cyan-300">Signed in as {user.displayName}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-white">Verification queue</h1>
            <p className="mt-2 text-slate-400">Turn discovery signals into trustworthy public records.</p>
          </div>
          {reviewPage.demoMode && <Badge variant="outline" className="w-fit border-amber-300/30 bg-amber-300/8 text-amber-100">Demo mode</Badge>}
        </div>

        <section className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TeamMetric icon={<SearchCheck />} label={VIEW_LABELS[view]} value={String(reviewPage.total)} />
          <TeamMetric icon={<Database />} label="Sources tracked" value={String(health.sourcesTracked)} />
          <TeamMetric icon={<CheckCircle2 />} label="Open records" value={String(health.recordsOpen)} />
          <TeamMetric icon={<Clock3 />} label="Last discovery" value={health.lastDiscoveryAt ? new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(health.lastDiscoveryAt)) : "—"} />
        </section>

        {reviewPage.error && (
          <p role="alert" className="mt-6 rounded-xl border border-rose-300/15 bg-rose-300/5 px-4 py-3 text-sm text-rose-200">
            The live verification queue is temporarily unavailable. No demo records were substituted.
          </p>
        )}

        <section className="mt-8 grid gap-5 lg:grid-cols-[minmax(0,1fr)_330px]">
          <div>
            {reviewPage.reviewWorkflow ? (
              <nav aria-label="Review views" className="mb-4 flex flex-wrap gap-2">
                {(Object.keys(VIEW_LABELS) as ReviewView[]).filter((item) => item !== "human" || reviewPage.triage).map((item) => (
                  <a
                    key={item}
                    href={teamHref(item)}
                    aria-current={item === view ? "page" : undefined}
                    className={item === view
                      ? "rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-3 py-1.5 text-sm text-cyan-50"
                      : "rounded-lg border border-white/10 bg-white/4 px-3 py-1.5 text-sm text-slate-400 hover:text-white"}
                  >
                    {VIEW_LABELS[item]}
                  </a>
                ))}
              </nav>
            ) : (
              <p className="mb-4 rounded-xl border border-amber-300/15 bg-amber-300/5 px-4 py-3 text-sm text-amber-100">
                Review actions are disabled until the review workflow migration is applied.
              </p>
            )}
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-medium text-white">{VIEW_LABELS[view]}</h2>
              <span className="text-sm text-slate-500">
                {reviewPage.total
                  ? `${reviewPage.offset + 1}–${reviewPage.offset + queue.length} of ${reviewPage.total}`
                  : "0 records"}
              </span>
            </div>
            <div className="space-y-3">
              {queue.map((item) => (
                <article key={item.id} className="rounded-2xl border border-white/8 bg-white/[0.025] p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline" className={item.status === "signal" ? "border-violet-400/30 bg-violet-400/10 text-violet-200" : "border-sky-400/30 bg-sky-400/10 text-sky-200"}>{item.status}</Badge>
                        <Badge variant="outline" className="border-white/10 bg-white/4 text-slate-400">{Math.round(item.confidence * 100)}% confidence</Badge>
                        {item.reviewDecision === "pending" && typeof item.readinessScore === "number" && (
                          <Badge variant="outline" className="border-cyan-300/30 bg-cyan-300/10 text-cyan-100">Readiness {item.readinessScore}</Badge>
                        )}
                        {item.reviewDecision === "pending" && (item.triageFlags ?? []).map((flag) => TRIAGE_FLAG_LABELS[flag as keyof typeof TRIAGE_FLAG_LABELS] ? (
                          <Badge key={flag} variant="outline" className={flag === "publishable" ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100" : flag === "closing-soon" ? "border-rose-300/30 bg-rose-300/10 text-rose-100" : "border-white/10 bg-white/4 text-slate-400"}>
                            {TRIAGE_FLAG_LABELS[flag as keyof typeof TRIAGE_FLAG_LABELS]}
                          </Badge>
                        ) : null)}
                        {item.reviewDecision && item.reviewDecision !== "pending" && <Badge variant="outline" className="border-white/10 bg-white/4 text-slate-300">{item.reviewDecision}</Badge>}
                        {item.reviewRequired && item.reviewDecision !== "rejected" && item.reviewDecision !== "archived" && <Badge variant="outline" className="border-amber-300/40 bg-amber-300/10 text-amber-100">Human review required</Badge>}
                      </div>
                      <h3 className="mt-3 text-lg font-medium text-white">{item.title}</h3>
                      <p className="mt-1 text-sm text-slate-500">{item.organizer} · {item.sourceType}</p>
                      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{item.summary}</p>
                      {item.hasConflict && <p className="mt-2 text-sm text-amber-200">Source claims conflict. Check the current and previous status/deadline before publication.</p>}
                      {item.reviewReason && <p className="mt-2 text-sm text-slate-500">Note: {item.reviewReason}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                      {reviewPage.reviewWorkflow && !item.demo && (
                        <Button asChild className="bg-cyan-300 text-slate-950 hover:bg-cyan-200">
                          <a href={`/team/review/${item.id}`}>Review <ChevronRight /></a>
                        </Button>
                      )}
                      <ReviewLinks opportunity={item} />
                    </div>
                  </div>
                </article>
              ))}
              {!queue.length && <div className="rounded-2xl border border-dashed border-white/12 p-10 text-center text-slate-400">{view === "human" ? "Nothing needs you: the automatic review settled every record it could evaluate." : view === "pending" ? "The queue is clear." : "No records here yet."}</div>}
            </div>
            {pageCount > 1 && (
              <nav aria-label="Pagination" className="mt-5 flex items-center justify-between text-sm">
                {page > 1 ? (
                  <a href={teamHref(view, page - 1)} className="flex items-center gap-1 text-slate-300 hover:text-white"><ChevronLeft className="size-4" /> Previous</a>
                ) : <span />}
                <span className="text-slate-500">Page {page} of {pageCount}</span>
                {reviewPage.hasMore ? (
                  <a href={teamHref(view, page + 1)} className="flex items-center gap-1 text-slate-300 hover:text-white">Next <ChevronRight className="size-4" /></a>
                ) : <span />}
              </nav>
            )}
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.05] p-5">
              <h2 className="flex items-center gap-2 text-base font-medium text-white"><CalendarClock className="size-4 text-cyan-300" /> This week</h2>
              {brief ? (
                <>
                  <ul className="mt-4 space-y-3 text-sm">
                    {briefActions.map((item) => (
                      <li key={item.position}>
                        <p className="font-medium text-slate-100">{item.title}</p>
                        <p className="mt-0.5 text-slate-400">{item.reason}</p>
                      </li>
                    ))}
                    {!briefActions.length && <li className="text-slate-400">No deadline needs action in the next 30 days.</li>}
                  </ul>
                  <a href="/team/brief" className="mt-4 inline-flex items-center gap-1 text-sm text-cyan-200 hover:text-cyan-100">Full weekly brief <ChevronRight className="size-4" /></a>
                </>
              ) : (
                <p className="mt-3 text-sm text-slate-400">The weekly brief appears here after its first Sunday run.</p>
              )}
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-5">
              <h2 className="flex items-center gap-2 text-base font-medium text-white"><ShieldAlert className="size-4 text-amber-300" /> Publish gate</h2>
              <ol className="mt-4 space-y-4 text-sm text-slate-400">
                {["Official page exists", "Deadline and timezone checked", "AI policy confirmed", "Rights and fee captured"].map((step, index) => <li key={step} className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/4 text-xs text-slate-300">{index + 1}</span><span className="pt-0.5">{step}</span></li>)}
              </ol>
            </div>
            <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.045] p-5 text-sm leading-6 text-cyan-50/80">
              Automated ingestion is intentionally separated from manual verification. A lead reaches the public radar only after its official source and key dates are confirmed.
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

function TeamMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4"><div className="flex items-center justify-between"><span className="text-slate-500 [&_svg]:size-4">{icon}</span><strong className="text-xl font-semibold text-white">{value}</strong></div><p className="mt-4 text-sm text-slate-400">{label}</p></div>;
}

function displayableUrl(url: string | null | undefined, demo?: boolean) {
  if (!url || demo) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.hostname === "example.com" || parsed.hostname.endsWith(".example.com")) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function ReviewLinks({ opportunity }: { opportunity: Opportunity }) {
  const sourceUrl = displayableUrl(opportunity.sourceUrl, opportunity.demo);
  const officialUrl = opportunity.officialUrlVerified
    ? displayableUrl(opportunity.officialUrl, opportunity.demo)
    : null;
  const applicationUrl = opportunity.applicationUrlVerified
    ? displayableUrl(opportunity.applicationUrl, opportunity.demo)
    : null;
  const links = [
    { label: "Source", url: sourceUrl },
    { label: "Official website", url: officialUrl },
    { label: "Application page", url: applicationUrl },
  ].filter((link): link is { label: string; url: string } => Boolean(link.url));

  if (!links.length) {
    return <span className="shrink-0 text-sm text-slate-500">No usable link</span>;
  }
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      {links.map((link) => (
        <Button key={link.label} asChild variant="outline" className="border-white/12 bg-white/4 text-white hover:bg-white/8">
          <a href={link.url} target="_blank" rel="noreferrer">{link.label} <ArrowUpRight /></a>
        </Button>
      ))}
    </div>
  );
}
