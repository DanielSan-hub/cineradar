import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  extractGoldenBenchmarkRows,
  inventoryBenchmarkWorkbook,
} from "../scripts/cineradar/benchmark.mjs";
import {
  buildBenchmarkReport,
  deterministicBenchmarkSplit,
  matchBenchmarkRows,
} from "../scripts/cineradar/benchmark-matching.mjs";
import { readXlsxBuffer } from "../scripts/cineradar/xlsx-reader.mjs";

const workbookPath = process.env.CINERADAR_BENCHMARK_WORKBOOK
  ?? "C:/Users/Utente/Downloads/Film_Opportunities_DeepResearch_RECOVERY_2026-09-23(1)(1).xlsx";

const columns = [
  "benchmark_id",
  "canonical_name",
  "category",
  "geography",
  "call_year",
  "edition_year",
  "source_url",
  "discovery_tier",
];

function goldenRow(id, title, overrides = {}) {
  return {
    benchmark_id: id,
    canonical_name: title,
    category: "Film festival",
    geography: "Europe",
    call_year: 2026,
    edition_year: 2026,
    source_url: "https://filmfreeway.com/shared-submissions",
    discovery_tier: "CORE",
    ...overrides,
  };
}

function syntheticWorkbook(dataRows = [goldenRow("GBV1-001", "Aurora Film Festival")]) {
  const rows = [
    { number: 1, values: columns },
    ...dataRows.map((row, index) => ({
      number: index + 2,
      values: columns.map((column) => row[column] ?? null),
    })),
  ];
  const sheetNames = [
    "Benchmark_Items",
    "Historical_AI_Metrics",
    "Coverage_Envelope",
    "CineRadar_Baseline",
    "DR_Recovery_README",
  ];
  return {
    sheetNames,
    sheets: sheetNames.map((name) => ({
      name,
      rows: name === "Benchmark_Items" ? rows : [],
    })),
  };
}

test("the supplied workbook parses as the 117-item golden benchmark", async (context) => {
  let bytes;
  try {
    bytes = await readFile(workbookPath);
  } catch (error) {
    if (error.code === "ENOENT" && !process.env.CINERADAR_BENCHMARK_WORKBOOK) {
      context.skip("The user-supplied workbook is not available on this machine");
      return;
    }
    throw error;
  }

  const workbook = readXlsxBuffer(bytes);
  const rows = extractGoldenBenchmarkRows(workbook);
  const inventory = inventoryBenchmarkWorkbook(workbook);
  const tierCounts = Object.fromEntries(
    [...new Set(rows.map((row) => row.discovery_tier))]
      .map((tier) => [tier, rows.filter((row) => row.discovery_tier === tier).length]),
  );

  assert.equal(inventory.parsed_all_sheets, true);
  assert.equal(inventory.sheet_count, 18);
  assert.equal(inventory.deep_research_and_recovery.length, 12);
  assert.ok(Object.values(inventory.required).every(Boolean));
  assert.equal(rows.length, 117);
  assert.equal(new Set(rows.map((row) => row.benchmark_id)).size, 117);
  assert.deepEqual(tierCounts, {
    LONG_TAIL: 66,
    CORE: 22,
    MAINSTREAM: 6,
    HIDDEN: 23,
  });

  const options = { holdoutRatio: 0.2, salt: "benchmark-regression-salt" };
  const split = rows.map((row) => deterministicBenchmarkSplit(row, options));
  const reorderedSplit = new Map(
    [...rows].reverse().map((row) => [row.benchmark_id, deterministicBenchmarkSplit(row, options)]),
  );
  assert.ok(rows.every((row, index) => split[index] === reorderedSplit.get(row.benchmark_id)));
  assert.ok(split.includes("train"));
  assert.ok(split.includes("holdout"));
  assert.ok(rows.some((row, index) => split[index] !== deterministicBenchmarkSplit(row, {
    ...options,
    salt: "different-salt",
  })));

  const report = buildBenchmarkReport(rows, [], options);
  assert.equal(report.benchmark.rows, 117);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.recall.by_tier).map(([tier, value]) => [tier, value.total])),
    { CORE: 22, HIDDEN: 23, LONG_TAIL: 66, MAINSTREAM: 6 },
  );
  assert.equal(report.benchmark.split.train.total, split.filter((label) => label === "train").length);
  assert.equal(report.benchmark.split.holdout.total, split.filter((label) => label === "holdout").length);
  assert.equal(report.recall.overall.matched, 0);
  assert.equal(report.matching.missed.length, 117);
});

