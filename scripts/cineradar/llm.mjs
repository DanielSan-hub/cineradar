import { config } from "./config.mjs";
import {
  cloudflareTokenUsage,
  estimateCloudflareUsage,
  estimateGroqUsage,
  estimateMessageTokens,
  finalizeProviderUsage,
  groqTokenUsage,
  PRICED_GROQ_MODELS,
  reserveProviderUsage,
  usageIdempotencyKey,
} from "./cost-control.mjs";
import { fetchWithTimeout } from "./http.mjs";

const SYSTEM_PROMPT = `You extract real opportunities for filmmakers, animators, moving-image and media artists, music-video directors, and AI-video creators from one fetched web page.
Return only a JSON object with an "opportunities" array (maximum 5 items). Prefer the current, upcoming or rolling call cycle over historical editions. If none are relevant, return {"opportunities":[]}.

Hard rules:
- Never construct, autocomplete or guess a URL. official_url, application_url and deadline_source_url must be null or copied exactly from SOURCE URL / ALLOWED LINKS supplied by the user.
- Never invent a deadline, date, organizer, fee, prize, location, eligibility rule or format. Use null, [], "unknown", or "Unknown organizer" when absent.
- A listing page may contain several distinct calls: return one item for each, not just the first.
- An aggregator, article or social page is source_type press/social/community, never official merely because it mentions an event.
- deadline_status is confirmed only for an explicit published date, estimated only when the page explicitly describes it as approximate, rolling only when explicitly rolling, otherwise unknown.
- observed_status is open, closing-soon or closed only when the page explicitly states that status for this exact opportunity. Otherwise null. Copy the exact short supporting phrase into status_evidence; do not infer status from a date.
- Copy short verbatim supporting snippets (maximum 180 characters each) into deadline_evidence and field_evidence. Evidence must occur in PAGE TEXT. Keep summary under 300 characters and each list to at most 8 concise items.

Each array item has this shape:
{"relevant":boolean,"title":string|null,"canonical_name":string|null,"organizer":string|null,"category":"AI film festival"|"Traditional festival"|"Platform challenge"|"Grant"|"Residency"|"Advertising competition"|null,"ai_policy":"allowed"|"required"|"restricted"|"unclear","deadline":string|null,"deadline_status":"confirmed"|"estimated"|"unknown"|"rolling","deadline_evidence":string|null,"observed_status":"open"|"closing-soon"|"closed"|null,"status_evidence":string|null,"deadline_source_url":string|null,"opens_at":string|null,"prize_amount":number|null,"prize_currency":string|null,"entry_fee_amount":number|null,"entry_fee_currency":string|null,"location":string|null,"remote":boolean,"max_runtime_minutes":number|null,"official_url":string|null,"application_url":string|null,"source_type":"official"|"press"|"social"|"community","confidence":number,"summary":string,"eligibility":string[],"formats":string[],"tags":string[],"opportunity_year":number|null,"edition":string|null,"field_evidence":{"title":string|null,"organizer":string|null,"opens_at":string|null,"prize":string|null,"entry_fee":string|null,"location":string|null,"max_runtime":string|null,"ai_policy":string|null,"eligibility":string|null,"formats":string|null}}`;

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

// Real extractions average ~700 output tokens (largest seen ~2,300); the
// reservation must match max_tokens so it stays an upper bound.
const MAX_OUTPUT_TOKENS = 2500;
const THROTTLE_RETRIES = 3;
const THROTTLE_BACKOFF_MS = 4000;
let cloudflareExhausted = false;
let groqUnavailable = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Workers AI includes 10,000 neurons a day at no charge on every plan. While
 * the enforced daily limit stays inside that allowance, Cloudflare usage is
 * booked at EUR 0 (neurons and list price stay in the usage units), so the
 * paid-provider budget is left to providers that can actually charge.
 */
export function cloudflareCharge(amount, {
  dailyLimit = config.cloudflareDailyNeuronLimit,
  freeDaily = config.cloudflareFreeDailyNeurons,
} = {}) {
  return Number(dailyLimit) <= Number(freeDaily) ? 0 : amount;
}

