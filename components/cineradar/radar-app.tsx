"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  CalendarDays,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Film,
  Globe2,
  ListFilter,
  MapPin,
  Menu,
  Radar,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  Opportunity,
  OpportunityCategory,
  OpportunityStatus,
  PipelineHealth,
} from "@/lib/types";

type RadarAppProps = {
  initialOpportunities: Opportunity[];
  health: PipelineHealth;
  user: { displayName: string; email: string } | null;
};

type SortMode = "urgent" | "newest" | "prize";
type ViewMode = "all" | "verified" | "signals" | "saved";

const statusLabel: Record<OpportunityStatus, string> = {
  signal: "Signal",
  discovered: "Discovered",
  verified: "Verified",
  open: "Open",
  "closing-soon": "Closing soon",
  closed: "Closed",
};

const statusClass: Record<OpportunityStatus, string> = {
  signal: "border-violet-400/30 bg-violet-400/10 text-violet-200",
  discovered: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  verified: "border-cyan-400/30 bg-cyan-400/10 text-cyan-100",
  open: "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
  "closing-soon": "border-amber-400/40 bg-amber-400/10 text-amber-100",
  closed: "border-slate-500/30 bg-slate-500/10 text-slate-300",
};

const categories: OpportunityCategory[] = [
  "AI film festival",
  "Traditional festival",
  "Platform challenge",
  "Grant",
  "Residency",
  "Advertising competition",
];

function formatMoney(amount: number | null, currency: string | null) {
  if (amount === null || !currency) return "Not stated";
  if (amount === 0) return "Free entry";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function daysUntil(deadline: string | null) {
  if (!deadline) return null;
  return Math.ceil((new Date(deadline).getTime() - Date.now()) / 86_400_000);
}

function formatDeadline(deadline: string | null) {
  if (!deadline) return "Date not announced";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(deadline));
}

