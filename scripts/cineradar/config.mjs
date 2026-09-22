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

export const config = {
  exaApiKey: process.env.EXA_API_KEY,
  ingestUrl: process.env.CINERADAR_INGEST_URL,
  ingestSecret: process.env.INGEST_SECRET,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
  cloudflareModel:
    process.env.CLOUDFLARE_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast",
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-20b",
  discoveryQueryLimit: Number(process.env.DISCOVERY_QUERY_LIMIT ?? 24),
  discoveryResultLimit: Number(process.env.DISCOVERY_RESULT_LIMIT ?? 8),
  maxLlmCalls: Number(process.env.MAX_LLM_CALLS_PER_RUN ?? 80),
  timeoutMs: Number(process.env.HTTP_TIMEOUT_MS ?? 12000),
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 45000),
  monitorLinkLimit: Number(process.env.MONITOR_LINK_LIMIT ?? 2),
  llmConcurrency: Number(process.env.LLM_CONCURRENCY ?? 2),
  urlValidationConcurrency: Number(process.env.URL_VALIDATION_CONCURRENCY ?? 4),
};

export { discoveryQueries, selectDiscoveryQueries } from "./queries.mjs";
