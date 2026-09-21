import "server-only";

import { demoOpportunities, demoPipelineHealth } from "@/lib/demo-data";
import type { Opportunity, PipelineHealth } from "@/lib/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function mapRecord(record: Record<string, unknown>): Opportunity {
  return {
    id: String(record.id),
    slug: String(record.slug),
    title: String(record.title),
    organizer: String(record.organizer),
    category: record.category as Opportunity["category"],
    status: record.status as Opportunity["status"],
    aiPolicy: record.ai_policy as Opportunity["aiPolicy"],
    deadline: (record.deadline as string | null) ?? null,
    opensAt: (record.opens_at as string | null) ?? null,
    prizeAmount: (record.prize_amount as number | null) ?? null,
    prizeCurrency: (record.prize_currency as Opportunity["prizeCurrency"]) ?? null,
    entryFeeAmount: (record.entry_fee_amount as number | null) ?? null,
    entryFeeCurrency:
      (record.entry_fee_currency as Opportunity["entryFeeCurrency"]) ?? null,
    location: String(record.location ?? "Online"),
    remote: Boolean(record.remote),
    maxRuntimeMinutes: (record.max_runtime_minutes as number | null) ?? null,
    sourceUrl: String(record.source_url),
    officialUrl: (record.official_url as string | null) ?? null,
    sourceType: record.source_type as Opportunity["sourceType"],
    confidence: Number(record.confidence ?? 0),
    summary: String(record.summary ?? ""),
    eligibility: (record.eligibility as string[]) ?? [],
    formats: (record.formats as string[]) ?? [],
    tags: (record.tags as string[]) ?? [],
    discoveredAt: String(record.discovered_at),
    verifiedAt: (record.verified_at as string | null) ?? null,
    featured: Boolean(record.featured),
  };
}

async function supabaseRequest(
  path: string,
  key: string | undefined,
  init?: RequestInit,
) {
  if (!SUPABASE_URL || !key) {
    throw new Error("Supabase is not configured");
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    next: { revalidate: 300 },
  });
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }
  return response;
}

export async function getOpportunities(): Promise<{
  opportunities: Opportunity[];
  demoMode: boolean;
}> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { opportunities: demoOpportunities, demoMode: true };
  }
  try {
    const response = await supabaseRequest(
      "opportunities?select=*&status=in.(verified,open,closing-soon)&order=featured.desc,deadline.asc.nullslast&limit=250",
      SUPABASE_ANON_KEY,
    );
    const records = (await response.json()) as Record<string, unknown>[];
    if (records.length === 0) {
      return { opportunities: demoOpportunities, demoMode: true };
    }
    return { opportunities: records.map(mapRecord), demoMode: false };
  } catch (error) {
    console.error("Falling back to demo opportunities", error);
    return { opportunities: demoOpportunities, demoMode: true };
  }
}

export async function getPipelineHealth(): Promise<PipelineHealth> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return demoPipelineHealth;
  try {
    const [runsResponse, sourceResponse, openResponse, leadResponse] =
      await Promise.all([
        supabaseRequest(
          "pipeline_runs?select=kind,finished_at,status&order=finished_at.desc&limit=10",
          SUPABASE_SERVICE_ROLE_KEY,
        ),
        supabaseRequest("sources?select=id&enabled=eq.true", SUPABASE_SERVICE_ROLE_KEY),
        supabaseRequest(
          "opportunities?select=id&status=in.(open,closing-soon)",
          SUPABASE_SERVICE_ROLE_KEY,
        ),
        supabaseRequest(
          "opportunities?select=id&status=in.(signal,discovered)",
          SUPABASE_SERVICE_ROLE_KEY,
        ),
      ]);
    const runs = (await runsResponse.json()) as Array<{
      kind: string;
      finished_at: string;
    }>;
    const lastDiscovery = runs.find((run) => run.kind === "discovery");
    const lastMonitor = runs.find((run) => run.kind === "monitor");
    return {
      lastDiscoveryAt: lastDiscovery?.finished_at ?? null,
      lastMonitorAt: lastMonitor?.finished_at ?? null,
      sourcesTracked: ((await sourceResponse.json()) as unknown[]).length,
      recordsOpen: ((await openResponse.json()) as unknown[]).length,
      leadsPending: ((await leadResponse.json()) as unknown[]).length,
      demoMode: false,
    };
  } catch (error) {
    console.error("Falling back to demo pipeline health", error);
    return demoPipelineHealth;
  }
}

export async function upsertOpportunities(records: Record<string, unknown>[]) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase service credentials are not configured");
  }
  const response = await supabaseRequest(
    "opportunities?on_conflict=source_url",
    SUPABASE_SERVICE_ROLE_KEY,
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(records),
    },
  );
  return (await response.json()) as Record<string, unknown>[];
}
