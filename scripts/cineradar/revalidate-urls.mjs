import { config } from "./config.mjs";
import { mapPool } from "./http.mjs";
import {
  createRunMetrics,
  incrementMetric,
  metricsRunPatch,
  recordRejection,
  summarizeMetrics,
} from "./telemetry.mjs";
import {
  assertOperationalSchema,
  finishRun,
  startRun,
  supabase,
} from "./supabase.mjs";
import { validateUrl } from "./web-validation.mjs";

const run = await startRun("revalidation");
const metrics = createRunMetrics("revalidation");

function valid(validation) {
  return validation && ["verified", "redirected"].includes(validation.status);
}

function validationPatch(kind, validation) {
  if (!validation) return {};
  return {
    [`${kind}_url_status`]: validation.status,
    [`${kind}_url_http_status`]: validation.http_status ?? null,
    [`${kind}_url_final`]: validation.final_url ?? null,
    [`${kind}_url_last_checked_at`]: validation.checked_at,
    [`${kind}_url_verified_at`]: valid(validation) ? validation.checked_at : null,
  };
}

try {
  await assertOperationalSchema();
  const rows = await supabase(
    `opportunities?select=id,source_url,official_url,application_url&order=source_url_last_checked_at.asc.nullsfirst,id.asc&limit=${config.revalidationLimit}`,
  );
  incrementMetric(metrics, "discovered", rows.length);
  const results = await mapPool(rows, config.urlValidationConcurrency, async (row) => {
    const [source, official, application] = await Promise.all([
      validateUrl(row.source_url),
      row.official_url ? validateUrl(row.official_url) : null,
      row.application_url ? validateUrl(row.application_url) : null,
    ]);
    const validations = { source, official, application };
    for (const [kind, validation] of Object.entries(validations)) {
      if (!validation) continue;
      incrementMetric(metrics, "validated");
      if (!valid(validation)) {
        recordRejection(
          metrics,
          `${validation.reason ?? "URL_UNREACHABLE"}_${kind.toUpperCase()}_URL`,
        );
      }
    }
    await supabase(`opportunities?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        ...validationPatch("source", source),
        ...validationPatch("official", official),
        ...validationPatch("application", application),
      }),
    });
    incrementMetric(metrics, "stored");
    return validations;
  });

  await finishRun(run.id, metricsRunPatch(metrics));
  console.log(JSON.stringify({
    status: "succeeded",
    opportunities_checked: rows.length,
    url_checks: results.reduce(
      (sum, item) => sum + Object.values(item).filter(Boolean).length,
      0,
    ),
    llm_calls: 0,
    ...summarizeMetrics(metrics),
  }));
} catch (error) {
  try {
    await finishRun(run.id, {
      ...metricsRunPatch(metrics, "failed"),
      error: String(error.message).slice(0, 1000),
    });
  } catch (finishError) {
    console.error(`Unable to record failed revalidation: ${finishError.message}`);
  }
  throw error;
}
