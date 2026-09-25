import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import {
  BENCHMARK_TIERS,
  buildBenchmarkReport,
} from "./benchmark-matching.mjs";
import {
  getSheet,
  readXlsxBuffer,
  sheetToObjects,
} from "./xlsx-reader.mjs";

const REQUIRED_SHEETS = [
  "Benchmark_Items",
  "Historical_AI_Metrics",
  "Coverage_Envelope",
  "CineRadar_Baseline",
];
const BENCHMARK_COLUMNS = [
  "benchmark_id",
  "canonical_name",
  "category",
  "geography",
  "call_year",
  "edition_year",
  "source_url",
  "discovery_tier",
];

function usage() {
  return [
    "Usage: node scripts/cineradar/benchmark.mjs [workbook.xlsx] [options]",
    "",
    "Options:",
    "  --workbook, --path <file>  Benchmark workbook (or CINERADAR_BENCHMARK_WORKBOOK)",
    "  --records <file|->         Discovered records JSON; omit to read live Supabase",
    "  --holdout-ratio <0..1)     Deterministic holdout ratio (default: 0.2)",
    "  --salt <text>              Deterministic split salt",
    "  --help                     Show this message",
  ].join("\n");
}

function optionValue(argv, index, inlineValue) {
  if (inlineValue !== undefined) return { value: inlineValue, next: index };
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new Error(`Missing value for ${argv[index]}`);
  }
  return { value: argv[index + 1], next: index + 1 };
}

