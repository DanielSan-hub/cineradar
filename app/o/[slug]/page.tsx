import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  Film,
  MapPin,
  Quote,
  Radar,
  ShieldCheck,
  Sparkles,
  Ticket,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { deadlineCountdown, deadlinePlatform, formatDeadline, formatMoney, aiPolicyLabel, platformApplyUrl, platformCountdown } from "@/lib/opportunity-format";
import { getPublicOpportunity } from "@/lib/server/data";
import type { Opportunity } from "@/lib/types";

export const dynamic = "force-dynamic";

const SITE_URL = "https://cineradar.danielmaker.chatgpt.site";

type PageProps = { params: Promise<{ slug: string }> };

function describe(opportunity: Opportunity) {
  const parts = [
    opportunity.category,
    opportunity.organizer,
    opportunity.deadline ? `deadline ${formatDeadline(opportunity.deadline, opportunity.deadlineStatus)}` : null,
  ].filter(Boolean);
  return (opportunity.summary || parts.join(" · ")).slice(0, 300);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPublicOpportunity(slug).catch(() => null);
  if (!result) return { title: "Opportunity not found" };
  const { opportunity } = result;
  const url = `${SITE_URL}/o/${opportunity.slug}`;
  return {
    title: opportunity.title,
    description: describe(opportunity),
    alternates: { canonical: url },
    openGraph: { title: opportunity.title, description: describe(opportunity), url, siteName: "CineRadar", type: "article" },
  };
}

