import { config } from "./config.mjs";
import { fetchWithTimeout } from "./http.mjs";

const SYSTEM_PROMPT = `You extract real opportunities for filmmakers from one fetched web page.
Return only a JSON object with an "opportunities" array (maximum 5 items). Prefer the current, upcoming or rolling call cycle over historical editions. If none are relevant, return {"opportunities":[]}.

Hard rules:
- Never construct, autocomplete or guess a URL. official_url, application_url and deadline_source_url must be null or copied exactly from SOURCE URL / ALLOWED LINKS supplied by the user.
- Never invent a deadline, date, organizer, fee, prize, location, eligibility rule or format. Use null, [], "unknown", or "Unknown organizer" when absent.
- A listing page may contain several distinct calls: return one item for each, not just the first.
- An aggregator, article or social page is source_type press/social/community, never official merely because it mentions an event.
- deadline_status is confirmed only for an explicit published date, estimated only when the page explicitly describes it as approximate, rolling only when explicitly rolling, otherwise unknown.
- Copy short verbatim supporting snippets (maximum 180 characters each) into deadline_evidence and field_evidence. Evidence must occur in PAGE TEXT. Keep summary under 300 characters and each list to at most 8 concise items.

Each array item has this shape:
{"relevant":boolean,"title":string|null,"canonical_name":string|null,"organizer":string|null,"category":"AI film festival"|"Traditional festival"|"Platform challenge"|"Grant"|"Residency"|"Advertising competition"|null,"ai_policy":"allowed"|"required"|"restricted"|"unclear","deadline":string|null,"deadline_status":"confirmed"|"estimated"|"unknown"|"rolling","deadline_evidence":string|null,"deadline_source_url":string|null,"opens_at":string|null,"prize_amount":number|null,"prize_currency":string|null,"entry_fee_amount":number|null,"entry_fee_currency":string|null,"location":string|null,"remote":boolean,"max_runtime_minutes":number|null,"official_url":string|null,"application_url":string|null,"source_type":"official"|"press"|"social"|"community","confidence":number,"summary":string,"eligibility":string[],"formats":string[],"tags":string[],"opportunity_year":number|null,"edition":string|null,"field_evidence":{"title":string|null,"organizer":string|null,"opens_at":string|null,"prize":string|null,"entry_fee":string|null,"location":string|null,"max_runtime":string|null,"ai_policy":string|null,"eligibility":string|null,"formats":string|null}}`;

export function parseExtractionPayload(value) {
  let parsed = value;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("LLM returned no JSON object");
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (error) {
      const arrayStart = cleaned.indexOf("[", cleaned.indexOf('"opportunities"'));
      const recovered = [];
      let objectStart = -1;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = Math.max(0, arrayStart + 1); index < cleaned.length; index += 1) {
        const character = cleaned[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === "{") {
          if (depth === 0) objectStart = index;
          depth += 1;
        } else if (character === "}" && depth > 0) {
          depth -= 1;
          if (depth === 0 && objectStart >= 0) {
            try { recovered.push(JSON.parse(cleaned.slice(objectStart, index + 1))); } catch {}
            objectStart = -1;
          }
        }
      }
      if (!recovered.length) throw error;
      parsed = { opportunities: recovered };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM returned an unsupported response type");
  }
  const items = Array.isArray(parsed.opportunities)
    ? parsed.opportunities
    : "relevant" in parsed
      ? [parsed]
      : [];
  return items
    .filter((item) => item && typeof item === "object" && item.relevant !== false)
    .slice(0, 5);
}

async function cloudflare(messages) {
  if (!config.cloudflareAccountId || !config.cloudflareApiToken) return null;
  const response = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${config.cloudflareModel}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.cloudflareApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages,
        response_format: { type: "json_object" },
        max_tokens: 4000,
        temperature: 0,
      }),
    },
    config.llmTimeoutMs,
  );
  if (!response.ok) throw new Error(`Cloudflare AI ${response.status}`);
  const body = await response.json();
  return body.result?.response ?? body.result?.choices?.[0]?.message?.content ?? null;
}

async function groq(messages) {
  if (!config.groqApiKey) return null;
  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.groqModel,
        messages,
        response_format: { type: "json_object" },
        max_completion_tokens: 4000,
        temperature: 0,
      }),
    },
    config.llmTimeoutMs,
  );
  if (!response.ok) throw new Error(`Groq ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? null;
}

export async function extractOpportunities({ url, title, text, links = [] }) {
  const allowedLinks = [...new Set([url, ...links])]
    .filter(Boolean)
    .slice(0, 120)
    .map((link) => `- ${link}`)
    .join("\n");
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `SOURCE URL: ${url}\nPAGE TITLE: ${title ?? ""}\nALLOWED LINKS:\n${allowedLinks}\n\nPAGE TEXT:\n${String(text ?? "").slice(0, 60_000)}`,
    },
  ];
  let output;
  try {
    output = await cloudflare(messages);
  } catch (error) {
    console.warn("Cloudflare extraction failed; trying fallback", error.message);
  }
  if (!output) output = await groq(messages);
  if (!output) throw new Error("No LLM provider configured");
  return parseExtractionPayload(output);
}

// Backward-compatible helper for callers outside the scheduled pipeline.
export async function extractOpportunity(input) {
  return (await extractOpportunities(input))[0] ?? null;
}