/** Errors after which no Cloudflare inference happened (safe to use Groq). */
export function cloudflareRefusedBeforeInference(error) {
  return error?.code === "LLM_PROVIDER_EXHAUSTED"
    || error?.code === "LLM_THROTTLED"
    || (error?.code === "BUDGET_BLOCKED" && error?.reason === "daily-provider-limit");
}

/** Cloudflare error 3036 / "daily free allocation" means: stop for today. */
export function cloudflareThrottle(body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const text = errors.map((item) => `${item?.code ?? ""} ${item?.message ?? ""}`).join(" ");
  return {
    exhausted: /\b3036\b|daily free allocation|neurons? (?:limit|allocation)/i.test(text),
    text: text.slice(0, 200),
  };
}

async function cloudflare(messages, context) {
  if (!config.cloudflareAccountId || !config.cloudflareApiToken) return null;
  if (cloudflareExhausted) {
    const error = new Error("Cloudflare AI daily allocation is used up for this run");
    error.code = "LLM_PROVIDER_EXHAUSTED";
    throw error;
  }
  const reservedUsage = estimateCloudflareUsage({
    inputTokens: estimateMessageTokens(messages),
    outputTokens: MAX_OUTPUT_TOKENS,
  });
  const reservation = await reserveProviderUsage({
    idempotencyKey: usageIdempotencyKey([
      context.runId,
      "cloudflare",
      context.operation,
      context.url,
      context.contentHash,
    ]),
    runId: context.runId,
    provider: "cloudflare",
    operation: context.operation,
    model: config.cloudflareModel,
    reservedCostEur: cloudflareCharge(reservedUsage.cost_eur),
    usageUnits: {
      reserved_input_tokens: reservedUsage.input_tokens,
      reserved_output_tokens: reservedUsage.output_tokens,
      reserved_neurons: reservedUsage.neurons,
    },
    dailyUsageLimit: config.cloudflareDailyNeuronLimit,
    metadata: { source_url: context.url },
  });
  let finalized = false;
  try {
    let response;
    let body;
    for (let attempt = 1; ; attempt += 1) {
      response = await fetchWithTimeout(
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
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0,
          }),
        },
        config.llmTimeoutMs,
      );
      body = await response.json().catch(() => null);
      if (response.status !== 429) break;
      // A 429 is refused before inference, so nothing was consumed: release the
      // reservation instead of counting it against the daily neuron limit.
      const throttle = cloudflareThrottle(body);
      if (!throttle.exhausted && attempt < THROTTLE_RETRIES) {
        await sleep(THROTTLE_BACKOFF_MS * attempt);
        continue;
      }
      if (throttle.exhausted) cloudflareExhausted = true;
      await finalizeProviderUsage(reservation.event_id, {
        status: "released",
        usageUnits: { reserved_neurons: reservedUsage.neurons, released_neurons: reservedUsage.neurons },
        estimatedCostEur: 0,
        providerCurrency: "USD",
        httpStatus: 429,
        errorCode: throttle.exhausted ? "CLOUDFLARE_DAILY_ALLOCATION" : "CLOUDFLARE_THROTTLED",
      });
      finalized = true;
      const error = new Error(`Cloudflare AI 429 ${throttle.exhausted ? "daily allocation used" : "throttled"}`);
      error.code = throttle.exhausted ? "LLM_PROVIDER_EXHAUSTED" : "LLM_THROTTLED";
      error.httpStatus = 429;
      throw error;
    }
    if (!response.ok || body?.success !== true || !body?.result) {
      const error = new Error(`Cloudflare AI ${response.status} invalid response`);
      error.httpStatus = response.status;
      throw error;
    }
    const tokenUsage = cloudflareTokenUsage(body);
    if (!tokenUsage.inputTokens && !tokenUsage.outputTokens) {
      throw new Error("Cloudflare AI response is missing usage counters");
    }
    const actualUsage = estimateCloudflareUsage(tokenUsage);
    const output = body.result.response
      ?? body.result.choices?.[0]?.message?.content
      ?? null;
    if (!output) throw new Error("Cloudflare AI returned an empty extraction");
    await finalizeProviderUsage(reservation.event_id, {
      status: "succeeded",
      usageUnits: actualUsage,
      estimatedCostEur: cloudflareCharge(actualUsage.cost_eur),
      providerCost: cloudflareCharge(actualUsage.cost_usd),
      providerCurrency: "USD",
      providerRequestId: body.result.request_id ?? response.headers.get("cf-ray"),
      httpStatus: response.status,
    });
    finalized = true;
    return output;
  } catch (error) {
    if (!finalized) {
      await finalizeProviderUsage(reservation.event_id, {
        status: "uncertain",
        usageUnits: {
          reserved_input_tokens: reservedUsage.input_tokens,
          reserved_output_tokens: reservedUsage.output_tokens,
          reserved_neurons: reservedUsage.neurons,
        },
        estimatedCostEur: cloudflareCharge(reservedUsage.cost_eur),
        providerCost: null,
        providerCurrency: "USD",
        httpStatus: error.httpStatus ?? null,
        errorCode: "CLOUDFLARE_REQUEST_UNCERTAIN",
      });
    }
    throw error;
  }
}

