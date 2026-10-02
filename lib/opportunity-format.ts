import type { AiPolicy, DeadlineStatus } from "@/lib/types";

const DAY = 86_400_000;

export function formatMoney(
  amount: number | null,
  currency: string | null,
  { free = "Free entry" }: { free?: string } = {},
) {
  if (amount === 0) return free;
  if (amount === null || !currency) return "Not stated";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatDeadline(deadline: string | null, status?: DeadlineStatus) {
  if (status === "rolling") return "Rolling deadline";
  if (!deadline) return "Date not announced";
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return "Date not announced";
  const formatted = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  return status === "estimated" ? `About ${formatted}` : formatted;
}

export type CountdownTone = "rolling" | "unknown" | "closed" | "urgent" | "soon" | "open";

const TONE_CLASS: Record<CountdownTone, string> = {
  rolling: "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
  unknown: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  closed: "border-slate-500/30 bg-slate-500/10 text-slate-400",
  urgent: "border-rose-400/40 bg-rose-400/12 text-rose-100",
  soon: "border-amber-400/40 bg-amber-400/10 text-amber-100",
  open: "border-cyan-400/30 bg-cyan-400/10 text-cyan-100",
};

/** Days left and an urgency tone, computed from the recorded deadline only. */
export function deadlineCountdown(deadline: string | null, status?: DeadlineStatus, now = Date.now()) {
  if (status === "rolling") {
    return { tone: "rolling" as const, label: "Rolling", detail: "Applications accepted on a rolling basis", days: null, badgeClass: TONE_CLASS.rolling };
  }
  const time = deadline ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(time)) {
    return { tone: "unknown" as const, label: "Deadline TBA", detail: null, days: null, badgeClass: TONE_CLASS.unknown };
  }
  const days = Math.ceil((time - now) / DAY);
  const approx = status === "estimated" ? "about " : "";
  if (time < now) return { tone: "closed" as const, label: "Deadline passed", detail: null, days, badgeClass: TONE_CLASS.closed };
  const label = days <= 0 ? "Closes today" : days === 1 ? "1 day left" : `${approx}${days} days left`;
  const tone: CountdownTone = days <= 7 ? "urgent" : days <= 14 ? "soon" : "open";
  return { tone, label, detail: label, days, badgeClass: TONE_CLASS[tone] };
}

export function aiPolicyLabel(policy: AiPolicy) {
  switch (policy) {
    case "required": return "AI-made work required";
    case "allowed": return "AI-made work allowed";
    case "restricted": return "AI use restricted";
    default: return "Not stated";
  }
}

// Submission platforms a call can point to. A call published without a date
// (its organizer says submissions are open and links to one of these, where
// the deadline is kept) carries the tag "via-<slug>".
const SUBMISSION_PLATFORMS = [
  { slug: "filmfreeway", name: "FilmFreeway", host: "filmfreeway.com" },
  { slug: "festhome", name: "Festhome", host: "festhome.com" },
  { slug: "shortfilmdepot", name: "ShortFilmDepot", host: "shortfilmdepot.com" },
  { slug: "movibeta", name: "Movibeta", host: "movibeta.com" },
  { slug: "click-for-festivals", name: "Click for Festivals", host: "clickforfestivals.com" },
  { slug: "filmfestplatform", name: "FilmFestPlatform", host: "filmfestplatform.com" },
  { slug: "submittable", name: "Submittable", host: "submittable.com" },
  { slug: "filmchief", name: "FilmChief", host: "filmchief.com" },
  { slug: "festagent", name: "FestAgent", host: "festagent.com" },
] as const;

type PlatformCall = { deadline: string | null; deadlineStatus?: DeadlineStatus; tags?: string[] };

/** The platform that holds the deadline of a call published without a date, or null. */
export function deadlinePlatform({ deadline, deadlineStatus, tags }: PlatformCall) {
  if (deadline || deadlineStatus === "rolling") return null;
  const slug = (tags ?? []).find((tag) => tag.startsWith("via-"))?.slice(4);
  return SUBMISSION_PLATFORMS.find((platform) => platform.slug === slug)?.name ?? null;
}

/** Badge for an open call whose deadline is on its submission platform. */
export function platformCountdown(platform: string) {
  return { tone: "open" as const, label: "Submissions open", detail: `Deadline on ${platform}`, days: null, badgeClass: TONE_CLASS.rolling };
}

/** The submission link on that platform (taken from the organizer's own page), or null. */
export function platformApplyUrl(url: string | null | undefined, platform: string | null) {
  const entry = SUBMISSION_PLATFORMS.find((item) => item.name === platform);
  if (!url || !entry) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const onPlatform = host === entry.host || host.endsWith(`.${entry.host}`);
    return onPlatform && ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}
