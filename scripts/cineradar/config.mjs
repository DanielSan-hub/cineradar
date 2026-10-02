import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const localEnvPath = resolve(scriptDirectory, "..", "..", ".env.local");

if (existsSync(localEnvPath) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(localEnvPath);
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boundedNumber(name, fallback, { min, max, integer = false }) {
  const parsed = Number(process.env[name] ?? fallback);
  const finite = Number.isFinite(parsed) ? parsed : fallback;
  const bounded = Math.min(max, Math.max(min, finite));
  return integer ? Math.trunc(bounded) : bounded;
}

function enabled(name, fallback = false) {
  return /^(?:1|true|yes)$/i.test(
    process.env[name] ?? String(fallback),
  );
}

/**
 * Secrets pasted into a settings page often carry stray formatting: spaces or
 * newlines, quotes, the variable name ("GROQ_API_KEY=...") or "Bearer ".
 */
export function cleanSecret(value) {
  if (typeof value !== "string") return value;
  const cleaned = value.trim()
    .replace(/^[A-Z][A-Z0-9_]*\s*=\s*/, "")
    .replace(/^bearer\s+/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  return cleaned || undefined;
}

export const config = {
  exaApiKey: process.env.EXA_API_KEY,
  ingestUrl: process.env.CINERADAR_INGEST_URL,
  ingestSecret: process.env.INGEST_SECRET,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
  cloudflareModel:
    process.env.CLOUDFLARE_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  groqApiKey: cleanSecret(process.env.GROQ_API_KEY),
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-20b",
  groqFallbackEnabled: enabled("GROQ_FALLBACK_ENABLED"),
  // The Groq account is on the free tier (no billing method): requests over
  // its limits get a 429 and are never charged, so usage is booked at EUR 0.
  // Set GROQ_FREE_TIER=false if a paid Groq plan is ever enabled.
  groqFreeTier: enabled("GROQ_FREE_TIER", true),
  // Exa is a rotating gap/source finder, not the primary discovery engine.
  discoveryQueryLimit: boundedNumber("DISCOVERY_QUERY_LIMIT", 4, { min: 0, max: 24, integer: true }),
  discoveryResultLimit: boundedNumber("DISCOVERY_RESULT_LIMIT", 5, { min: 1, max: 10, integer: true }),
  maxLlmCalls: boundedNumber("MAX_LLM_CALLS_PER_RUN", 24, { min: 0, max: 200, integer: true }),
  // Pages reaching discovery already passed the free call-signal gate.
  freeProcessingLimit: boundedNumber("FREE_PROCESSING_LIMIT", 40, { min: 1, max: 3000, integer: true }),
  timeoutMs: boundedNumber("HTTP_TIMEOUT_MS", 12000, { min: 1000, max: 30000, integer: true }),
  llmTimeoutMs: boundedNumber("LLM_TIMEOUT_MS", 45000, { min: 5000, max: 60000, integer: true }),
  monitorLinkLimit: boundedNumber("MONITOR_LINK_LIMIT", 2, { min: 0, max: 10, integer: true }),
  llmConcurrency: boundedNumber("LLM_CONCURRENCY", 2, { min: 1, max: 4, integer: true }),
  // Series pages are read with rules (HTTP only): more of them run at once.
  seriesConcurrency: boundedNumber("SERIES_CONCURRENCY", 8, { min: 1, max: 24, integer: true }),
  // Series pages not reached within this budget stay queued for the next run.
  seriesTimeBudgetSeconds: boundedNumber("SERIES_TIME_BUDGET_SECONDS", 900, { min: 60, max: 3000, integer: true }),
  pageFetchConcurrency: boundedNumber("PAGE_FETCH_CONCURRENCY", 8, { min: 1, max: 24, integer: true }),
  discoveryLlmTimeBudgetSeconds: boundedNumber("DISCOVERY_LLM_TIME_BUDGET_SECONDS", 900, { min: 60, max: 3600, integer: true }),
  urlValidationConcurrency: boundedNumber("URL_VALIDATION_CONCURRENCY", 4, { min: 1, max: 8, integer: true }),
  sourceRefreshLimit: boundedNumber("SOURCE_REFRESH_LIMIT", 40, { min: 1, max: 6000, integer: true }),
  monitorConcurrency: boundedNumber("MONITOR_CONCURRENCY", 6, { min: 1, max: 32, integer: true }),
  // Stop starting new sources before the job timeout; the rest stay due.
  monitorTimeBudgetSeconds: boundedNumber("MONITOR_TIME_BUDGET_SECONDS", 540, { min: 30, max: 3600, integer: true }),
  revalidationLimit: boundedNumber("REVALIDATION_LIMIT", 200, { min: 1, max: 500, integer: true }),
  staleCheckLimit: boundedNumber("STALE_CHECK_LIMIT", 1000, { min: 1, max: 2000, integer: true }),
  monthlyBudgetEur: boundedNumber("MONTHLY_BUDGET_EUR", 5, { min: 0, max: 5 }),
  monthlyTargetEur: boundedNumber("MONTHLY_TARGET_EUR", 3, { min: 0, max: 3 }),
  optionalStopEur: boundedNumber("OPTIONAL_STOP_EUR", 4, { min: 0, max: 4 }),
  // Exa has its own owner-approved pool (2026-09-28); the database caps it at 9.
  exaMonthlyBudgetEur: boundedNumber("EXA_MONTHLY_BUDGET_EUR", 9, { min: 0, max: 9 }),
  exaMonthlyTargetEur: boundedNumber("EXA_MONTHLY_TARGET_EUR", 7, { min: 0, max: 9 }),
  usdToEurRate: boundedNumber("USD_TO_EUR_RATE", 1, { min: 1, max: 1.5 }),
  cloudflareDailyNeuronLimit: boundedNumber("CLOUDFLARE_DAILY_NEURON_LIMIT", 9000, { min: 0, max: 10000, integer: true }),
  // Workers AI daily allowance at no charge (Free and Paid plans).
  cloudflareFreeDailyNeurons: boundedNumber("CLOUDFLARE_FREE_DAILY_NEURONS", 10000, { min: 0, max: 10000, integer: true }),
  historicalPageLimit: boundedNumber("HISTORICAL_PAGE_LIMIT", 10, { min: 5, max: 20, integer: true }),
};

export {
  discoveryQueries,
  selectAdaptiveDiscoveryQueryDescriptors,
  selectDiscoveryQueries,
  selectDiscoveryQueryDescriptors,
} from "./queries.mjs";
