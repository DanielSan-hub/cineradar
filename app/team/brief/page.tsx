import type { Metadata } from "next";
import { ArrowLeft, ArrowUpRight, CalendarClock, Radar } from "lucide-react";

import { requireTeamUser } from "@/app/chatgpt-auth";
import { Badge } from "@/components/ui/badge";
import { getLatestBrief } from "@/lib/server/brief";
import { BRIEF_SECTION_LABELS, BRIEF_SECTIONS } from "@/lib/weekly-brief.mjs";

export const metadata: Metadata = { title: "Weekly brief" };
export const dynamic = "force-dynamic";

function formatDay(iso: string) {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export default async function BriefPage() {
  await requireTeamUser("/team/brief");
  const brief = await getLatestBrief();
  const sections = (BRIEF_SECTIONS as readonly string[])
    .map((section) => ({ section, items: brief?.items.filter((item) => item.section === section) ?? [] }))
    .filter((entry) => entry.items.length);

  return (
    <main className="min-h-screen bg-[#071018] text-slate-100">
      <header className="border-b border-white/8 bg-[#071018]/95">
        <div className="mx-auto flex h-[68px] max-w-[960px] items-center gap-4 px-4 sm:px-6">
          <a href="/team" className="flex items-center gap-2 text-sm text-slate-400 hover:text-white"><ArrowLeft className="size-4" /> Team room</a>
          <div className="mx-auto flex items-center gap-2 text-sm font-medium text-white"><Radar className="size-4 text-cyan-300" /> Weekly brief</div>
          <span className="w-[90px]" />
        </div>
      </header>

      <div className="mx-auto max-w-[960px] px-4 py-8 sm:px-6">
        {!brief ? (
          <div className="rounded-2xl border border-dashed border-white/12 p-10 text-center text-slate-400">
            No brief yet. It is generated every Sunday from the published records (it needs the weekly_briefs migration).
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm text-cyan-300"><CalendarClock className="size-4" /> Week of {formatDay(brief.weekStart)}</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-white">What needs the team this week</h1>
                <p className="mt-2 text-sm text-slate-400">
                  {brief.stats.public ?? 0} open calls on the radar · {brief.stats.newThisWeek ?? 0} new this week · generated {formatDay(brief.generatedAt)}
                </p>
              </div>
              <Badge variant="outline" className="border-white/10 bg-white/4 text-slate-300">{brief.status}</Badge>
            </div>

            {sections.map(({ section, items }) => (
              <section key={section} className="mt-8">
                <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{BRIEF_SECTION_LABELS[section as keyof typeof BRIEF_SECTION_LABELS]}</h2>
                <ul className="mt-3 space-y-2">
                  {items.map((item) => (
                    <li key={item.position} className="flex flex-col gap-2 rounded-xl border border-white/8 bg-white/[0.025] p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-medium text-white">{item.title}</p>
                        {item.reason ? <p className="mt-1 text-sm text-slate-400">{item.reason}</p> : null}
                        {item.action ? <p className="mt-1 text-sm text-cyan-200/80">{item.action}</p> : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {item.opportunityId ? <a href={`/team/review/${item.opportunityId}`} className="rounded-lg border border-white/10 bg-white/4 px-3 py-1.5 text-sm text-slate-300 hover:text-white">Record</a> : null}
                        {item.slug && section !== "watch" ? <a href={`/o/${item.slug}`} className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/4 px-3 py-1.5 text-sm text-slate-300 hover:text-white">Public page <ArrowUpRight className="size-3.5" /></a> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            <section className="mt-10">
              <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Text to share</h2>
              <p className="mt-2 text-sm text-slate-500">Select all and copy into the team chat or an e-mail.</p>
              <textarea readOnly value={brief.textBody} rows={Math.min(30, brief.textBody.split("\n").length + 1)} className="mt-3 w-full rounded-xl border border-white/10 bg-[#08131e] p-4 font-mono text-sm leading-6 text-slate-200" />
            </section>
          </>
        )}
      </div>
    </main>
  );
}
