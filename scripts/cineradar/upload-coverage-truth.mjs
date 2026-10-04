// Owner's PC, once (and again whenever the datasets change): builds the
// coverage truth file from the local XLSX datasets and stores it in the
// private Supabase bucket, so the weekly coverage report runs in CI.
//
//   CINERADAR_SEED_DATASETS="a.xlsx;b.xlsx" node scripts/cineradar/upload-coverage-truth.mjs

import { buildTruthFromDatasets, ensurePrivateBucket, putPrivateJson, TRUTH_OBJECT } from "./coverage-truth.mjs";

const paths = String(process.env.CINERADAR_SEED_DATASETS ?? "").split(";").map((value) => value.trim()).filter(Boolean);
if (!paths.length) throw new Error("Set CINERADAR_SEED_DATASETS to the owner dataset XLSX paths");
const truth = await buildTruthFromDatasets(paths);
await ensurePrivateBucket();
await putPrivateJson(TRUTH_OBJECT, truth);
console.log(JSON.stringify({ stored: TRUTH_OBJECT, series: truth.entries.length, held_out: truth.entries.filter((entry) => entry.held_out).length }));