test("a shared submission URL credits only the item with matching identity", () => {
  const rows = [
    goldenRow("GBV1-001", "Aurora Film Festival"),
    goldenRow("GBV1-002", "Borealis Film Festival"),
  ];
  const records = [{
    id: "discovered-aurora",
    title: "Aurora Film Festival",
    category: "Film festival",
    location: "Europe",
    call_year: 2026,
    edition_year: 2026,
    source_url: "https://filmfreeway.com/shared-submissions?utm_source=search",
  }];

  const result = matchBenchmarkRows(rows, records);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].benchmark.id, "GBV1-001");
  assert.equal(result.matches[0].record.id, "discovered-aurora");
  assert.equal(result.matches[0].method, "canonical_url");
  assert.deepEqual(result.misses.map((miss) => miss.benchmark.id), ["GBV1-002"]);
});

test("an indistinguishable shared-URL record is left unmatched", () => {
  const rows = [
    goldenRow("GBV1-001", "Aurora Film Festival"),
    goldenRow("GBV1-002", "Borealis Film Festival"),
  ];
  const records = [{
    id: "generic-platform-result",
    title: "Open film submissions",
    call_year: 2026,
    edition_year: 2026,
    source_url: "https://filmfreeway.com/shared-submissions",
  }];

  const result = matchBenchmarkRows(rows, records);
  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.ambiguous_record_ids, ["generic-platform-result"]);
  assert.equal(result.misses.length, 2);
});

test("a shared-platform URL alone does not establish opportunity identity", () => {
  const rows = [goldenRow("GBV1-001", "Aurora Film Festival", {
    organizer: "Aurora Arts",
  })];
  const records = [{
    id: "different-festival",
    title: "Borealis Film Festival",
    organizer: "Borealis Arts",
    call_year: 2026,
    edition_year: 2026,
    source_url: "https://filmfreeway.com/shared-submissions",
  }];

  const result = matchBenchmarkRows(rows, records);
  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.misses.map((miss) => miss.benchmark.id), ["GBV1-001"]);
});

test("an identical series and URL from a different edition cannot count", () => {
  const rows = [
    goldenRow("GBV1-2025", "Aurora Film Festival", { call_year: 2025, edition_year: 2025 }),
    goldenRow("GBV1-2026", "Aurora Film Festival"),
  ];
  const records = [{
    id: "current-edition",
    title: "Aurora Film Festival",
    call_year: 2026,
    edition_year: 2026,
    source_url: "https://filmfreeway.com/shared-submissions",
  }];

  const result = matchBenchmarkRows(rows, records);
  assert.deepEqual(result.matches.map((match) => match.benchmark.id), ["GBV1-2026"]);
  assert.deepEqual(result.misses.map((miss) => miss.benchmark.id), ["GBV1-2025"]);
  assert.equal(result.candidate_count, 1);
});

test("malformed benchmark inputs fail with actionable errors", () => {
  assert.throws(
    () => readXlsxBuffer(Buffer.from("not an XLSX")),
    /Malformed XLSX: expected a ZIP-based workbook/,
  );

  const missingSheet = syntheticWorkbook();
  missingSheet.sheets = missingSheet.sheets.filter((sheet) => sheet.name !== "Coverage_Envelope");
  missingSheet.sheetNames = missingSheet.sheets.map((sheet) => sheet.name);
  assert.throws(() => extractGoldenBenchmarkRows(missingSheet), /missing sheets Coverage_Envelope/);

  const missingColumn = syntheticWorkbook();
  missingColumn.sheets[0].rows[0].values = columns.filter((column) => column !== "discovery_tier");
  assert.throws(() => extractGoldenBenchmarkRows(missingColumn), /missing columns discovery_tier/);

  const duplicateIds = syntheticWorkbook([
    goldenRow("GBV1-001", "Aurora Film Festival"),
    goldenRow("GBV1-001", "Borealis Film Festival"),
  ]);
  assert.throws(() => extractGoldenBenchmarkRows(duplicateIds), /duplicate or empty benchmark_id GBV1-001/);

  const invalidTier = syntheticWorkbook([
    goldenRow("GBV1-001", "Aurora Film Festival", { discovery_tier: "UNKNOWN" }),
  ]);
  assert.throws(() => extractGoldenBenchmarkRows(invalidTier), /invalid discovery_tier UNKNOWN/);
});
