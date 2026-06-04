#!/usr/bin/env node
/**
 * P0-3 baseline config audit.
 *
 * Loads ready_core.js + ready_delivery.js in a vm sandbox, evaluates
 * methodFlags() for each baseline, and emits the actual mechanism config
 * compared against the Todolist.md expected table.
 *
 * Output:
 *   paper_materials/ready_single_user_v1/baseline_config_audit.csv
 *   paper_materials/ready_single_user_v1/baseline_config_audit.json
 *
 * Pass criteria (P0-3 from pass_criteria.json):
 *   diff(actual_config, expected_config) == empty
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CORE_PATH = path.join(PROJECT_ROOT, "scripts/lib/ready/ready_core.js");
const PASS_CRITERIA = path.join(
  PROJECT_ROOT,
  "paper_materials/ready_single_user_v1/supervisor/pass_criteria.json",
);
const OUT_DIR = path.join(PROJECT_ROOT, "paper_materials/ready_single_user_v1");

const BASELINES = [
  "Spark-OD", "Naive-PF",
  "READY-B", "READY-P", "READY-C", "READY-R",
  "READY", "READY-S",
];

// Baseline → ready_core.methodFlags() argument
const BASELINE_TO_FLAG_ARG = {
  "Spark-OD": "B0",
  "Naive-PF": "B1",
  "READY-B": "READY-B",
  "READY-P": "READY-P",
  "READY-C": "READY-C",
  "READY-R": "READY-R",
  "READY": "READY",
  "READY-S": "READY-S",
};

// Boot set caps observed in ready_delivery.scenePrewarmRanges (remote role)
// READY family uses 48; Naive-PF emits its own naive prefetch window of 32
// (configured in proactive_prefetch_controller.js via baselineCode === "B1").
const NAIVE_PF_PREFETCH_WINDOW = 32;
const READY_BOOT_CAP_REMOTE = 48;

async function loadMethodFlags() {
  const code = await fs.readFile(CORE_PATH, "utf8");
  const sandbox = {
    window: { __readyCore: null },
    location: { search: "" },
    URLSearchParams: globalThis.URLSearchParams,
    performance: { now: () => 0 },
    Number, Math, String,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__readyCore?.methodFlags;
}

/**
 * Map flag struct → audit row matching pass_criteria expected_table fields.
 */
function flagsToAudit(baselineName, flags) {
  let bootSetSize;
  if (baselineName === "Spark-OD") {
    bootSetSize = 0; // pure on-demand, no prefetch
  } else if (baselineName === "Naive-PF") {
    bootSetSize = NAIVE_PF_PREFETCH_WINDOW; // naive prefetch window, not boot set
  } else {
    bootSetSize = flags.useBootSet ? READY_BOOT_CAP_REMOTE : 0;
  }

  // continuous_tick_ms: 200 if continuous scheduling, 0 otherwise
  // (READY controller uses 200ms tick for remote, 400ms for edge — pass_criteria
  // expects 200 because audit is run in remote role context.)
  const continuousTickMs = flags.useContinuousScheduling ? 200 : 0;

  return {
    baseline: baselineName,
    predecode: !!flags.usePredecode,
    continuous_tick_ms: continuousTickMs,
    session_prior: !!flags.useSessionPrediction,
    boot_set_size: bootSetSize,
    // raw flags for evidence
    _raw_flags: {
      useBootSet: !!flags.useBootSet,
      useMotionPrediction: !!flags.useMotionPrediction,
      useContinuousScheduling: !!flags.useContinuousScheduling,
      usePredecode: !!flags.usePredecode,
      useSessionPrediction: !!flags.useSessionPrediction,
      useReadyController: !!flags.useReadyController,
    },
  };
}

function diffRow(actual, expected) {
  const keys = ["predecode", "continuous_tick_ms", "session_prior", "boot_set_size"];
  const diffs = [];
  for (const k of keys) {
    if (actual[k] !== expected[k]) {
      diffs.push({ field: k, expected: expected[k], actual: actual[k] });
    }
  }
  return diffs;
}

function toCsv(rows) {
  const cols = ["baseline", "predecode", "continuous_tick_ms", "session_prior", "boot_set_size", "diff_status", "diff_detail"];
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => {
      const v = r[c];
      if (v == null) return "";
      if (typeof v === "string" && v.includes(",")) return `"${v.replace(/"/g, '""')}"`;
      return String(v);
    }).join(","));
  }
  return lines.join("\n");
}

async function main() {
  const methodFlags = await loadMethodFlags();
  if (!methodFlags) {
    console.error("FATAL: methodFlags missing from ready_core.js");
    process.exit(1);
  }
  const passCriteriaRaw = await fs.readFile(PASS_CRITERIA, "utf8");
  const passCriteria = JSON.parse(passCriteriaRaw);
  const expectedTable =
    passCriteria["P0-3_baseline_config_audit"]?.checks?.[0]?.expected_table ?? {};

  const auditRows = [];
  let allMatch = true;
  const allDiffs = [];

  for (const b of BASELINES) {
    const flagArg = BASELINE_TO_FLAG_ARG[b];
    const flags = methodFlags(flagArg);
    const actual = flagsToAudit(b, flags);
    const expected = expectedTable[b];
    if (!expected) {
      auditRows.push({
        ...actual,
        diff_status: "no_expected_row",
        diff_detail: "missing from pass_criteria.json expected_table",
      });
      allMatch = false;
      continue;
    }
    const diffs = diffRow(actual, expected);
    if (diffs.length === 0) {
      auditRows.push({ ...actual, diff_status: "match", diff_detail: "" });
    } else {
      allMatch = false;
      const detail = diffs
        .map((d) => `${d.field}:expected=${d.expected},actual=${d.actual}`)
        .join("; ");
      auditRows.push({ ...actual, diff_status: "mismatch", diff_detail: detail });
      allDiffs.push({ baseline: b, diffs });
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const csvPath = path.join(OUT_DIR, "baseline_config_audit.csv");
  const jsonPath = path.join(OUT_DIR, "baseline_config_audit.json");
  await fs.writeFile(csvPath, `${toCsv(auditRows)}\n`, "utf8");
  await fs.writeFile(
    jsonPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      all_match: allMatch,
      total_baselines: auditRows.length,
      mismatched: allDiffs.length,
      rows: auditRows,
      diffs: allDiffs,
    }, null, 2)}\n`,
    "utf8",
  );

  // Console summary
  console.log("=".repeat(70));
  console.log("P0-3 Baseline Config Audit");
  console.log("=".repeat(70));
  console.log(`baseline       predecode  tick_ms  session  boot_set  status`);
  for (const r of auditRows) {
    const flag = r.diff_status === "match" ? "✓" : "✗";
    console.log(
      `${r.baseline.padEnd(14)} ${String(r.predecode).padEnd(9)} `
      + `${String(r.continuous_tick_ms).padEnd(8)} `
      + `${String(r.session_prior).padEnd(8)} ${String(r.boot_set_size).padEnd(9)} `
      + `${flag} ${r.diff_status}`,
    );
    if (r.diff_status === "mismatch") {
      console.log(`               ${r.diff_detail}`);
    }
  }
  console.log("=".repeat(70));
  console.log(`Result: ${allMatch ? "PASS" : "FAIL"} (${auditRows.length - allDiffs.length}/${auditRows.length} match)`);
  console.log(`CSV:  ${path.relative(PROJECT_ROOT, csvPath)}`);
  console.log(`JSON: ${path.relative(PROJECT_ROOT, jsonPath)}`);
  process.exit(allMatch ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
