import "server-only";

import { supabaseRequest } from "@/lib/server/data";

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export type BriefItem = {
  section: string;
  position: number;
  opportunityId: string | null;
  slug: string | null;
  title: string;
  organizer: string | null;
  reason: string;
  action: string | null;
};

export type WeeklyBrief = {
  weekStart: string;
  generatedAt: string;
  status: string;
  stats: Record<string, number>;
  textBody: string;
  items: BriefItem[];
};

/**
 * The most recent weekly brief, or null when none exists yet or the
 * weekly_briefs migration has not been applied (team pages keep working).
 */
export async function getLatestBrief(): Promise<WeeklyBrief | null> {
  if (!SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const response = await supabaseRequest(
      "weekly_briefs?select=id,week_start,generated_at,status,stats,text_body&order=week_start.desc&limit=1",
      SUPABASE_SERVICE_ROLE_KEY,
      { fresh: true },
    );
    const [brief] = (await response.json()) as Array<Record<string, unknown>>;
    if (!brief) return null;
    const itemsResponse = await supabaseRequest(
      `weekly_brief_items?select=section,position,opportunity_id,slug,title,organizer,reason,action&brief_id=eq.${encodeURIComponent(String(brief.id))}&order=position.asc`,
      SUPABASE_SERVICE_ROLE_KEY,
      { fresh: true },
    );
    const items = (await itemsResponse.json()) as Array<Record<string, unknown>>;
    return {
      weekStart: String(brief.week_start),
      generatedAt: String(brief.generated_at),
      status: String(brief.status),
      stats: (brief.stats ?? {}) as Record<string, number>,
      textBody: String(brief.text_body ?? ""),
      items: items.map((item) => ({
        section: String(item.section),
        position: Number(item.position),
        opportunityId: item.opportunity_id ? String(item.opportunity_id) : null,
        slug: item.slug ? String(item.slug) : null,
        title: String(item.title),
        organizer: item.organizer ? String(item.organizer) : null,
        reason: String(item.reason ?? ""),
        action: item.action ? String(item.action) : null,
      })),
    };
  } catch (error) {
    if (!/weekly_brief|PGRST205|42P01/i.test(String(error))) console.error("Unable to load the weekly brief", error);
    return null;
  }
}

export type CoverageSlice = { actionable_series: number; found_pct: number | null; published_pct: number | null; registered_pct: number | null; monitored_pct: number | null };
export type CoverageReport = { measured_at: string; held_out_20pct: CoverageSlice; seeded_80pct: CoverageSlice; all: CoverageSlice };

/**
 * The latest weekly coverage report (owner's datasets as truth), read from
 * the private Supabase bucket with the server key; null when none exists.
 */
export async function getLatestCoverage(): Promise<CoverageReport | null> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!SUPABASE_SERVICE_ROLE_KEY || !base) return null;
  try {
    const response = await fetch(`${base}/storage/v1/object/cineradar-private/evaluation/coverage-latest.json`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as CoverageReport;
  } catch {
    return null;
  }
}
