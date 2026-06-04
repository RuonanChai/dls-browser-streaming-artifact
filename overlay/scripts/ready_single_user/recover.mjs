#!/usr/bin/env node
/**
 * Agent recovery: read LOOP_STATUS + latest batch — no background task needed.
 *   node scripts/ready_single_user/recover.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINI_PHASE_ORDER, MAIN_PHASE_ORDER } from "./gates.mjs";
import { PAPER_MATERIALS_DIR } from "./constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, PAPER_MATERIALS_DIR);

async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function latestBatchDir(prefix) {
  const runsDir = path.join(outDir, "runs");
  const names = await fs.readdir(runsDir);
  const matches = names
    .filter((n) => n.startsWith(prefix))
    .sort()
    .reverse();
  return matches[0] ? path.join(runsDir, matches[0]) : null;
}

async function main() {
  const loop = await readJson(path.join(outDir, "LOOP_STATUS.json"), {});
  const progress = await readJson(path.join(outDir, "mini_progress.json"), { phases: {}, main: {} });

  console.log("=== READY recover (for agent) ===\n");
  console.log("LOOP_STATUS:", JSON.stringify(loop, null, 2));
  console.log("\nmini_progress:", JSON.stringify(progress, null, 2));

  const batchDir = loop.batchDir || (await latestBatchDir("mini_"));
  if (batchDir) {
    const manifest = await readJson(path.join(batchDir, "manifest.json"), { trials: [] });
    const completed = manifest.trials?.filter((t) => t.status === "completed").length ?? 0;
    const failed = manifest.trials?.filter((t) => t.status === "failed").length ?? 0;
    let jsonCount = 0;
    try {
      const j = await fs.readdir(path.join(batchDir, "per_trial_json"));
      jsonCount = j.filter((f) => f.endsWith(".json")).length;
    } catch { /* */ }
    console.log(`\nBatch: ${batchDir}`);
    console.log(`  trials completed=${completed} failed=${failed} per_trial_json=${jsonCount}`);
    const runLog = path.join(batchDir, "run.log");
    try {
      const tail = (await fs.readFile(runLog, "utf8")).split("\n").slice(-15).join("\n");
      console.log("\nrun.log (last 15 lines):\n", tail);
    } catch {
      console.log("\nrun.log: missing");
    }
  }

  const phase = loop.phase || MINI_PHASE_ORDER.find((p) => progress.phases[p]?.status !== "PASS");
  const gate = loop.gate_color || progress.phases[phase]?.gate_color;
  const fix = loop.fix_categories || progress.phases[phase]?.fix_categories || [];
  let runLogText = "";
  if (batchDir) {
    try {
      runLogText = await fs.readFile(path.join(batchDir, "run.log"), "utf8");
    } catch { /* */ }
  }
  const userDataDirBug = /userDataDir option is not supported/i.test(runLogText);

  console.log("\n--- NEXT COMMAND ---");
  if (userDataDirBug) {
    console.log("# Fixed in local_stutter_ablation_cell.mjs (launchPersistentContext) — pull latest and rerun:");
    console.log(`node scripts/ready_single_user/mini_loop.mjs --phase=${phase || "phase_local_ceiling"}`);
  } else if (loop.state === "running") {
    console.log("Still running — poll: node scripts/ready_single_user/recover.mjs");
    console.log("Or read:", path.join(outDir, "LOOP_STATUS.json"));
  } else if (loop.state === "done") {
    console.log("Pipeline done. Read AUTOPILOT_SUMMARY.md");
  } else if (fix.includes("infra_metrics_instrumentation") || /EADDRINUSE/i.test(loop.last_error || "")) {
    console.log("npm run ready:single:cleanupPorts");
    console.log(`node scripts/ready_single_user/mini_loop.mjs --phase=${phase || "phase_local_ceiling"}`);
  } else if (gate === "GREEN" || gate === "YELLOW" || progress.phases[phase]?.status === "PASS") {
    const idx = MINI_PHASE_ORDER.indexOf(phase);
    const next = idx >= 0 ? MINI_PHASE_ORDER[idx + 1] : null;
    if (next) {
      console.log(`node scripts/ready_single_user/mini_loop.mjs --phase=${next}`);
    } else {
      console.log("npm run ready:single:miniLoop   # mini complete → main n=5");
    }
  } else {
    console.log(`node scripts/ready_single_user/mini_loop.mjs --phase=${phase || "phase_local_ceiling"}`);
    console.log("fix_categories:", fix.join(", ") || "see claim_guard + run.log");
  }
  console.log("\nNEVER use background shell for mini_loop — run foreground only.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
