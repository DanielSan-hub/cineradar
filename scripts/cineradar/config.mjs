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
};

export const discoveryQueries = [
  "new AI filmmaking competition open submissions cash prize",
  "generative video challenge newly announced filmmakers",
  "AI film festival call for entries open now",
  "short film grant generative media open call",
  "experimental film residency AI moving image applications",
  "creative technology film fellowship open applications",
  "video generation platform creator contest",
  "advertising competition generative AI video category",
  "international short film festival artificial intelligence allowed",
  "artist residency moving image machine learning open call",
  "student AI film competition open submissions",
  "filmmaking grant emerging technology Europe",
  "site:reddit.com AI film contest submissions",
  "site:filmfreeway.com AI film festival",
  "new creator competition video model prize",
  "film lab AI storytelling applications",
  "cinema innovation fund filmmakers open call",
  "AI animation contest international 2026",
  "generative film screening open submission",
  "creative AI residency filmmakers 2026",
  "immersive storytelling grant open call",
  "brand film awards AI category",
  "short film pitch competition technology",
  "new media art festival moving image call",
];