// Groq's free tier limits tokens per minute, so the prompt sent there is
// shorter than Cloudflare's; a 429 is refused before inference (no charge).
const GROQ_TEXT_CHARACTERS = 14_000;
const GROQ_MAX_OUTPUT_TOKENS = 2000;
// The free tier allows a few thousand tokens a minute: wait out a 429 when
// the requested pause is short, and send Groq calls one at a time.
const GROQ_MAX_WAIT_MS = 65_000;
let groqQueue = Promise.resolve();

/** Seconds to wait from a Groq 429 (retry-after header or "try again in 7.5s"). */
export function groqRetryAfterMs(headers, body) {
  const raw = headers?.get?.("retry-after");
  const header = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  if (Number.isFinite(header) && header >= 0) return header * 1000;
  const match = /try again in\s+(?:(\d+)m)?([\d.]+)s/i.exec(String(body?.error?.message ?? ""));
  if (match) return (Number(match[1] ?? 0) * 60 + Number(match[2])) * 1000;
  return null;
}

// Groq retires models; when the configured one is gone the pipeline picks
// the first available free-tier model it can price, in this order.
export const GROQ_MODEL_PREFERENCE = Object.freeze([
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
  "qwen/qwen3-32b",
  "llama-3.3-70b-versatile",
]);
let groqModel = config.groqModel;
let groqModelResolved = false;

/** Request options that keep reasoning models from spending tokens on thoughts. */
export function groqReasoningOptions(model) {
  if (/^openai\/gpt-oss/i.test(model)) return { reasoning_effort: "low", include_reasoning: false };
  if (/^qwen\/qwen3/i.test(model)) return { reasoning_effort: "none" };
  return {};
}

/** First preferred, priced model the account can use (null when none). */
export function pickGroqModel(available, { preference = GROQ_MODEL_PREFERENCE, priced = PRICED_GROQ_MODELS } = {}) {
  const usable = new Set(available);
  return preference.find((model) => usable.has(model) && priced.includes(model)) ?? null;
}

async function resolveGroqModel() {
  groqModelResolved = true;
  try {
    const response = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
    }, 15_000);
    const body = await response.json().catch(() => null);
    const available = (body?.data ?? []).filter((model) => model?.active !== false).map((model) => String(model.id));
    const chosen = pickGroqModel(available);
    console.warn(`Groq model ${groqModel} unavailable; available: ${available.join(", ").slice(0, 400)}; using ${chosen ?? "none"}`);
    if (chosen && chosen !== groqModel) {
      groqModel = chosen;
      return true;
    }
  } catch (error) {
    console.warn(`Groq model list failed: ${String(error.message).slice(0, 160)}`);
  }
  return false;
}

