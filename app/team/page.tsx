import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Database,
  LogOut,
  Radar,
  SearchCheck,
  ShieldAlert,
} from "lucide-react";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getPipelineHealth, getReviewQueue } from "@/lib/server/data";
import type { Opportunity } from "@/lib/types";

export const metadata: Metadata = { title: "Team room" };
export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const [user, reviewPage, health] = await Promise.all([
    requireChatGPTUser("/team"),
    getReviewQueue({ limit: 50, offset: 0 }),
    getPipelineHealth(),
  ]);
  const queue = reviewPage.opportunities;

  return (
    <main className="min-h-screen bg-[#071018] text-slate-100">
      <header className="border-b border-white/8 bg-[#071018]/95">
        <div className="mx-auto flex h-[68px] max-w-[1280px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 text-sm text-slate-400 hover:text-white">
            <ArrowLeft className="size-4" /> Radar
          </Link>
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
          <TeamMetric icon={<SearchCheck />} label="Pending review" value={String(reviewPage.total)} />
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
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-medium text-white">Needs verification</h2>
              <span className="text-sm text-slate-500">Showing {queue.length} of {reviewPage.total} records</span>
            </div>
            <div className="space-y-3">
              {queue.map((item) => (
                <article key={item.id} className="rounded-2xl border border-white/8 bg-white/[0.025] p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline" className={item.status === "signal" ? "border-violet-400/30 bg-violet-400/10 text-violet-200" : "border-sky-400/30 bg-sky-400/10 text-sky-200"}>{item.status}</Badge>
                        <Badge variant="outline" className="border-white/10 bg-white/4 text-slate-400">{Math.round(item.confidence * 100)}% confidence</Badge>
                      </div>
                      <h3 className="mt-3 text-lg font-medium text-white">{item.title}</h3>
                      <p className="mt-1 text-sm text-slate-500">{item.organizer} · {item.sourceType}</p>
                      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{item.summary}</p>
                    </div>
                    <ReviewLinks opportunity={item} />
                  </div>
                </article>
              ))}
              {!queue.length && <div className="rounded-2xl border border-dashed border-white/12 p-10 text-center text-slate-400">The queue is clear.</div>}
            </div>
          </div>

          <aside className="space-y-4">
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
