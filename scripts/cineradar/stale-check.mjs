import { config } from "./config.mjs";
import {
  createRunMetrics,
  incrementMetric,
  metricsRunPatch,
  summarizeMetrics,
} from "./telemetry.mjs";
import {
  assertOperationalSchema,
  finishRun,
  startRun,
  supabase,
} from "./supabase.mjs";

const run = await startRun("stale");
const metrics = createRunMetrics("stale");

try {
  await assertOperationalSchema();
  const rows = await supabase(
    `opportunities?select=id,status,deadline,deadline_status,source_url_status,source_url_last_checked_at,official_url_status,application_url_status&order=updated_at.asc&limit=${config.staleCheckLimit}`,
  );
  incrementMetric(metrics, "discovered", rows.length);
  const now = Date.now();
  const uncheckedBefore = now - 90 * 24 * 60 * 60 * 1000;
  const confirmedDeadlinePast = rows.filter((row) =>
    row.deadline_status === "confirmed"
    && row.deadline
    && Date.parse(row.deadline) < now
    && row.status !== "closed",
  );
  const longUnchecked = rows.filter((row) =>
    !row.source_url_last_checked_at
    || Date.parse(row.source_url_last_checked_at) < uncheckedBefore,
  );
  const brokenLinks = rows.filter((row) =>
    [row.source_url_status, row.official_url_status, row.application_url_status]
      .some((status) => ["invalid", "unreachable"].includes(status)),
  );
  incrementMetric(
    metrics,
    "validated",
    confirmedDeadlinePast.length + longUnchecked.length + brokenLinks.length,
  );
  await finishRun(run.id, metricsRunPatch(metrics));
  console.log(JSON.stringify({
    status: "succeeded",
    checked: rows.length,
    review_only: true,
    auto_closed: 0,
    confirmed_deadline_past: confirmedDeadlinePast.length,
    unchecked_over_90_days: longUnchecked.length,
    broken_link_records: brokenLinks.length,
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
    console.error(`Unable to record failed stale check: ${finishError.message}`);
  }
  throw error;
}