function groq(messages, context) {
  const call = groqQueue.then(() => groqCall(messages, context));
  groqQueue = call.catch(() => {});
  return call;
}

async function groqCall(messages, context) {
  if (!config.groqApiKey || groqUnavailable) return null;
  // One model per call, even if another call switches the run's model meanwhile.
  const model = groqModel;
  const reservedUsage = estimateGroqUsage({
    inputTokens: estimateMessageTokens(messages),
    outputTokens: GROQ_MAX_OUTPUT_TOKENS,
  }, model);
  const reservation = await reserveProviderUsage({
    idempotencyKey: usageIdempotencyKey([
      context.runId,
      "groq",
      model,
      context.operation,
      context.url,
      context.contentHash,
    ]),
    runId: context.runId,
    provider: "groq",
    operation: context.operation,
    model: model,
    reservedCostEur: reservedUsage.cost_eur,
    usageUnits: {
      reserved_input_tokens: reservedUsage.input_tokens,
      reserved_output_tokens: reservedUsage.output_tokens,
    },
    optional: true,
    metadata: { source_url: context.url },
  });
  let finalized = false;
  const release = async (httpStatus, errorCode) => {
    await finalizeProviderUsage(reservation.event_id, {
      status: "released",
      usageUnits: { reserved_input_tokens: reservedUsage.input_tokens, reserved_output_tokens: reservedUsage.output_tokens },
      estimatedCostEur: 0,
      providerCurrency: "USD",
      httpStatus,
      errorCode,
    });
    finalized = true;
  };
  try {
    let response;
    let body;
    for (let attempt = 1; ; attempt += 1) {
      response = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.groqApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model,
            messages,
            response_format: { type: "json_object" },
            max_completion_tokens: GROQ_MAX_OUTPUT_TOKENS,
            temperature: 0,
            // Reasoning models spend output tokens thinking: extraction needs
            // little of it, and the free tier counts every token.
            ...groqReasoningOptions(model),
          }),
        },
        config.llmTimeoutMs,
      );
      body = await response.json().catch(() => null);
      if (response.status !== 429) break;
      const waitMs = groqRetryAfterMs(response.headers, body);
      if (attempt < 6 && waitMs !== null && waitMs <= GROQ_MAX_WAIT_MS) {
        await sleep(waitMs + 250);
        continue;
      }
      // A long wait means the daily free quota is used: stop using Groq.
      groqUnavailable = true;
      await release(429, "GROQ_RATE_LIMITED");
      const error = new Error("Groq 429 rate limited");
      error.code = "LLM_THROTTLED";
      error.httpStatus = 429;
      throw error;
    }
    const modelGone = response.status === 404
      || /model_(?:not_found|decommissioned)|does not exist|decommissioned/i.test(String(body?.error?.code ?? body?.error?.message ?? ""));
    if (modelGone && (model !== groqModel || !groqModelResolved)) {
      await release(response.status, "GROQ_MODEL_UNAVAILABLE");
      if (model !== groqModel || await resolveGroqModel()) return groqCall(messages, context);
    }
    const errorText = `${body?.error?.code ?? ""} ${body?.error?.message ?? ""}`;
    if (response.status === 400 && !/api[_ ]key|model|permission|organization|billing/i.test(errorText)) {
      // One page refused (invalid JSON output, too long, ...): nothing billed,
      // Groq stays available for the next page.
      await release(400, "GROQ_REQUEST_REJECTED");
      console.warn(`Groq 400 for ${context.url}: ${errorText.trim().slice(0, 200)}`);
      const error = new Error(`Groq 400 ${errorText.trim().slice(0, 120)}`);
      error.code = "LLM_REQUEST_REJECTED";
      error.httpStatus = 400;
      throw error;
    }
    if ([400, 401, 403, 404].includes(response.status)) {
      // Bad key, unknown model or refused request: nothing was generated.
      console.warn(`Groq ${response.status}: ${errorText.trim().slice(0, 200)}`);
      groqUnavailable = true;
      if (finalized) {
        const error = new Error(`Groq ${response.status} no usable model`);
        error.code = "LLM_PROVIDER_UNAVAILABLE";
        error.httpStatus = response.status;
        throw error;
      }
      await release(response.status, `GROQ_HTTP_${response.status}`);
      const error = new Error(`Groq ${response.status} ${String(body?.error?.code ?? "")}`.trim());
      error.code = "LLM_PROVIDER_UNAVAILABLE";
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.ok || !body) {
      const error = new Error(`Groq ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    const tokenUsage = groqTokenUsage(body);
    const actualUsage = estimateGroqUsage(tokenUsage, model);
    const output = body.choices?.[0]?.message?.content ?? null;
    if (!output) throw new Error("Groq returned an empty extraction");
    await finalizeProviderUsage(reservation.event_id, {
      status: "succeeded",
      usageUnits: actualUsage,
      estimatedCostEur: actualUsage.cost_eur,
      providerCost: actualUsage.cost_usd,
      providerCurrency: "USD",
      providerRequestId: body.id ?? response.headers.get("x-request-id"),
      httpStatus: response.status,
    });
    finalized = true;
    return output;
  } catch (error) {
    if (!finalized) {
      await finalizeProviderUsage(reservation.event_id, {
        status: "uncertain",
        usageUnits: {
          reserved_input_tokens: reservedUsage.input_tokens,
          reserved_output_tokens: reservedUsage.output_tokens,
        },
        estimatedCostEur: reservedUsage.cost_eur,
        providerCurrency: "USD",
        httpStatus: error.httpStatus ?? null,
        errorCode: "GROQ_REQUEST_UNCERTAIN",
      });
    }
    throw error;
  }
}

function extractionMessages({ url, title, text, links, textCharacters, linkLimit }) {
  const allowedLinks = [...new Set([url, ...links])]
    .filter(Boolean)
    .slice(0, linkLimit)
    .map((link) => `- ${link}`)
    .join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `SOURCE URL: ${url}\nPAGE TITLE: ${title ?? ""}\nALLOWED LINKS:\n${allowedLinks}\n\nPAGE TEXT:\n${String(text ?? "").slice(0, textCharacters)}`,
    },
  ];
}

export async function extractOpportunities({
  url,
  title,
  text,
  links = [],
  runId = null,
  operation = "extract",
  contentHash = null,
}) {
  const context = { runId, operation, url, contentHash };
  const cloudflareConfigured = Boolean(
    config.cloudflareAccountId && config.cloudflareApiToken,
  );
  const groqReady = Boolean(config.groqFallbackEnabled && config.groqApiKey);
  let output = null;
  if (cloudflareConfigured) {
    try {
      output = await cloudflare(extractionMessages({ url, title, text, links, textCharacters: 60_000, linkLimit: 120 }), context);
    } catch (error) {
      // Groq takes over only when Cloudflare refused before any inference
      // (daily allowance used, throttled, or blocked by the daily limit), so
      // one page is never billed by two providers.
      if (!groqReady || groqUnavailable || !cloudflareRefusedBeforeInference(error)) throw error;
    }
  }
  if (!output && groqReady && !groqUnavailable) {
    output = await groq(extractionMessages({ url, title, text, links, textCharacters: GROQ_TEXT_CHARACTERS, linkLimit: 60 }), context);
  }
  if (!output) {
    const error = new Error(
      groqReady && groqUnavailable
        ? "No LLM capacity left for this run"
        : cloudflareConfigured
          ? "Cloudflare AI returned no extraction"
          : config.groqFallbackEnabled
            ? "Enabled Groq provider returned no extraction"
            : "No enabled LLM provider configured",
    );
    error.code = groqReady && groqUnavailable ? "LLM_PROVIDER_EXHAUSTED" : undefined;
    throw error;
  }
  return parseExtractionPayload(output);
}

// Backward-compatible helper for callers outside the scheduled pipeline.
export async function extractOpportunity(input) {
  return (await extractOpportunities(input))[0] ?? null;
}
