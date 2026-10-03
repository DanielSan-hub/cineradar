// One ledgered Tavily search (free plan: 1,000 credits a month, no payment
// method; a basic search costs 1 credit). Used only to find candidate URLs,
// such as a festival's own website; pages are then fetched by our own
// robots-aware client, never through Tavily's crawler. Usage is booked at
// EUR 0 with its credits, and the pipeline stops at TAVILY_MONTHLY_CREDIT_CAP
// before Tavily's own limit (HTTP 432) is reached.

import { config } from "./config.mjs";
import { BudgetBlockedError, finalizeProviderUsage, reserveProviderUsage } from "./cost-control.mjs";
import { fetchWithTimeout } from "./http.mjs";
import { supabase } from "./supabase.mjs";

// Refused before any search ran: no credit used.
const NO_CREDIT = new Set([400, 401, 403, 422, 432, 433]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let exhausted = false;
let creditsUsed = null;

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Credits booked this UTC month (reserved, succeeded or uncertain). */
export async function tavilyCreditsThisMonth(now = new Date()) {
  let total = 0;
  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase(`provider_usage_events?select=usage_units,status&provider=eq.tavily&status=in.(reserved,succeeded,uncertain)&occurred_at=gte.${encodeURIComponent(monthStart(now))}&order=id.asc&limit=1000&offset=${offset}`);
    for (const row of rows) total += Number(row.usage_units?.credits ?? row.usage_units?.reserved_credits ?? 0) || 0;
    if (rows.length < 1000) return total;
  }
}

/** Credits a request of this depth costs. */
export function tavilyCredits(depth = "basic") {
  return depth === "advanced" ? 2 : 1;
}

/** True when Tavily can be used now (key present, not exhausted, under the cap). */
export async function tavilyAvailable() {
  if (!config.tavilyApiKey || exhausted) return false;
  if (creditsUsed === null) creditsUsed = await tavilyCreditsThisMonth();
  return creditsUsed + 1 <= config.tavilyMonthlyCreditCap;
}

/**
 * @returns {Promise<{ blocked: true, reason: string } | { blocked: false, results: { url: string, title: string, text: string, score: number }[], credits: number }>}
 */
export async function ledgeredTavilySearch({
  idempotencyKey,
  runId = null,
  operation = "site-resolution",
  text,
  depth = "basic",
  maxResults = 10,
  country = null,
  excludeDomains = [],
  metadata = {},
}) {
  if (!config.tavilyApiKey) return { blocked: true, reason: "TAVILY_KEY_MISSING" };
  if (exhausted) return { blocked: true, reason: "TAVILY_EXHAUSTED" };
  const credits = tavilyCredits(depth);
  if (creditsUsed === null) creditsUsed = await tavilyCreditsThisMonth();
  if (creditsUsed + credits > config.tavilyMonthlyCreditCap) return { blocked: true, reason: "TAVILY_MONTHLY_CAP" };

  let reservation;
  try {
    reservation = await reserveProviderUsage({
      idempotencyKey,
      runId,
      provider: "tavily",
      operation,
      reservedCostEur: 0,
      usageUnits: { credits, search_depth: depth },
      optional: true,
      metadata: { ...metadata, query_text: text, free_plan: true },
    });
  } catch (error) {
    if (error instanceof BudgetBlockedError) return { blocked: true, reason: error.reason };
    throw error;
  }
  creditsUsed += credits;

  const release = (httpStatus, errorCode) => finalizeProviderUsage(reservation.event_id, {
    status: "released",
    usageUnits: { credits: 0, search_depth: depth },
    estimatedCostEur: 0,
    providerCurrency: "USD",
    httpStatus,
    errorCode,
  });

  let response;
  let body = null;
  try {
    for (let attempt = 1; ; attempt += 1) {
      response = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.tavilyApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: text,
          search_depth: depth,
          max_results: maxResults,
          chunks_per_source: 1,
          topic: "general",
          ...(country ? { country } : {}),
          ...(excludeDomains.length ? { exclude_domains: excludeDomains.slice(0, 150) } : {}),
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          include_favicon: false,
          include_usage: true,
        }),
      });
      body = await response.json().catch(() => null);
      if (response.status !== 429 || attempt >= 2) break;
      const wait = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(wait) && wait >= 0 ? Math.min(60_000, wait * 1000) : 60_000);
    }
  } catch (error) {
    // The request may have reached Tavily: keep the credit as uncertain.
    await finalizeProviderUsage(reservation.event_id, {
      status: "uncertain",
      usageUnits: { credits, search_depth: depth },
      estimatedCostEur: 0,
      providerCurrency: "USD",
      errorCode: "TAVILY_REQUEST_UNCERTAIN",
    }).catch(() => {});
    throw error;
  }

  if (!response.ok || !body) {
    if (NO_CREDIT.has(response.status) || response.status === 429) {
      creditsUsed -= credits;
      // Plan limit reached (432/433) or the key refused: stop for this run.
      if ([401, 403, 432, 433].includes(response.status)) exhausted = true;
      await release(response.status, `TAVILY_HTTP_${response.status}`);
      return { blocked: true, reason: `TAVILY_HTTP_${response.status}` };
    }
    await finalizeProviderUsage(reservation.event_id, {
      status: "uncertain",
      usageUnits: { credits, search_depth: depth },
      estimatedCostEur: 0,
      providerCurrency: "USD",
      httpStatus: response.status,
      errorCode: `TAVILY_HTTP_${response.status}`,
    });
    throw new Error(`Tavily ${response.status}`);
  }

  const used = Number(body.usage?.credits);
  const charged = Number.isFinite(used) && used >= 0 ? used : credits;
  creditsUsed += charged - credits;
  await finalizeProviderUsage(reservation.event_id, {
    status: "succeeded",
    usageUnits: { credits: charged, search_depth: depth, results: Array.isArray(body.results) ? body.results.length : 0 },
    estimatedCostEur: 0,
    providerCost: 0,
    providerCurrency: "USD",
    providerRequestId: body.request_id ?? null,
    httpStatus: response.status,
  });
  const results = (Array.isArray(body.results) ? body.results : [])
    .map((result) => ({ url: String(result.url ?? ""), title: String(result.title ?? ""), text: String(result.content ?? ""), score: Number(result.score ?? 0) }))
    .filter((result) => /^https?:\/\//i.test(result.url));
  return { blocked: false, results, credits: charged };
}
