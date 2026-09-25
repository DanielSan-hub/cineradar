const COUNTERS = [
  "queries",
  "discovered",
  "fetched",
  "deterministic",
  "llm_calls",
  "parsed",
  "normalized",
  "validated",
  "scored",
  "duplicates",
  "rejected",
  "stored",
  "inserted",
  "updated",
  "unchanged",
];

export function createRunMetrics(kind) {
  return {
    kind,
    ...Object.fromEntries(COUNTERS.map((name) => [name, 0])),
    rejection_reasons: {},
  };
}

export function incrementMetric(metrics, name, amount = 1) {
  metrics[name] = Number(metrics[name] ?? 0) + amount;
  return metrics[name];
}

export function recordRejection(metrics, reason, amount = 1) {
  const code = String(reason || "UNKNOWN").toUpperCase();
  incrementMetric(metrics, "rejected", amount);
  metrics.rejection_reasons[code] =
    Number(metrics.rejection_reasons[code] ?? 0) + amount;
}

export function mergeMetrics(target, source) {
  for (const name of COUNTERS) {
    target[name] = Number(target[name] ?? 0) + Number(source[name] ?? 0);
  }
  for (const [reason, count] of Object.entries(source.rejection_reasons ?? {})) {
    target.rejection_reasons[reason] =
      Number(target.rejection_reasons[reason] ?? 0) + Number(count ?? 0);
  }
  return target;
}

export function summarizeMetrics(metrics) {
  return {
    kind: metrics.kind,
    ...Object.fromEntries(COUNTERS.map((name) => [name, Number(metrics[name] ?? 0)])),
    rejection_reasons: Object.fromEntries(
      Object.entries(metrics.rejection_reasons ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  };
}

export function metricsRunPatch(metrics, status = "succeeded") {
  const summary = summarizeMetrics(metrics);
  return {
    status,
    candidates: summary.discovered,
    records_written: summary.stored,
    discovered: summary.discovered,
    fetched: summary.fetched,
    parsed: summary.parsed,
    validated: summary.validated,
    duplicates: summary.duplicates,
    rejected: summary.rejected,
    stored: summary.stored,
    rejection_reasons: summary.rejection_reasons,
  };
}