function verifiedLink(url: string | null | undefined, verified: boolean | undefined) {
  if (!url || !verified) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export default async function OpportunityPage({ params }: PageProps) {
  const { slug } = await params;
  const result = await getPublicOpportunity(slug).catch(() => null);
  if (!result) notFound();
  const { opportunity, deadlineQuote } = result;
  // An open call whose deadline is kept on its submission platform links
  // there (the link comes from the organizer's own page).
  const platform = deadlinePlatform(opportunity);
  const countdown = platform ? platformCountdown(platform) : deadlineCountdown(opportunity.deadline, opportunity.deadlineStatus);
  const officialUrl = verifiedLink(opportunity.officialUrl, opportunity.officialUrlVerified);
  const applicationUrl = verifiedLink(opportunity.applicationUrl, opportunity.applicationUrlVerified)
    ?? platformApplyUrl(opportunity.applicationUrl, platform);
  const applyLabel = platform && !opportunity.applicationUrlVerified ? `Apply on ${platform}` : "Apply";
  const sourceUrl = verifiedLink(opportunity.sourceUrl, true);
  const lastChecked = formatDate(opportunity.officialUrlLastCheckedAt ?? opportunity.verifiedAt);
  const closed = countdown.tone === "closed";

  // Only facts we hold, so search engines never see an invented date.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: opportunity.title,
    description: describe(opportunity),
    url: `${SITE_URL}/o/${opportunity.slug}`,
    dateModified: opportunity.updatedAt ?? undefined,
    about: {
      "@type": "CreativeWork",
      name: opportunity.title,
      genre: opportunity.category,
      ...(officialUrl ? { url: officialUrl } : {}),
      ...(opportunity.organizer ? { creator: { "@type": "Organization", name: opportunity.organizer } } : {}),
    },
  };

  return (
    <div className="min-h-screen bg-[#071018] text-slate-100">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <header className="border-b border-white/8 bg-[#071018]/92">
        <div className="mx-auto flex h-[68px] max-w-[1080px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-full border border-cyan-300/30 bg-cyan-300/8 text-cyan-200"><Radar className="size-5" /></span>
            <span className="text-lg font-semibold tracking-[-0.03em]">Cine<span className="text-cyan-300">Radar</span></span>
          </Link>
          <Link href="/" className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/5 hover:text-white"><ArrowLeft className="size-4" /> All opportunities</Link>
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] px-4 py-8 sm:px-6 lg:py-12">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="border-white/10 bg-white/4 text-slate-300">{opportunity.category}</Badge>
          <Badge variant="outline" className={countdown.badgeClass}>{countdown.label}</Badge>
          {officialUrl && <Badge variant="outline" className="border-emerald-300/25 bg-emerald-300/8 text-emerald-100"><ShieldCheck className="mr-1 size-3" /> Official page checked</Badge>}
        </div>
        <h1 className="mt-5 max-w-3xl text-3xl font-semibold leading-[1.08] tracking-[-0.04em] text-white sm:text-5xl">{opportunity.title}</h1>
        <p className="mt-3 text-lg text-slate-400">{opportunity.organizer}</p>
        {opportunity.summary && <p className="mt-6 max-w-3xl text-base leading-7 text-slate-300">{opportunity.summary}</p>}

        {closed && (
          <p className="mt-6 rounded-xl border border-amber-300/20 bg-amber-300/6 px-4 py-3 text-sm text-amber-100">
            The recorded deadline has passed. Check the official page for the next edition.
          </p>
        )}

        <div className="mt-8 flex flex-wrap gap-3">
          {applicationUrl && !closed && (
            <a href={applicationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-3 text-sm font-semibold text-[#061018] transition hover:bg-cyan-200">{applyLabel} <ArrowUpRight className="size-4" /></a>
          )}
          {officialUrl && (
            <a href={officialUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/4 px-5 py-3 text-sm font-medium text-white transition hover:bg-white/8">Official page <ArrowUpRight className="size-4" /></a>
          )}
          {sourceUrl && sourceUrl !== officialUrl && (
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/4 px-5 py-3 text-sm font-medium text-white transition hover:bg-white/8">Where we found it <ArrowUpRight className="size-4" /></a>
          )}
        </div>

        <section className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact icon={<CalendarDays />} label="Deadline" value={platform ? `On ${platform}` : formatDeadline(opportunity.deadline, opportunity.deadlineStatus)} detail={countdown.detail} />
          <Fact icon={<Ticket />} label="Entry fee" value={formatMoney(opportunity.entryFeeAmount, opportunity.entryFeeCurrency, { free: "Free entry" })} />
          <Fact icon={<CircleDollarSign />} label="Prize or funding" value={formatMoney(opportunity.prizeAmount, opportunity.prizeCurrency, { free: "None stated" })} />
          <Fact icon={<Sparkles />} label="AI policy" value={aiPolicyLabel(opportunity.aiPolicy)} />
          <Fact icon={<Film />} label="Max runtime" value={opportunity.maxRuntimeMinutes ? `${opportunity.maxRuntimeMinutes} min` : "Not stated"} />
          <Fact icon={<MapPin />} label="Location" value={opportunity.remote ? `${opportunity.location} · online` : opportunity.location} />
          {opportunity.opensAt && <Fact icon={<Clock3 />} label="Opens" value={formatDate(opportunity.opensAt) ?? "Not stated"} />}
        </section>

        {deadlineQuote && (
          <figure className="mt-6 rounded-2xl border border-white/8 bg-white/[0.025] p-5">
            <figcaption className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-500"><Quote className="size-3.5" /> As stated on the page</figcaption>
            <blockquote className="mt-3 text-base leading-7 text-slate-200">“{deadlineQuote}”</blockquote>
          </figure>
        )}

        <ListSection title="Eligibility" items={opportunity.eligibility} />
        <ListSection title="Accepted formats" items={opportunity.formats} />

        <footer className="mt-12 border-t border-white/8 pt-6 text-sm leading-6 text-slate-500">
          {lastChecked ? <p>Official page last checked {lastChecked}.</p> : null}
          <p>Facts come from the organizer&apos;s own pages; anything not stated there is shown as not stated. Always confirm rules and dates on the official page before applying.</p>
        </footer>
      </main>
    </div>
  );
}

function Fact({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string | null }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
      <p className="flex items-center gap-1.5 text-xs text-slate-500 [&_svg]:size-3.5">{icon}{label}</p>
      <p className="mt-2 text-base font-medium text-slate-100">{value}</p>
      {detail ? <p className="mt-1 text-xs text-slate-500">{detail}</p> : null}
    </div>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-white">{title}</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {items.map((item) => <li key={item} className="rounded-full border border-white/9 bg-white/[0.035] px-3 py-1.5 text-sm text-slate-300">{item}</li>)}
      </ul>
    </section>
  );
}