export function parseBenchmarkArgs(argv, environment = process.env) {
  const options = {
    workbookPath: environment.CINERADAR_BENCHMARK_WORKBOOK ?? null,
    recordsPath: null,
    holdoutRatio: 0.2,
    salt: "cineradar-benchmark-v1",
    help: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const [flag, inlineValue] = argument.split(/=(.*)/s, 2);
    if (["--workbook", "--path", "--records", "--holdout-ratio", "--salt"].includes(flag)) {
      const parsed = optionValue(argv, index, inlineValue);
      index = parsed.next;
      if (flag === "--workbook" || flag === "--path") options.workbookPath = parsed.value;
      if (flag === "--records") options.recordsPath = parsed.value;
      if (flag === "--holdout-ratio") options.holdoutRatio = Number(parsed.value);
      if (flag === "--salt") options.salt = parsed.value;
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }
  if (positional.length > 1) throw new Error("Only one positional workbook path is accepted");
  if (positional.length) {
    if (options.workbookPath && environment.CINERADAR_BENCHMARK_WORKBOOK) {
      options.workbookPath = positional[0];
    } else if (options.workbookPath) {
      throw new Error("Specify the workbook only once");
    } else {
      options.workbookPath = positional[0];
    }
  }
  if (!options.help && !options.workbookPath) {
    throw new Error("Missing benchmark workbook; use --workbook, --path, a positional path, or CINERADAR_BENCHMARK_WORKBOOK");
  }
  if (!(options.holdoutRatio >= 0 && options.holdoutRatio < 1)) {
    throw new Error("--holdout-ratio must be at least 0 and less than 1");
  }
  if (!String(options.salt).trim()) throw new Error("--salt cannot be empty");
  return options;
}

function nonemptyValues(row) {
  return row.values.filter((value) => value !== null && value !== undefined && value !== "");
}

function sheetInventory(sheet) {
  const nonemptyRows = sheet.rows.filter((row) => nonemptyValues(row).length > 0);
  const header = [...nonemptyRows.slice(0, 5)]
    .sort((left, right) => nonemptyValues(right).length - nonemptyValues(left).length)[0];
  return {
    name: sheet.name,
    parsed_rows: sheet.rows.length,
    nonempty_rows: nonemptyRows.length,
    nonempty_cells: nonemptyRows.reduce((sum, row) => sum + nonemptyValues(row).length, 0),
    detected_header_row: header?.number ?? null,
    detected_columns: header ? nonemptyValues(header).map((value) => String(value)) : [],
  };
}

export function inventoryBenchmarkWorkbook(workbook) {
  const allSheets = workbook.sheets.map(sheetInventory);
  const byName = new Map(allSheets.map((sheet) => [sheet.name, sheet]));
  return {
    parsed_all_sheets: true,
    sheet_count: allSheets.length,
    all_sheets: allSheets,
    required: Object.fromEntries(REQUIRED_SHEETS.map((name) => [name, byName.get(name) ?? null])),
    deep_research_and_recovery: allSheets.filter((sheet) => /^DR_/i.test(sheet.name)),
  };
}

function assertRequiredSheets(workbook) {
  const missing = REQUIRED_SHEETS.filter((name) => !getSheet(workbook, name));
  if (missing.length) throw new Error(`Malformed benchmark workbook: missing sheets ${missing.join(", ")}`);
  const recoverySheets = workbook.sheetNames.filter((name) => /^DR_/i.test(name));
  if (!recoverySheets.length) {
    throw new Error("Malformed benchmark workbook: no DR/recovery sheets found");
  }
}

export function extractGoldenBenchmarkRows(workbook) {
  assertRequiredSheets(workbook);
  const sheet = getSheet(workbook, "Benchmark_Items");
  const header = sheet.rows.find((row) => nonemptyValues(row).includes("benchmark_id"));
  if (!header) throw new Error("Malformed Benchmark_Items: benchmark_id header not found");
  const headerNames = new Set(nonemptyValues(header).map(String));
  const missingColumns = BENCHMARK_COLUMNS.filter((name) => !headerNames.has(name));
  if (missingColumns.length) {
    throw new Error(`Malformed Benchmark_Items: missing columns ${missingColumns.join(", ")}`);
  }
  const rows = sheetToObjects(sheet, { headerRow: header.number })
    .filter((row) => /^GBV/i.test(String(row.benchmark_id ?? "")));
  if (!rows.length) throw new Error("Malformed Benchmark_Items: no golden benchmark rows found");

  const ids = new Set();
  for (const row of rows) {
    const id = String(row.benchmark_id ?? "").trim();
    if (!id || ids.has(id)) throw new Error(`Malformed Benchmark_Items: duplicate or empty benchmark_id ${id}`);
    ids.add(id);
    if (!String(row.canonical_name ?? "").trim()) {
      throw new Error(`Malformed Benchmark_Items: ${id} has no canonical_name`);
    }
    const tier = String(row.discovery_tier ?? "").trim().toUpperCase();
    if (!BENCHMARK_TIERS.includes(tier)) {
      throw new Error(`Malformed Benchmark_Items: ${id} has invalid discovery_tier ${tier || "(empty)"}`);
    }
  }
  return rows;
}

function recordsFromJson(value) {
  const records = Array.isArray(value)
    ? value
    : value?.opportunities ?? value?.records ?? value?.data;
  if (!Array.isArray(records)) {
    throw new Error("Malformed records JSON: expected an array or an object with opportunities/records/data array");
  }
  if (records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error("Malformed records JSON: every record must be an object");
  }
  return records;
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function readRecordsFile(path) {
  const text = path === "-" ? await readStandardInput() : await readFile(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed records JSON: ${error.message}`, { cause: error });
  }
  return recordsFromJson(parsed);
}

export async function fetchLiveOpportunityRecords({ pageSize = 1000 } = {}) {
  const { supabase } = await import("./supabase.mjs");
  const records = [];
  for (let offset = 0; ; offset += pageSize) {
    const parameters = new URLSearchParams({
      select: "*",
      order: "id.asc",
      limit: String(pageSize),
      offset: String(offset),
    });
    const page = await supabase(`opportunities?${parameters.toString()}`);
    if (!Array.isArray(page)) throw new Error("Live Supabase opportunities response was not an array");
    records.push(...page);
    if (page.length < pageSize) break;
  }
  return records;
}

export async function runBenchmark(options) {
  const workbookPath = resolve(options.workbookPath);
  const workbookBytes = await readFile(workbookPath);
  const workbook = readXlsxBuffer(workbookBytes);
  const goldenRows = extractGoldenBenchmarkRows(workbook);
  const records = options.recordsPath
    ? await readRecordsFile(options.recordsPath === "-" ? "-" : resolve(options.recordsPath))
    : await fetchLiveOpportunityRecords();
  const result = buildBenchmarkReport(goldenRows, records, {
    holdoutRatio: options.holdoutRatio,
    salt: options.salt,
  });
  return {
    ...result,
    input: {
      workbook_file: basename(workbookPath),
      workbook_sha256: createHash("sha256").update(workbookBytes).digest("hex"),
      records_source: options.recordsPath ? "json_file" : "live_supabase",
      records_file: options.recordsPath && options.recordsPath !== "-"
        ? basename(options.recordsPath)
        : (options.recordsPath === "-" ? "stdin" : null),
    },
    workbook_inventory: inventoryBenchmarkWorkbook(workbook),
  };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseBenchmarkArgs(argv, environment);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const result = await runBenchmark(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: "BENCHMARK_INPUT_ERROR",
      message: error.message,
    })}\n`);
    process.exitCode = 2;
  });
}
