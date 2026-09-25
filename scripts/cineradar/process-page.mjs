import { config } from "./config.mjs";
import { deterministicPageExtraction } from "./deterministic-extractor.mjs";
import { mapPool } from "./http.mjs";
import { extractOpportunities } from "./llm.mjs";
import {
  applyUrlValidations,
  normalizeOpportunity,
  PipelineRejection,
} from "./normalization.mjs";
import { incrementMetric, recordRejection } from "./telemetry.mjs";
import { canonicalizeUrl, validateUrl } from "./web-validation.mjs";

function pageValidation(page) {
  return {
    input_url: page.inputUrl,
    final_url: page.finalUrl,
    status: page.status,
    http_status: page.httpStatus,
    checked_at: page.checkedAt,
    redirect_chain: page.redirectChain ?? [],
    reason: null,
  };
}

function sameUrl(left, right) {
  const normalize = (value) => {
    const canonical = canonicalizeUrl(value);
    if (!canonical) return null;
    const parsed = new URL(canonical);
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.href;
  };
  return normalize(left) === normalize(right);
}

async function validateCandidateUrl(url, page, fetchImpl) {
  if (!url) return null;
  if (sameUrl(url, page.inputUrl) || sameUrl(url, page.finalUrl)) {
    return pageValidation(page);
  }
  return validateUrl(url, {
    fetchImpl,
    evidence: {
      sourceUrl: page.inputUrl,
      finalUrl: page.finalUrl,
      links: page.links,
    },
  });
}

function recordUrlFailure(metrics, kind, validation) {
  if (!validation || ["verified", "redirected"].includes(validation.status)) return;
  recordRejection(metrics, `${validation.reason ?? "URL_UNREACHABLE"}_${kind.toUpperCase()}`);
}

export async function processFetchedPage({
  page,
  title,
  sourceType,
  metrics,
  runId = null,
  operation = "extract",
  contentHash = null,
  fetchImpl = fetch,
  claimLlmCall = () => true,
}) {
  let rawItems;
  try {
    const deterministic = deterministicPageExtraction(page, { sourceType });
    if (deterministic.disposition === "complete") {
      rawItems = deterministic.records;
      incrementMetric(metrics, "deterministic", rawItems.length);
    } else {
      if (!claimLlmCall()) {
        const error = new Error("LLM run limit reached; deterministic extraction was ambiguous");
        error.code = "LLM_RUN_LIMIT";
        throw error;
      }
      incrementMetric(metrics, "llm_calls");
      rawItems = await extractOpportunities({
        url: page.finalUrl,
        title,
        text: page.text,
        links: page.links,
        runId,
        operation,
        contentHash,
      });
    }
  } catch (error) {
    const code = error.code ?? "PARSING_ERROR";
    recordRejection(metrics, code);
    const wrapped = new Error(`PARSING_ERROR: ${error.message}`);
    wrapped.code = code;
    wrapped.metricsRecorded = true;
    wrapped.cause = error;
    throw wrapped;
  }

  incrementMetric(metrics, "parsed", rawItems.length);
  if (!rawItems.length) {
    recordRejection(metrics, "NOT_RELEVANT");
    return [];
  }

  const normalized = [];
  for (const raw of rawItems) {
    try {
      normalized.push(normalizeOpportunity(raw, {
        sourceUrl: page.inputUrl,
        sourceFinalUrl: page.finalUrl,
        sourceLinks: page.links,
        sourceText: page.text,
        sourceTitle: title,
        sourceType,
        checkedAt: page.checkedAt,
      }));
      incrementMetric(metrics, "normalized");
    } catch (error) {
      const reason = error instanceof PipelineRejection
        ? error.code
        : "NORMALIZATION_ERROR";
      recordRejection(metrics, reason);
    }
  }

  const validated = await mapPool(
    normalized,
    config.urlValidationConcurrency,
    async (record) => {
      const source = pageValidation(page);
      const [official, application] = await Promise.all([
        validateCandidateUrl(record.official_url, page, fetchImpl),
        validateCandidateUrl(record.application_url, page, fetchImpl),
      ]);
      recordUrlFailure(metrics, "official_url", official);
      recordUrlFailure(metrics, "application_url", application);
      const result = applyUrlValidations(record, { source, official, application });
      incrementMetric(metrics, "validated");
      incrementMetric(metrics, "scored");
      return result;
    },
  );
  return validated;
}