function freshnessLabel(iso: string | null) {
  if (!iso) return "awaiting first run";
  const hours = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000),
  );
  if (hours < 1) return "less than 1h ago";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function RadarApp({ initialOpportunities, health, user }: RadarAppProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [aiPolicy, setAiPolicy] = useState("all");
  const [sort, setSort] = useState<SortMode>("urgent");
  const [view, setView] = useState<ViewMode>("all");
  const [selected, setSelected] = useState<Opportunity | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [mobileFilters, setMobileFilters] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("cineradar:saved");
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as string[];
        queueMicrotask(() => setSaved(parsed));
      } catch {
        window.localStorage.removeItem("cineradar:saved");
      }
    }
  }, []);

  function toggleSaved(id: string) {
    setSaved((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      window.localStorage.setItem("cineradar:saved", JSON.stringify(next));
      return next;
    });
  }

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return initialOpportunities
      .filter((item) => {
        const text = [
          item.title,
          item.organizer,
          item.category,
          item.summary,
          item.location,
          ...item.tags,
        ]
          .join(" ")
          .toLowerCase();
        if (normalized && !text.includes(normalized)) return false;
        if (category !== "all" && item.category !== category) return false;
        if (aiPolicy !== "all" && item.aiPolicy !== aiPolicy) return false;
        if (view === "verified" && !item.verifiedAt) return false;
        if (view === "signals" && !["signal", "discovered"].includes(item.status))
          return false;
        if (view === "saved" && !saved.includes(item.id)) return false;
        return true;
      })
      .sort((a, b) => {
        if (sort === "newest") {
          return +new Date(b.discoveredAt) - +new Date(a.discoveredAt);
        }
        if (sort === "prize") {
          return (b.prizeAmount ?? 0) - (a.prizeAmount ?? 0);
        }
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return +new Date(a.deadline) - +new Date(b.deadline);
      });
  }, [aiPolicy, category, initialOpportunities, query, saved, sort, view]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const safeRegister = async () => {
      await context.registerTool(
        {
          name: "search_opportunities",
          title: "Search CineRadar",
          description:
            "Filter the visible CineRadar opportunities by a search phrase.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: false },
          execute(input: unknown) {
            const value =
              typeof input === "object" && input && "query" in input
                ? String((input as { query: unknown }).query)
                : "";
            setQuery(value);
            return { query: value, status: "applied" };
          },
        },
        { signal: lifecycle.signal },
      );
      await context.registerTool(
        {
          name: "save_opportunity",
          title: "Save opportunity",
          description:
            "Save one visible CineRadar opportunity to the current device.",
          inputSchema: {
            type: "object",
            properties: { opportunityId: { type: "string" } },
            required: ["opportunityId"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input: unknown) {
            const id =
              typeof input === "object" && input && "opportunityId" in input
                ? String((input as { opportunityId: unknown }).opportunityId)
                : "";
            const exists = initialOpportunities.some((item) => item.id === id);
            if (!exists) throw new Error("Opportunity not found");
            setSaved((current) => {
              if (current.includes(id)) return current;
              const next = [...current, id];
              window.localStorage.setItem(
                "cineradar:saved",
                JSON.stringify(next),
              );
              return next;
            });
            return { opportunityId: id, saved: true };
          },
        },
        { signal: lifecycle.signal },
      );
    };
    void safeRegister().catch(console.error);
    return () => lifecycle.abort();
  }, [initialOpportunities]);

  const clearFilters = () => {
    setQuery("");
    setCategory("all");
    setAiPolicy("all");
    setView("all");
  };

  const activeFilters =
    Number(category !== "all") + Number(aiPolicy !== "all") + Number(query !== "");

  return (
    <div className="min-h-screen bg-[#071018] text-slate-100">
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#071018]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-[1480px] items-center gap-5 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="group flex shrink-0 items-center gap-3">
            <span className="relative grid size-9 place-items-center rounded-full border border-cyan-300/30 bg-cyan-300/8 text-cyan-200">
              <Radar className="size-5 transition-transform duration-500 group-hover:rotate-90" />
              <span className="absolute right-[5px] top-[7px] size-1.5 rounded-full bg-amber-300 shadow-[0_0_12px_#fcd34d]" />
            </span>
            <span className="text-lg font-semibold tracking-[-0.03em]">
              Cine<span className="text-cyan-300">Radar</span>
            </span>
          </Link>

          <nav className="ml-4 hidden items-center gap-1 text-sm text-slate-400 md:flex">
            <a className="rounded-lg bg-white/6 px-3 py-2 text-white" href="#radar">Radar</a>
            <a className="rounded-lg px-3 py-2 transition hover:bg-white/5 hover:text-white" href="#calendar">Calendar</a>
            <a className="rounded-lg px-3 py-2 transition hover:bg-white/5 hover:text-white" href="#signals">Signals</a>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-2 text-xs text-slate-400 sm:flex">
              <span className="size-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_#6ee7b7]" />
              Updated {freshnessLabel(health.lastDiscoveryAt)}
            </span>
            <Button variant="ghost" size="icon" className="text-slate-300 md:hidden" aria-label="Open filters" onClick={() => setMobileFilters(true)}><Menu /></Button>
            <Button asChild variant="outline" className="border-white/12 bg-white/4 text-slate-100 hover:bg-white/8 hover:text-white">
              <Link href="/team">{user ? "Team room" : "Team sign in"}</Link>
            </Button>
          </div>
        </div>
      </header>

      {health.demoMode && (
        <div className="border-b border-amber-300/15 bg-amber-300/7 px-4 py-2 text-center text-sm text-amber-100">
          Demo records are active. Connect Supabase and the discovery workflow to publish live opportunities.
        </div>
      )}

      <main id="radar" className="mx-auto max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_310px]">
          <div className="relative overflow-hidden rounded-[28px] border border-white/9 bg-[linear-gradient(140deg,rgba(14,116,144,.16),rgba(8,18,27,.78)_55%,rgba(245,158,11,.07))] p-6 sm:p-8">
            <div className="radar-grid pointer-events-none absolute inset-0 opacity-35" />
            <div className="relative z-10 max-w-3xl">
              <div className="mb-5 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-cyan-200/80"><span className="h-px w-8 bg-cyan-300/50" />Opportunity intelligence for filmmakers</div>
              <h1 className="max-w-2xl text-3xl font-semibold leading-[1.04] tracking-[-0.045em] text-white sm:text-5xl">Find the calls worth making a film for.</h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">Festivals, AI video contests, grants and residencies — surfaced early, checked against official sources and ranked by usefulness.</p>
              <div className="relative mt-7 max-w-2xl">
                <Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-500" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by opportunity, organizer, format or country" className="h-13 rounded-2xl border-white/12 bg-[#08131e]/90 pl-12 pr-12 text-base text-white shadow-[0_20px_60px_rgba(0,0,0,.2)] placeholder:text-slate-500 focus-visible:border-cyan-300/50 focus-visible:ring-cyan-300/15" aria-label="Search opportunities" />
                {query && <button type="button" onClick={() => setQuery("")} className="absolute right-4 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-white" aria-label="Clear search"><X className="size-4" /></button>}
              </div>
            </div>
          </div>

          <aside className="grid grid-cols-2 gap-3 xl:grid-cols-1">
            <MetricCard icon={<Sparkles />} label="Open now" value={String(health.recordsOpen)} detail="verified opportunities" />
            <MetricCard icon={<Globe2 />} label="Watching" value={String(health.sourcesTracked)} detail="official sources" />
            <MetricCard icon={<Radar />} label="Early signals" value={String(health.leadsPending)} detail="awaiting verification" className="col-span-2 xl:col-span-1" />
          </aside>
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[245px_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <div className="sticky top-24 rounded-2xl border border-white/8 bg-white/[0.025] p-4">
              <div className="mb-4 flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-medium text-white"><ListFilter className="size-4 text-cyan-300" /> Filters</span>
                {activeFilters > 0 && <button onClick={clearFilters} className="text-xs text-cyan-300 hover:text-cyan-200">Reset</button>}
              </div>
              <FilterControls category={category} setCategory={setCategory} aiPolicy={aiPolicy} setAiPolicy={setAiPolicy} />
              <div className="mt-6 border-t border-white/8 pt-5">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Verification ladder</p>
                <div className="mt-4 space-y-3">
                  {["Signal", "Discovered", "Verified", "Open"].map((label, index) => (
                    <div key={label} className="flex items-center gap-3 text-sm text-slate-400"><span className={`grid size-6 place-items-center rounded-full border text-[11px] ${index < 3 ? "border-cyan-300/30 bg-cyan-300/8 text-cyan-200" : "border-emerald-300/30 bg-emerald-300/8 text-emerald-200"}`}>{index + 1}</span>{label}</div>
                  ))}
                </div>
              </div>
            </div>
          </aside>

          <div className="min-w-0">
            <div className="mb-4 flex flex-col gap-3 border-b border-white/8 pb-4 sm:flex-row sm:items-center sm:justify-between">
              <Tabs value={view} onValueChange={(value) => setView(value as ViewMode)}>
                <TabsList variant="line" className="scrollbar-none max-w-full justify-start overflow-x-auto text-slate-400">
                  <TabsTrigger value="all">All</TabsTrigger><TabsTrigger value="verified">Verified</TabsTrigger><TabsTrigger value="signals">Early signals</TabsTrigger><TabsTrigger value="saved">Saved {saved.length ? `(${saved.length})` : ""}</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-slate-500" aria-live="polite">{filtered.length} result{filtered.length === 1 ? "" : "s"}</span>
                <Select value={sort} onValueChange={(value) => setSort(value as SortMode)}>
                  <SelectTrigger className="min-w-[150px] border-white/10 bg-white/4 text-slate-200"><SelectValue>{sort === "urgent" ? "Deadline first" : sort === "newest" ? "Newest found" : "Highest prize"}</SelectValue></SelectTrigger>
                  <SelectContent className="border-white/10 bg-[#101b25] text-slate-100"><SelectItem value="urgent">Deadline first</SelectItem><SelectItem value="newest">Newest found</SelectItem><SelectItem value="prize">Highest prize</SelectItem></SelectContent>
                </Select>
              </div>
            </div>

            {filtered.length ? (
              <div className="grid gap-4 xl:grid-cols-2">
                {filtered.map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} saved={saved.includes(opportunity.id)} onSave={() => toggleSaved(opportunity.id)} onOpen={() => setSelected(opportunity)} />)}
              </div>
            ) : (
              <div className="grid min-h-[340px] place-items-center rounded-2xl border border-dashed border-white/12 bg-white/[0.02] px-6 text-center"><div><Radar className="mx-auto size-10 text-slate-600" /><h2 className="mt-4 text-lg font-medium text-white">No opportunities on this bearing</h2><p className="mt-2 text-sm text-slate-400">Remove a filter or try a broader search.</p><Button onClick={clearFilters} variant="outline" className="mt-5 border-white/12 bg-white/4 text-white hover:bg-white/8">Clear filters</Button></div></div>
            )}
          </div>
        </section>
      </main>

      <footer className="mt-10 border-t border-white/8 px-4 py-7 text-sm text-slate-500"><div className="mx-auto flex max-w-[1480px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><p>CineRadar · every lead points back to a source.</p><p>Discovery {freshnessLabel(health.lastDiscoveryAt)} · monitoring {freshnessLabel(health.lastMonitorAt)}</p></div></footer>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full border-white/10 bg-[#09141e] text-slate-100 sm:max-w-xl">
          {selected && <><SheetHeader className="border-b border-white/8 p-6 pr-14"><div className="mb-3 flex flex-wrap gap-2"><Badge variant="outline" className={statusClass[selected.status]}>{statusLabel[selected.status]}</Badge><Badge variant="outline" className="border-white/10 bg-white/4 text-slate-300">{selected.category}</Badge></div><SheetTitle className="text-2xl leading-tight tracking-[-0.03em] text-white">{selected.title}</SheetTitle><SheetDescription className="text-slate-400">{selected.organizer}</SheetDescription></SheetHeader><div className="flex-1 overflow-y-auto px-6 py-5"><p className="text-base leading-7 text-slate-300">{selected.summary}</p><div className="mt-6 grid grid-cols-2 gap-3"><DetailStat icon={<CalendarDays />} label="Deadline" value={formatDeadline(selected.deadline)} /><DetailStat icon={<CircleDollarSign />} label="Prize" value={formatMoney(selected.prizeAmount, selected.prizeCurrency)} /><DetailStat icon={<Film />} label="Max runtime" value={selected.maxRuntimeMinutes ? `${selected.maxRuntimeMinutes} min` : "Not stated"} /><DetailStat icon={<MapPin />} label="Location" value={selected.location} /></div><DetailSection title="Eligibility" items={selected.eligibility} /><DetailSection title="Accepted formats" items={selected.formats} /><div className="mt-6 rounded-xl border border-white/8 bg-white/[0.025] p-4"><div className="flex items-center justify-between gap-4"><div><p className="text-sm font-medium text-white">Source confidence</p><p className="mt-1 text-sm text-slate-400">Based on source authority and extracted fields.</p></div><span className="text-lg font-semibold text-cyan-200">{Math.round(selected.confidence * 100)}%</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-cyan-300" style={{ width: `${selected.confidence * 100}%` }} /></div></div></div><SheetFooter className="border-t border-white/8 p-5 sm:flex-row"><Button variant="outline" className="border-white/12 bg-white/4 text-white hover:bg-white/8" onClick={() => toggleSaved(selected.id)}>{saved.includes(selected.id) ? <BookmarkCheck /> : <Bookmark />}{saved.includes(selected.id) ? "Saved" : "Save"}</Button><Button asChild className="bg-cyan-300 text-[#061018] hover:bg-cyan-200"><a href={selected.officialUrl ?? selected.sourceUrl} target="_blank" rel="noreferrer">Open source <ArrowUpRight /></a></Button></SheetFooter></>}
        </SheetContent>
      </Sheet>

      <Sheet open={mobileFilters} onOpenChange={setMobileFilters}><SheetContent side="left" className="border-white/10 bg-[#09141e] text-slate-100"><SheetHeader><SheetTitle className="text-white">Filters</SheetTitle><SheetDescription className="text-slate-400">Narrow the radar to the calls that fit.</SheetDescription></SheetHeader><div className="px-4"><FilterControls category={category} setCategory={setCategory} aiPolicy={aiPolicy} setAiPolicy={setAiPolicy} /><Button onClick={() => setMobileFilters(false)} className="mt-6 w-full bg-cyan-300 text-[#061018] hover:bg-cyan-200">Show {filtered.length} results</Button></div></SheetContent></Sheet>
    </div>
  );
}

