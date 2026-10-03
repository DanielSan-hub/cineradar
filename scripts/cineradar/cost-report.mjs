import { config } from "./config.mjs";
import {
  getBudgetState, selectAllRows,
  projectConfiguredMonthlyCost,
} from "./cost-control.mjs";
import { assertSourceRegistrySchema, supabase } from "./supabase.mjs";

function monthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function daysInUtcMonth(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function main() {
  await assertSourceRegistrySchema();

  const now = new Date();
  const start = monthStart(now);
  const rows = await selectAllRows(
    `provider_usage_events?select=provider,operation,status,usage_units,reserved_cost_eur,estimated_cost_eur,occurred_at&occurred_at=gte.${encodeURIComponent(start.toISOString())}&order=occurred_at.asc,id.asc`,
  );
  const attempts = await selectAllRows(
    `discovery_attempts?select=attempt_kind,provider,query_family,source_id,request_count,candidate_count,validated_count,unique_opportunity_count,unique_source_count,false_positive_count,estimated_cost_eur&started_at=gte.${encodeURIComponent(start.toISOString())}&order=started_at.asc,id.asc`,
  );
  const budget = await getBudgetState(now);
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.provider}:${row.operation}`;
    const group = groups.get(key) ?? {
      provider: row.provider,
      operation: row.operation,
      events: 0,
      succeeded: 0,
      uncertain: 0,
      blocked: 0,
      searches: 0,
      input_tokens: 0,
      output_tokens: 0,
      neurons: 0,
      counted_cost_eur: 0,
    };
    group.events += 1;
    if (row.status === "succeeded") group.succeeded += 1;
    if (row.status === "uncertain") group.uncertain += 1;
    if (row.status === "blocked") group.blocked += 1;
    group.searches += finiteNonnegative(row.usage_units?.searches);
    group.input_tokens += finiteNonnegative(
      row.usage_units?.input_tokens ?? row.usage_units?.reserved_input_tokens,
    );
    group.output_tokens += finiteNonnegative(
      row.usage_units?.output_tokens ?? row.usage_units?.reserved_output_tokens,
    );
    group.neurons += finiteNonnegative(
      row.usage_units?.neurons ?? row.usage_units?.reserved_neurons,
    );
    if (["reserved", "succeeded", "uncertain"].includes(row.status)) {
      group.counted_cost_eur += finiteNonnegative(
        row.status === "reserved"
          ? row.reserved_cost_eur
          : row.estimated_cost_eur ?? row.reserved_cost_eur,
      );
    }
    groups.set(key, group);
  }

  const elapsedDays = Math.max(1, (now.getTime() - start.getTime()) / 86_400_000);
  const runRateDemand = budget.spendEur / elapsedDays * daysInUtcMonth(now);
  const exaRunRateDemand = budget.exaSpendEur / elapsedDays * daysInUtcMonth(now);
  const gapAttempts = attempts.filter((attempt) => attempt.attempt_kind === "gap-search");
  const totalOf = (items, field) => items.reduce((sum, item) =>
    sum + finiteNonnegative(item[field]), 0);
  const gapCost = totalOf(gapAttempts, "estimated_cost_eur");
  const gapQueries = totalOf(gapAttempts, "request_count");
  const gapValidated = totalOf(gapAttempts, "validated_count");
  const gapNewSources = totalOf(gapAttempts, "unique_source_count");
  const gapNewOpportunities = totalOf(gapAttempts, "unique_opportunity_count");
  const gapCandidates = totalOf(gapAttempts, "candidate_count");
  const gapFalsePositives = totalOf(gapAttempts, "false_positive_count");
  const report = {
    generated_at: now.toISOString(),
    ledger: {
      events: rows.length,
      month_to_date_cost_eur: Number((budget.spendEur + budget.exaSpendEur).toFixed(8)),
      core_pool_cost_eur: budget.spendEur,
      exa_pool: {
        month_to_date_cost_eur: budget.exaSpendEur,
        monthly_budget_eur: budget.exaBudgetEur,
        mode: budget.exaMode,
        current_run_rate_demand_eur: Number(exaRunRateDemand.toFixed(2)),
        current_run_rate_enforced_max_eur: Number(Math.min(exaRunRateDemand, budget.exaBudgetEur).toFixed(2)),
      },
      utilization: Number(budget.utilization.toFixed(4)),
      mode: budget.mode,
      monthly_budget_eur: budget.budgetEur,
      current_run_rate_demand_eur: Number(runRateDemand.toFixed(2)),
      current_run_rate_enforced_max_eur: Number(
        Math.min(runRateDemand, budget.budgetEur).toFixed(2),
      ),
      by_provider_operation: [...groups.values()].map((group) => ({
        ...group,
        counted_cost_eur: Number(group.counted_cost_eur.toFixed(8)),
      })),
    },
    configured_plan: [1, 2, 5, 10].map((multiplier) =>
      projectConfiguredMonthlyCost({ multiplier }),
    ),
    discovery_economics: {
      gap_queries: gapQueries,
      gap_candidate_urls: gapCandidates,
      gap_validated_opportunities: gapValidated,
      gap_new_opportunities: gapNewOpportunities,
      gap_new_sources: gapNewSources,
      gap_observed_false_positive_urls: gapFalsePositives,
      gap_estimated_cost_eur: Number(gapCost.toFixed(8)),
      unique_opportunities_per_100_queries: gapQueries
        ? Number((100 * gapNewOpportunities / gapQueries).toFixed(2)) : null,
      new_sources_per_100_queries: gapQueries
        ? Number((100 * gapNewSources / gapQueries).toFixed(2)) : null,
      cost_per_validated_opportunity_eur: gapValidated
        ? Number((gapCost / gapValidated).toFixed(6)) : null,
      cost_per_new_source_eur: gapNewSources
        ? Number((gapCost / gapNewSources).toFixed(6)) : null,
      observed_false_positive_url_rate: gapCandidates
        ? Number((gapFalsePositives / gapCandidates).toFixed(4)) : null,
      note: "Query attribution is primary-hit only; unprocessed candidates are not counted as false positives.",
    },
    safeguards: {
      target_3_eur: "reduce low-yield gap search and extraction ceilings",
      restrict_4_eur: "disable optional paid gap/fallback operations",
      hard_stop_5_eur: "deny paid reservations; HTTP, deterministic parsing and website continue",
      cash_cost_note: "ledger values are API estimates, not invoices; free credits, provider price changes and reservation overruns can make billed cash differ",
      all_in_budget_verified: false,
      costs_outside_ledger: ["Supabase plan", "ChatGPT Sites subscription", "other hosting", "scheduler overages"],
      usd_to_eur_rate: config.usdToEurRate,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
