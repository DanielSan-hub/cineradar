import { createHash } from "node:crypto";

import { config } from "./config.mjs";
import { supabase } from "./supabase.mjs";

const PRICING_VERSION = "2026-09-23";
const CLOUDFLARE_PRICING = Object.freeze({
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": Object.freeze({
    inputUsdPerMillion: 0.045,
    outputUsdPerMillion: 0.384,
    inputNeuronsPerMillion: 4119,
    outputNeuronsPerMillion: 34868,
  }),
});
const GROQ_PRICING = Object.freeze({
  "openai/gpt-oss-20b": Object.freeze({
    inputUsdPerMillion: 0.075,
    outputUsdPerMillion: 0.30,
  }),
});
const EXA_SEARCH_RESERVATION_USD = 0.01;

export class BudgetBlockedError extends Error {
  constructor(reason, details = {}) {
    super(`BUDGET_BLOCKED: ${reason}`);
    this.name = "BudgetBlockedError";
    this.code = "BUDGET_BLOCKED";
    this.reason = reason;
    this.details = details;
  }
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function priceFor(registry, model, provider) {
  const pricing = registry[model];
  if (!pricing) {
    throw new Error(`No ${provider} pricing entry for configured model: ${model}`);
  }
  return pricing;
}

export function estimateCloudflareUsage(
  { inputTokens, outputTokens },
  model = config.cloudflareModel,
) {
  const pricing = priceFor(CLOUDFLARE_PRICING, model, "Cloudflare");
  const input = finiteNonnegative(inputTokens);
  const output = finiteNonnegative(outputTokens);
  const costUsd = (
    input * pricing.inputUsdPerMillion
    + output * pricing.outputUsdPerMillion
  ) / 1_000_000;
  const neurons = (
    input * pricing.inputNeuronsPerMillion
    + output * pricing.outputNeuronsPerMillion
  ) / 1_000_000;
  return {
    input_tokens: input,
    output_tokens: output,
    neurons: Number(neurons.toFixed(6)),
    cost_usd: Number(costUsd.toFixed(8)),
    cost_eur: Number((costUsd * config.usdToEurRate).toFixed(8)),
    pricing_version: PRICING_VERSION,
  };
}

export function estimateGroqUsage(
  { inputTokens, outputTokens, cachedInputTokens = 0 },
  model = config.groqModel,
) {
  const pricing = priceFor(GROQ_PRICING, model, "Groq");
  const input = finiteNonnegative(inputTokens) + finiteNonnegative(cachedInputTokens);
  const output = finiteNonnegative(outputTokens);
  const costUsd = (
    input * pricing.inputUsdPerMillion
    + output * pricing.outputUsdPerMillion
  ) / 1_000_000;
  return {
    input_tokens: input,
    output_tokens: output,
    cost_usd: Number(costUsd.toFixed(8)),
    cost_eur: Number((costUsd * config.usdToEurRate).toFixed(8)),
    pricing_version: PRICING_VERSION,
  };
}

export function estimateExaSearch({ costDollars } = {}) {
  let costUsd = Number(costDollars);
  if (!Number.isFinite(costUsd) && costDollars && typeof costDollars === "object") {
    costUsd = Number(costDollars.total);
    if (!Number.isFinite(costUsd)) {
      costUsd = Object.values(costDollars)
        .map(Number)
        .filter(Number.isFinite)
        .reduce((total, value) => total + value, 0);
    }
  }
  if (!Number.isFinite(costUsd) || costUsd < 0) costUsd = 0.007;
  return {
    searches: 1,
    cost_usd: Number(costUsd.toFixed(8)),
    cost_eur: Number((costUsd * config.usdToEurRate).toFixed(8)),
    pricing_version: PRICING_VERSION,
  };
}

export function estimateExaReservation() {
  return {
    searches: 1,
    cost_usd: EXA_SEARCH_RESERVATION_USD,
    cost_eur: Number(
      (EXA_SEARCH_RESERVATION_USD * config.usdToEurRate).toFixed(8),
    ),
    pricing_version: PRICING_VERSION,
  };
}

export function cloudflareTokenUsage(body) {
  const usage = body?.result?.usage ?? body?.usage ?? {};
  return {
    inputTokens: finiteNonnegative(
      usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens,
    ),
    outputTokens: finiteNonnegative(
      usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens,
    ),
  };
}

export function groqTokenUsage(body) {
  const usage = body?.usage ?? {};
  return {
    inputTokens: finiteNonnegative(usage.prompt_tokens),
    outputTokens: finiteNonnegative(usage.completion_tokens),
    cachedInputTokens: finiteNonnegative(
      usage.prompt_tokens_details?.cached_tokens,
    ),
  };
}

export function budgetMode(
  spendEur,
  budgetEur = config.monthlyBudgetEur,
  targetEur = config.monthlyTargetEur,
  optionalStopEur = config.optionalStopEur,
) {
  const budget = finiteNonnegative(budgetEur);
  const spend = finiteNonnegative(spendEur);
  if (budget === 0 || spend >= budget) return "stopped";
  const target = Math.min(budget, finiteNonnegative(targetEur));
  const optionalStop = Math.min(
    budget,
    Math.max(target, finiteNonnegative(optionalStopEur)),
  );
  if (spend >= optionalStop) return "essential-only";
  if (spend >= target) return "conserve";
  return "normal";
}

export function limitsForBudget(mode, limits) {
  if (mode === "stopped") return { queryLimit: 0, resultLimit: 1, llmLimit: 0 };
  if (mode === "essential-only") {
    return {
      queryLimit: 0,
      resultLimit: 1,
      llmLimit: Math.min(limits.llmLimit, 4),
    };
  }
  if (mode === "conserve") {
    return {
      queryLimit: Math.min(limits.queryLimit, 2),
      resultLimit: Math.min(limits.resultLimit, 4),
      llmLimit: Math.min(limits.llmLimit, 12),
    };
  }
  return { ...limits };
}

export function usageIdempotencyKey(parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex");
}

function utcMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function getBudgetState(now = new Date()) {
  const rows = await supabase(
    `provider_usage_events?select=status,reserved_cost_eur,estimated_cost_eur&occurred_at=gte.${encodeURIComponent(utcMonthStart(now))}&limit=10000`,
  );
  const counted = new Set(["reserved", "succeeded", "uncertain"]);
  const spendEur = rows.reduce((total, row) => {
    if (!counted.has(row.status)) return total;
    const value = row.status === "reserved"
      ? row.reserved_cost_eur
      : row.estimated_cost_eur ?? row.reserved_cost_eur;
    return total + finiteNonnegative(value);
  }, 0);
  return {
    spendEur: Number(spendEur.toFixed(8)),
    budgetEur: config.monthlyBudgetEur,
    utilization: config.monthlyBudgetEur > 0
      ? spendEur / config.monthlyBudgetEur
      : 1,
    targetEur: Math.min(config.monthlyBudgetEur, config.monthlyTargetEur),
    optionalStopEur: Math.min(config.monthlyBudgetEur, config.optionalStopEur),
    mode: budgetMode(spendEur),
  };
}

export async function reserveProviderUsage({
  idempotencyKey,
  runId,
  provider,
  operation,
  model = null,
  reservedCostEur,
  usageUnits = {},
  optional = false,
  dailyUsageLimit = null,
  metadata = {},
}) {
  const result = await supabase("rpc/reserve_provider_usage", {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify({
      p_idempotency_key: idempotencyKey,
      p_pipeline_run_id: runId ?? null,
      p_provider: provider,
      p_operation: operation,
      p_model: model,
      p_reserved_cost_eur: reservedCostEur,
      p_usage_units: usageUnits,
      p_monthly_budget_eur: config.monthlyBudgetEur,
      p_optional: optional,
      p_daily_usage_limit: dailyUsageLimit,
      p_metadata: {
        ...metadata,
        pricing_version: PRICING_VERSION,
      },
    }),
  });
  if (!result?.allowed) {
    throw new BudgetBlockedError(result?.reason ?? "reservation-denied", result ?? {});
  }
  return result;
}

export async function finalizeProviderUsage(eventId, {
  status,
  usageUnits,
  estimatedCostEur,
  providerCost = null,
  providerCurrency = null,
  providerRequestId = null,
  httpStatus = null,
  errorCode = null,
}) {
  return supabase(`provider_usage_events?id=eq.${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      status,
      usage_units: usageUnits ?? {},
      estimated_cost_eur: finiteNonnegative(estimatedCostEur),
      provider_cost: providerCost,
      provider_currency: providerCurrency,
      provider_request_id: providerRequestId,
      http_status: httpStatus,
      error_code: errorCode,
      finalized_at: new Date().toISOString(),
    }),
  });
}

export function estimateMessageTokens(messages) {
  // A UTF-8 byte can never expand into more than one byte-level BPE token.
  // Reserving against bytes (instead of the usual chars / 4 estimate) makes
  // the pre-dispatch reservation an upper bound for multilingual prompts.
  return Math.max(1, Buffer.byteLength(JSON.stringify(messages), "utf8"));
}

export function projectConfiguredMonthlyCost({
  multiplier = 1,
  days = 365.25 / 12,
  inputTokensPerExtraction = 15_000,
  outputTokensPerExtraction = 500,
  queryLimit = config.discoveryQueryLimit,
  llmLimit = config.maxLlmCalls,
} = {}) {
  const scale = Math.max(0, finiteNonnegative(multiplier));
  const monthDays = Math.max(0, finiteNonnegative(days));
  const exa = estimateExaSearch();
  const cloudflare = estimateCloudflareUsage({
    inputTokens: inputTokensPerExtraction,
    outputTokens: outputTokensPerExtraction,
  });
  const exaCostEur = monthDays * finiteNonnegative(queryLimit) * exa.cost_eur * scale;
  const cloudflareCostEur = monthDays
    * finiteNonnegative(llmLimit)
    * cloudflare.cost_eur
    * scale;
  const grossDemandEur = exaCostEur + cloudflareCostEur;
  return {
    multiplier: scale,
    days: Number(monthDays.toFixed(4)),
    assumptions: {
      queries_per_day: finiteNonnegative(queryLimit),
      extractions_per_day: finiteNonnegative(llmLimit),
      input_tokens_per_extraction: finiteNonnegative(inputTokensPerExtraction),
      output_tokens_per_extraction: finiteNonnegative(outputTokensPerExtraction),
      credits_and_free_tiers: "excluded",
    },
    exa_cost_eur: Number(exaCostEur.toFixed(2)),
    cloudflare_cost_eur: Number(cloudflareCostEur.toFixed(2)),
    gross_demand_eur: Number(grossDemandEur.toFixed(2)),
    enforced_max_eur: Number(Math.min(grossDemandEur, config.monthlyBudgetEur).toFixed(2)),
  };
}
