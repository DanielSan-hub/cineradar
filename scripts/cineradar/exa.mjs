// One ledgered Exa search: reserve in the Exa budget pool, call, finalize.
// Callers that are not the discovery run (e.g. site resolution) use this so
// every Exa request is counted against the owner-approved monthly ceiling.

import { config } from "./config.mjs";
import {
  BudgetBlockedError,
  estimateExaReservation,
  estimateExaSearch,
  finalizeProviderUsage,
  reserveProviderUsage,
} from "./cost-control.mjs";
import { fetchWithTimeout } from "./http.mjs";

/**
 * @returns {Promise<{ blocked: true, reason: string } | { blocked: false, results: object[], costEur: number }>}
 */
export async function ledgeredExaSearch({
  idempotencyKey,
  runId = null,
  operation = "search",
  text,
  numResults = 5,
  excludeDomains = [],
  optional = true,
  metadata = {},
}) {
  if (!config.exaApiKey) throw new Error("EXA_API_KEY is not configured");
  const reserved = estimateExaReservation();
  let reservation;
  try {
    reservation = await reserveProviderUsage({
      idempotencyKey,
      runId,
      provider: "exa",
      operation,
      reservedCostEur: reserved.cost_eur,
      usageUnits: { searches: 1 },
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
    response = await fetchWithTimeout("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": config.exaApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: text,
        type: "auto",
        numResults,
        ...(excludeDomains.length ? { excludeDomains } : {}),
      }),
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    // The request may have reached Exa: keep the reservation as uncertain.
    await finalizeProviderUsage(reservation.event_id, {
      status: "uncertain",
      usageUnits: { searches: 1 },
      estimatedCostEur: reserved.cost_eur,
      providerCurrency: "USD",
      errorCode: "EXA_REQUEST_UNCERTAIN",
    }).catch(() => {});
    throw error;
  }

  if (!response.ok || !body) {
    const definiteNoCharge = [400, 401, 403].includes(response.status);
    await finalizeProviderUsage(reservation.event_id, {
      status: definiteNoCharge ? "released" : "uncertain",
      usageUnits: { searches: 1 },
      estimatedCostEur: definiteNoCharge ? 0 : reserved.cost_eur,
      providerCurrency: "USD",
      httpStatus: response.status,
      errorCode: `EXA_HTTP_${response.status}`,
    });
    throw new Error(`Exa ${response.status}`);
  }

  const actual = estimateExaSearch(body);
  const results = Array.isArray(body.results) ? body.results : [];
  await finalizeProviderUsage(reservation.event_id, {
    status: "succeeded",
    usageUnits: { ...actual, results: results.length },
    estimatedCostEur: actual.cost_eur,
    providerCost: actual.cost_usd,
    providerCurrency: "USD",
    providerRequestId: body.requestId ?? body.request_id ?? response.headers.get("x-request-id"),
    httpStatus: response.status,
  });
  return { blocked: false, results, costEur: actual.cost_eur };
}
