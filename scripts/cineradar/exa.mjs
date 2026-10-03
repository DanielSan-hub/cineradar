// One ledgered Exa search: reserve in the Exa budget pool, call, finalize.
// Callers that are not the discovery run (e.g. site resolution) use this so
// every Exa request is counted against the owner-approved monthly ceiling.
//
// Exa gives the account USD 10 of free credits a month (owner, 2026-10-03);
// the database pool stops optional Exa work at 90% of 9. When the credits
// run out Exa answers 402 and charges nothing: the run stops calling Exa.

import { config } from "./config.mjs";
import {
  BudgetBlockedError,
  estimateExaReservation,
  estimateExaSearch,
  finalizeProviderUsage,
  reserveProviderUsage,
} from "./cost-control.mjs";
import { fetchWithTimeout } from "./http.mjs";

// Refused before any search ran: never billed.
export const EXA_NO_CHARGE = Object.freeze(new Set([400, 401, 402, 403, 422, 429]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let exaExhausted = false;

/** True once Exa answered 402 (credits or key budget used up) in this run. */
export function exaIsExhausted() {
  return exaExhausted;
}

/** Records a 402 seen outside ledgeredExaSearch (discovery's own search call). */
export function markExaExhausted() {
  exaExhausted = true;
}

/** Seconds Exa asks to wait after a 429 (Retry-After), capped. */
export function exaRetryAfterMs(headers) {
  const value = Number(headers?.get?.("retry-after"));
  return Number.isFinite(value) && value >= 0 ? Math.min(30_000, value * 1000) : 2000;
}

/**
 * @returns {Promise<{ blocked: true, reason: string } | { blocked: false, results: object[], costEur: number }>}
 */
export async function ledgeredExaSearch({
  idempotencyKey,
  runId = null,
  operation = "search",
  text,
  type = "auto",
  numResults = 10,
  excludeDomains = [],
  userLocation = null,
  optional = true,
  metadata = {},
}) {
  if (!config.exaApiKey) throw new Error("EXA_API_KEY is not configured");
  if (exaExhausted) return { blocked: true, reason: "EXA_402" };
  const shape = { type, numResults };
  const reserved = estimateExaReservation(shape);
  let reservation;
  try {
    reservation = await reserveProviderUsage({
      idempotencyKey,
      runId,
      provider: "exa",
      operation,
      reservedCostEur: reserved.cost_eur,
      usageUnits: { searches: 1, search_type: type },
      optional,
      metadata: { ...metadata, query_text: text },
    });
  } catch (error) {
    if (error instanceof BudgetBlockedError) return { blocked: true, reason: error.reason };
    throw error;
  }

  let response;
  let body = null;
  try {
    for (let attempt = 1; ; attempt += 1) {
      response = await fetchWithTimeout("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": config.exaApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: text,
          type,
          numResults,
          ...(excludeDomains.length ? { excludeDomains } : {}),
          ...(userLocation ? { userLocation } : {}),
        }),
      });
      body = await response.json().catch(() => null);
      if (response.status !== 429 || attempt >= 2) break;
      await sleep(exaRetryAfterMs(response.headers));
    }
  } catch (error) {
    // The request may have reached Exa: keep the reservation as uncertain.
    await finalizeProviderUsage(reservation.event_id, {
      status: "uncertain",
      usageUnits: { searches: 1, search_type: type },
      estimatedCostEur: reserved.cost_eur,
      providerCurrency: "USD",
      errorCode: "EXA_REQUEST_UNCERTAIN",
    }).catch(() => {});
    throw error;
  }

  if (!response.ok || !body) {
    const definiteNoCharge = EXA_NO_CHARGE.has(response.status);
    if (response.status === 402) exaExhausted = true;
    await finalizeProviderUsage(reservation.event_id, {
      status: definiteNoCharge ? "released" : "uncertain",
      usageUnits: { searches: 1, search_type: type },
      estimatedCostEur: definiteNoCharge ? 0 : reserved.cost_eur,
      providerCurrency: "USD",
      httpStatus: response.status,
      errorCode: `EXA_HTTP_${response.status}`,
    });
    if (response.status === 402) return { blocked: true, reason: "EXA_402" };
    throw new Error(`Exa ${response.status}`);
  }

  const actual = estimateExaSearch(body, shape);
  const results = Array.isArray(body.results) ? body.results : [];
  await finalizeProviderUsage(reservation.event_id, {
    status: "succeeded",
    usageUnits: { ...actual, search_type: type, results: results.length },
    estimatedCostEur: actual.cost_eur,
    providerCost: actual.cost_usd,
    providerCurrency: "USD",
    providerRequestId: body.requestId ?? body.request_id ?? response.headers.get("x-request-id"),
    httpStatus: response.status,
  });
  return { blocked: false, results, costEur: actual.cost_eur };
}
