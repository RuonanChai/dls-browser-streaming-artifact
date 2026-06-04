#!/usr/bin/env node
/**
 * P0-1 sanity test: verify methodFlags() routes each baseline correctly.
 * Loads ready_core.js as text and evaluates methodFlags in a sandboxed context.
 *
 * Pass criteria: each baseline's flag combination matches Todolist.md spec.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CORE_PATH = path.join(PROJECT_ROOT, "scripts/lib/ready/ready_core.js");

// Expected mechanism flags per baseline (Todolist.md mechanism table)
const EXPECTED = {
  "B0": { // Spark-OD
    isSparkOd: true,
    useBootSet: false,
    useMotionPrediction: false,
    useContinuousScheduling: false,
    usePredecode: false,
    useSessionPrediction: false,
    useReadyController: false,
  },
  "B1": { // Naive-PF
    isNaive: true,
    useBootSet: false,
    useMotionPrediction: false,
    useContinuousScheduling: false,
    usePredecode: false,
    useSessionPrediction: false,
    useReadyController: false,
  },
  "READY-B": { // boot + predecode, one-shot
    isReadyB: true,
    useBootSet: true,
    useMotionPrediction: false,
    useContinuousScheduling: false,
    usePredecode: true,
    useSessionPrediction: false,
    useReadyController: true,
  },
  "READY-P": { // prediction only, no predecode
    isReadyP: true,
    useBootSet: true,
    useMotionPrediction: true,
    useContinuousScheduling: false,
    usePredecode: false,
    useSessionPrediction: false,
    useReadyController: true,
  },
  "READY-C": { // prediction + continuous, no predecode
    isReadyC: true,
    useBootSet: true,
    useMotionPrediction: true,
    useContinuousScheduling: true,
    usePredecode: false,
    useSessionPrediction: false,
    useReadyController: true,
  },
  "READY-R": { // prediction + predecode, one-shot
    isReadyR: true,
    useBootSet: true,
    useMotionPrediction: true,
    useContinuousScheduling: false,
    usePredecode: true,
    useSessionPrediction: false,
    useReadyController: true,
  },
  "READY": { // full: boot + predict + continuous + predecode, NO session prior
    isReadyFull: true,
    useBootSet: true,
    useMotionPrediction: true,
    useContinuousScheduling: true,
    usePredecode: true,
    useSessionPrediction: false,
    useReadyController: true,
  },
  "READY-S": { // full + session prior (appendix)
    isReadyS: true,
    useBootSet: true,
    useMotionPrediction: true,
    useContinuousScheduling: true,
    usePredecode: true,
    useSessionPrediction: true,
    useReadyController: true,
  },
};

async function loadMethodFlags() {
  const code = await fs.readFile(CORE_PATH, "utf8");
  // Build a sandbox that captures __readyCore on a fake window
  const sandbox = {
    window: { __readyCore: null },
    location: { search: "" },
    URLSearchParams: globalThis.URLSearchParams,
    performance: { now: () => 0 },
    Number,
    Math,
    String,
  };
  // Simulate browser globals the IIFE expects
  sandbox.window = sandbox; // some code uses bare `window` references via closure
  // Also expose URLSearchParams/location at top level
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__readyCore?.methodFlags;
}

function check(actual, expected, baseline) {
  const failures = [];
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) {
      failures.push(`  ${baseline}.${k}: expected=${v} actual=${actual[k]}`);
    }
  }
  return failures;
}

async function main() {
  const methodFlags = await loadMethodFlags();
  if (!methodFlags) {
    console.error("FATAL: methodFlags not exported by ready_core.js");
    process.exit(1);
  }

  let total = 0;
  let passed = 0;
  const allFailures = [];

  for (const [code, expected] of Object.entries(EXPECTED)) {
    total += 1;
    const actual = methodFlags(code);
    const failures = check(actual, expected, code);
    if (failures.length === 0) {
      passed += 1;
      console.log(`✓ ${code}`);
    } else {
      console.log(`✗ ${code}`);
      for (const f of failures) console.log(f);
      allFailures.push(...failures);
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`SANITY: ${passed}/${total} baselines pass mechanism check`);
  console.log(`${"=".repeat(50)}`);
  if (passed !== total) {
    console.log(`\nFailures:`);
    for (const f of allFailures) console.log(f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