function MetricCard({ icon, label, value, detail, className = "" }: { icon: React.ReactNode; label: string; value: string; detail: string; className?: string }) {
  return <div className={`rounded-2xl border border-white/8 bg-white/[0.028] p-4 sm:p-5 ${className}`}><div className="flex items-start justify-between"><span className="grid size-9 place-items-center rounded-xl bg-cyan-300/8 text-cyan-200 [&_svg]:size-4">{icon}</span><span className="text-2xl font-semibold tracking-[-0.04em] text-white">{value}</span></div><p className="mt-4 text-sm font-medium text-white">{label}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>;
}

function FilterControls({ category, setCategory, aiPolicy, setAiPolicy }: { category: string; setCategory: (value: string) => void; aiPolicy: string; setAiPolicy: (value: string) => void }) {
  return <div className="space-y-4"><label className="block text-sm text-slate-400"><span className="mb-2 block">Opportunity type</span><Select value={category} onValueChange={setCategory}><SelectTrigger className="w-full border-white/10 bg-white/4 text-slate-200"><SelectValue>{category === "all" ? "All types" : category}</SelectValue></SelectTrigger><SelectContent className="border-white/10 bg-[#101b25] text-slate-100"><SelectItem value="all">All types</SelectItem>{categories.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></label><label className="block text-sm text-slate-400"><span className="mb-2 block">AI policy</span><Select value={aiPolicy} onValueChange={setAiPolicy}><SelectTrigger className="w-full border-white/10 bg-white/4 text-slate-200"><SelectValue>{aiPolicy === "all" ? "Any policy" : aiPolicy === "required" ? "AI required" : aiPolicy === "allowed" ? "AI allowed" : aiPolicy === "restricted" ? "Restricted" : "Unclear"}</SelectValue></SelectTrigger><SelectContent className="border-white/10 bg-[#101b25] text-slate-100"><SelectItem value="all">Any policy</SelectItem><SelectItem value="required">AI required</SelectItem><SelectItem value="allowed">AI allowed</SelectItem><SelectItem value="restricted">Restricted</SelectItem><SelectItem value="unclear">Unclear</SelectItem></SelectContent></Select></label></div>;
}

function OpportunityCard({ opportunity, saved, onSave, onOpen }: { opportunity: Opportunity; saved: boolean; onSave: () => void; onOpen: () => void }) {
  const days = daysUntil(opportunity.deadline);
  return <article className="group relative flex min-h-[310px] flex-col overflow-hidden rounded-2xl border border-white/8 bg-[linear-gradient(155deg,rgba(255,255,255,.045),rgba(255,255,255,.018))] p-5 transition duration-300 hover:-translate-y-0.5 hover:border-cyan-300/22 hover:shadow-[0_24px_80px_rgba(0,0,0,.22)] sm:p-6"><div className="flex items-start justify-between gap-4"><div className="flex flex-wrap gap-2"><Badge variant="outline" className={statusClass[opportunity.status]}>{statusLabel[opportunity.status]}</Badge>{opportunity.verifiedAt && <Badge variant="outline" className="border-white/10 bg-white/4 text-slate-300"><ShieldCheck className="mr-1 size-3" /> Official source</Badge>}</div><button type="button" onClick={onSave} className="rounded-lg p-2 text-slate-500 transition hover:bg-white/6 hover:text-cyan-200" aria-label={saved ? "Remove from saved" : "Save opportunity"}>{saved ? <BookmarkCheck className="size-5 text-cyan-300" /> : <Bookmark className="size-5" />}</button></div><button type="button" onClick={onOpen} className="mt-5 text-left"><p className="text-xs font-medium uppercase tracking-[0.13em] text-cyan-300/70">{opportunity.category}</p><h2 className="mt-2 text-xl font-semibold leading-tight tracking-[-0.025em] text-white transition group-hover:text-cyan-100">{opportunity.title}</h2><p className="mt-1 text-sm text-slate-500">{opportunity.organizer}</p><p className="mt-4 line-clamp-3 text-sm leading-6 text-slate-300">{opportunity.summary}</p></button><div className="mt-auto pt-6"><div className="grid grid-cols-2 gap-3 border-t border-white/8 pt-4 text-sm"><div><p className="flex items-center gap-1.5 text-xs text-slate-500"><Clock3 className="size-3.5" /> Deadline</p><p className="mt-1 font-medium text-slate-200">{days === null ? "To be announced" : days < 0 ? "Closed" : days === 0 ? "Today" : `${days} days`}</p></div><div><p className="flex items-center gap-1.5 text-xs text-slate-500"><CircleDollarSign className="size-3.5" /> Prize</p><p className="mt-1 font-medium text-slate-200">{formatMoney(opportunity.prizeAmount, opportunity.prizeCurrency)}</p></div></div><button type="button" onClick={onOpen} className="mt-5 flex w-full items-center justify-between rounded-xl bg-white/[0.045] px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-cyan-300/10 hover:text-cyan-100">Review opportunity <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" /></button></div></article>;
}

function DetailStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-xl border border-white/8 bg-white/[0.025] p-3"><p className="flex items-center gap-1.5 text-xs text-slate-500 [&_svg]:size-3.5">{icon}{label}</p><p className="mt-2 text-sm font-medium leading-5 text-slate-200">{value}</p></div>;
}

function DetailSection({ title, items }: { title: string; items: string[] }) {
  return <section className="mt-6"><h3 className="text-sm font-medium text-white">{title}</h3><div className="mt-3 flex flex-wrap gap-2">{items.map((item) => <span key={item} className="rounded-full border border-white/9 bg-white/[0.035] px-3 py-1.5 text-sm text-slate-300">{item}</span>)}</div></section>;
}

declare global {
  interface Document {
    modelContext?: {
      registerTool: (
        tool: {
          name: string;
          title?: string;
          description: string;
          inputSchema: object;
          annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
          execute: (input: unknown) => unknown | Promise<unknown>;
        },
        options?: { signal?: AbortSignal },
      ) => void | Promise<void>;
    };
  }
}
