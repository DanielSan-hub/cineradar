import { config } from "./config.mjs";
import { fetchWithTimeout } from "./http.mjs";

const allowedCategories = [
  "AI film festival", "Traditional festival", "Platform challenge",
  "Grant", "Residency", "Advertising competition",
];

const prompt = `You extract filmmaker opportunities from web pages. Return only one JSON object.
If the page is not a real or plausible festival, contest, grant, residency or creative call for filmmakers, return {"relevant":false}.
Never invent dates, prizes, fees, eligibility or URLs. Use null when unknown.
Required shape:
{"relevant":boolean,"title":string|null,"organizer":string|null,"category":string|null,"status":"signal"|"discovered"|"verified"|"open"|"closing-soon"|"closed","ai_policy":"allowed"|"required"|"restricted"|"unclear","deadline":string|null,"opens_at":string|null,"prize_amount":number|null,"prize_currency":"EUR"|"USD"|"GBP"|null,"entry_fee_amount":number|null,"entry_fee_currency":"EUR"|"USD"|"GBP"|null,"location":string|null,"remote":boolean,"max_runtime_minutes":number|null,"official_url":string|null,"source_type":"official"|"press"|"social"|"community","confidence":number,"summary":string,"eligibility":string[],"formats":string[],"tags":string[]}`;

function parseJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("LLM returned no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalize(raw, sourceUrl) {
  if (!raw?.relevant) return null;
  const category = allowedCategories.includes(raw.category)
    ? raw.category
    : "AI film festival";
  const title = String(raw.title ?? "").trim();
  if (!title) return null;
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return {
    slug: slug || `opportunity-${Date.now()}`,
    title,
    organizer: String(raw.organizer ?? "Unknown organizer"),
    category,
    status: raw.status ?? "discovered",
    ai_policy: raw.ai_policy ?? "unclear",
    deadline: raw.deadline ?? null,
    opens_at: raw.opens_at ?? null,
    prize_amount: raw.prize_amount ?? null,
    prize_currency: raw.prize_currency ?? null,
    entry_fee_amount: raw.entry_fee_amount ?? null,
    entry_fee_currency: raw.entry_fee_currency ?? null,
    location: raw.location ?? "Online",
    remote: Boolean(raw.remote),
    max_runtime_minutes: raw.max_runtime_minutes ?? null,
    source_url: sourceUrl,
    official_url: raw.official_url ?? null,
    source_type: raw.source_type ?? "official",
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0.5))),
    summary: String(raw.summary ?? "").slice(0, 800),
    eligibility: Array.isArray(raw.eligibility) ? raw.eligibility.slice(0, 12) : [],
    formats: Array.isArray(raw.formats) ? raw.formats.slice(0, 12) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 16) : [],
    discovered_at: new Date().toISOString(),
    raw_payload: raw,
  };
}

async function cloudflare(messages) {
  if (!config.cloudflareAccountId || !config.cloudflareApiToken) return null;
  const response = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${config.cloudflareModel}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.cloudflareApiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages, response_format: { type: "json_object" }, max_tokens: 900, temperature: 0 }),
    },
  );
  if (!response.ok) throw new Error(`Cloudflare AI ${response.status}`);
  const body = await response.json();
  return body.result?.response ?? body.result?.choices?.[0]?.message?.content ?? null;
}

async function groq(messages) {
  if (!config.groqApiKey) return null;
  const response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groqApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.groqModel, messages, response_format: { type: "json_object" }, max_completion_tokens: 900, temperature: 0 }),
  });
  if (!response.ok) throw new Error(`Groq ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? null;
}

export async function extractOpportunity({ url, title, text }) {
  const messages = [
    { role: "system", content: prompt },
    { role: "user", content: `SOURCE URL: ${url}\nPAGE TITLE: ${title ?? ""}\nPAGE TEXT:\n${String(text ?? "").slice(0, 24000)}` },
  ];
  let output;
  try {
    output = await cloudflare(messages);
  } catch (error) {
    console.warn("Cloudflare extraction failed; trying fallback", error.message);
  }
  if (!output) output = await groq(messages);
  if (!output) throw new Error("No LLM provider configured");
  return normalize(parseJson(output), url);
}
