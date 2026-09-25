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
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-20b",
  groqFallbackEnabled: enabled("GROQ_FALLBACK_ENABLED"),
  // Exa is a rotating gap/source finder, not the primary discovery engine.
  discoveryQueryLimit: boundedNumber("DISCOVERY_QUERY_LIMIT", 4, { min: 0, max: 24, integer: true }),
  discoveryResultLimit: boundedNumber("DISCOVERY_RESULT_LIMIT", 5, { min: 1, max: 10, integer: true }),
  maxLlmCalls: boundedNumber("MAX_LLM_CALLS_PER_RUN", 24, { min: 0, max: 80, integer: true }),
  freeProcessingLimit: boundedNumber("FREE_PROCESSING_LIMIT", 40, { min: 1, max: 100, integer: true }),
  timeoutMs: boundedNumber("HTTP_TIMEOUT_MS", 12000, { min: 1000, max: 30000, integer: true }),
  llmTimeoutMs: boundedNumber("LLM_TIMEOUT_MS", 45000, { min: 5000, max: 60000, integer: true }),
  monitorLinkLimit: boundedNumber("MONITOR_LINK_LIMIT", 2, { min: 0, max: 5, integer: true }),
  llmConcurrency: boundedNumber("LLM_CONCURRENCY", 2, { min: 1, max: 4, integer: true }),
  urlValidationConcurrency: boundedNumber("URL_VALIDATION_CONCURRENCY", 4, { min: 1, max: 8, integer: true }),
  sourceRefreshLimit: boundedNumber("SOURCE_REFRESH_LIMIT", 40, { min: 1, max: 100, integer: true }),
  revalidationLimit: boundedNumber("REVALIDATION_LIMIT", 200, { min: 1, max: 500, integer: true }),
  staleCheckLimit: boundedNumber("STALE_CHECK_LIMIT", 1000, { min: 1, max: 2000, integer: true }),
  monthlyBudgetEur: boundedNumber("MONTHLY_BUDGET_EUR", 5, { min: 0, max: 5 }),
  monthlyTargetEur: boundedNumber("MONTHLY_TARGET_EUR", 3, { min: 0, max: 3 }),
  optionalStopEur: boundedNumber("OPTIONAL_STOP_EUR", 4, { min: 0, max: 4 }),
  usdToEurRate: boundedNumber("USD_TO_EUR_RATE", 1, { min: 1, max: 1.5 }),
  cloudflareDailyNeuronLimit: boundedNumber("CLOUDFLARE_DAILY_NEURON_LIMIT", 9000, { min: 0, max: 10000, integer: true }),
  historicalPageLimit: boundedNumber("HISTORICAL_PAGE_LIMIT", 10, { min: 5, max: 20, integer: true }),
};

export {
  discoveryQueries,
  selectAdaptiveDiscoveryQueryDescriptors,
  selectDiscoveryQueries,
  selectDiscoveryQueryDescriptors,
} from "./queries.mjs";
