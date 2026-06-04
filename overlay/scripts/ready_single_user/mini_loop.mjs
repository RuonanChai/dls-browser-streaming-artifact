#!/usr/bin/env node
/**
 * READY autopilot with agent-safe status files (recover without background TaskOutput).
 *
 *   npm run ready:single:miniLoop          # foreground — agent MUST NOT background this
 *   node scripts/ready_single_user/recover.mjs   # poll if unsure
 *   node scripts/ready_single_user/mini_loop.mjs --phase=phase_edge_cold
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MAIN_PHASE_ORDER,
  MINI_PHASE_ORDER,
  suggestMiniFixCategory,
} from "./gates.mjs";
import { PAPER_MATERIALS_DIR } from "./constants.mjs";
import { isRemotePhase } from "./remote_stats.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, PAPER_MATERIALS_DIR);
const LOOP_STATUS_PATH = path.join(outDir, "LOOP_STATUS.json");

function parseArgs(argv) {
  const o = {
    phase: null,
    dryRun: false,
    miniOnly: false,
    mainOnly: false,
    maxPhaseRetries: 8,
    mainTrials: 5,
  };
  for (const a of argv) {
    if (a.startsWith("--phase=")) o.phase = a.slice(8);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--mini-only") o.miniOnly = true;
    else if (a === "--main-only") o.mainOnly = true;
    else if (a.startsWith("--maxRetries=")) o.maxPhaseRetries = Number(a.slice(13)) || 8;
    else if (a.startsWith("--mainTrials=")) o.mainTrials = Number(a.slice(13)) || 5;
  }
  return o;
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function writeLoopStatus(patch) {
  let cur = {};
  try {
    cur = JSON.parse(await fs.readFile(LOOP_STATUS_PATH, "utf8"));
  } catch { /* */ }
  const next = {
    ...cur,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(LOOP_STATUS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function runNode(script, args) {
  const r = spawnSync("node", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return { ok: r.status === 0, out, code: r.status ?? 1 };
}

async function appendLog(filePath, chunk) {
  await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
  await fs.appendFile(filePath, chunk, "utf8").catch(() => {});
}

function guardPathForPhase(phase) {
  const slug = phase.replace(/^phase_/, "");
  if (isRemotePhase(phase)) {
    return path.join(outDir, `${slug}_infra_guard.md`);
  }
  return path.join(outDir, `${slug}_claim_guard.md`);
}

function phasePasses(phase, color) {
  if (isRemotePhase(phase)) {
    return color === "GREEN" || color === "YELLOW";
  }
  if (phase === "phase_edge_cold" || phase === "phase_edge_warm_ready" || phase === "phase_ready_ablation_on_edge") {
    return color === "GREEN" || color === "YELLOW";
  }
  return color === "GREEN" || color === "YELLOW";
}

async function readGateColor(guardPath) {
  try {
    const t = await fs.readFile(guardPath, "utf8");
    const m = t.match(/\*\*Status:\s*(\w+)\*\*/i);
    return m?.[1]?.toUpperCase() ?? "UNKNOWN";
  } catch {
    return "MISSING";
  }
}

async function loadProgress() {
  const p = path.join(outDir, "mini_progress.json");
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return { phases: {}, main: {}, updated_at: null };
  }
}

async function saveProgress(progress) {
  progress.updated_at = new Date().toISOString();
  await fs.writeFile(
    path.join(outDir, "mini_progress.json"),
    `${JSON.stringify(progress, null, 2)}\n`,
    "utf8",
  );
}

async function cleanupPorts() {
  return runNode("scripts/ready_single_user/port_cleanup.mjs", []);
}

async function runOnePhase({ phase, trials, batchPrefix, progress, opts }) {
  let attempt = 0;
  while (attempt < opts.maxPhaseRetries) {
    attempt += 1;
    const batchDir = path.join(root, PAPER_MATERIALS_DIR, "runs", `${batchPrefix}_${phase}_${ts()}`);
    const runLog = path.join(batchDir, "run.log");
    const analyzeLog = path.join(batchDir, "analyze.log");

    await writeLoopStatus({
      state: "running",
      phase,
      trials,
      batchPrefix,
      attempt,
      batchDir,
      run_log: runLog,
      analyze_log: analyzeLog,
      gate_path: guardPathForPhase(phase),
    });

    console.log(`\n[mini_loop] === ${phase} (trials=${trials}) attempt ${attempt} ===`);
    console.log(`[mini_loop] batch: ${batchDir}`);
    console.log(`[mini_loop] status: ${LOOP_STATUS_PATH}`);

    if (opts.dryRun) return { ok: true, batchDir, color: "GREEN" };

    await fs.mkdir(batchDir, { recursive: true });
    await cleanupPorts();

    const run = runNode("scripts/ready_single_user/run.mjs", [
      `--phase=${phase}`,
      `--trials=${trials}`,
      `--batchDir=${batchDir}`,
    ]);
    await fs.writeFile(runLog, run.out, "utf8");

    const eaddr = /EADDRINUSE/i.test(run.out);
    if (!run.ok) {
      const fix = eaddr
        ? ["infra_metrics_instrumentation", "delivery_role_url_fallback"]
        : ["infra_metrics_instrumentation"];
      await cleanupPorts();
      progress.phases[phase] = { status: "RUN_FAIL", batchDir, attempt, fix_categories: fix };
      await saveProgress(progress);
      await writeLoopStatus({
        state: "failed",
        phase,
        batchDir,
        exit_code: run.code,
        last_error: run.out.split("\n").filter((l) => /ERROR|EADDRINUSE/i.test(l)).slice(-3).join(" | "),
        fix_categories: fix,
        gate_color: "RED",
      });
      console.error(`[mini_loop] run FAILED ${phase}`);
      return { ok: false, batchDir, fix_categories: fix, exitCode: 1 };
    }

    const an = runNode("scripts/ready_single_user/analyze.mjs", [
      `--batchDir=${batchDir}`,
      `--phase=${phase}`,
    ]);
    await fs.writeFile(analyzeLog, an.out, "utf8");

    const guardPath = guardPathForPhase(phase);
    const color = await readGateColor(guardPath);
    const slug = phase.replace(/^phase_/, "");
    let fixCategories = [];
    try {
      const fc = JSON.parse(
        await fs.readFile(path.join(outDir, `${slug}_fix_categories.json`), "utf8"),
      );
      fixCategories = fc.fix_categories || [];
    } catch {
      fixCategories = suggestMiniFixCategory({ phase, gate: { color } });
    }

    const pass = phasePasses(phase, color);
    const key = trials === 1 ? "phases" : "main";
    progress[key][phase] = {
      status: pass ? "PASS" : color,
      gate_color: color,
      batchDir,
      attempt,
      trials,
      guardPath,
      run_log: runLog,
      analyze_log: analyzeLog,
      fix_categories: fixCategories,
    };
    await saveProgress(progress);

    await writeLoopStatus({
      state: pass ? "phase_pass" : "phase_fail",
      phase,
      batchDir,
      gate_color: color,
      fix_categories: fixCategories,
      exit_code: pass ? 0 : 2,
    });

    if (pass) {
      console.log(`[mini_loop] PASS ${phase} (${color})`);
      return { ok: true, batchDir, color, fix_categories: fixCategories };
    }

    console.error(`[mini_loop] NOT PASS ${phase} (${color})`);
    console.error(`[mini_loop] fix_categories: ${fixCategories.join(", ")}`);
    return { ok: false, batchDir, color, fix_categories: fixCategories, exitCode: 2 };
  }
  return { ok: false, fix_categories: ["max_retries_exceeded"], exitCode: 2 };
}

async function writePipelineSummary(progress) {
  const lines = [
    "# READY autopilot pipeline summary",
    "",
    `Updated: ${progress.updated_at}`,
    "",
    "## Mini (n=1)",
    "",
    "| Phase | Status | Gate | Batch |",
    "|-------|--------|------|-------|",
  ];
  for (const p of MINI_PHASE_ORDER) {
    const r = progress.phases[p] || {};
    lines.push(`| ${p} | ${r.status ?? "—"} | ${r.gate_color ?? "—"} | ${r.batchDir ?? "—"} |`);
  }
  lines.push("", "## Main (n=5)", "", "| Phase | Status | Gate | Batch |", "|-------|--------|------|-------|");
  for (const p of MAIN_PHASE_ORDER) {
    const r = progress.main[p] || {};
    lines.push(`| ${p} | ${r.status ?? "—"} | ${r.gate_color ?? "—"} | ${r.batchDir ?? "—"} |`);
  }
  const out = path.join(outDir, "AUTOPILOT_SUMMARY.md");
  await fs.writeFile(out, `${lines.join("\n")}\n`, "utf8");
  console.log(`[mini_loop] Wrote ${out}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const progress = await loadProgress();
  if (!progress.phases) progress.phases = {};
  if (!progress.main) progress.main = {};

  await writeLoopStatus({ state: "starting", pid: process.pid });

  if (!opts.dryRun && !opts.mainOnly) {
    const pf = runNode("scripts/ready_single_user/preflight.mjs", []);
    if (!pf.ok) {
      await writeLoopStatus({ state: "blocked", reason: "preflight_failed" });
      process.exit(1);
    }
    await cleanupPorts();
  }

  const miniPhases = opts.phase
    ? MINI_PHASE_ORDER.includes(opts.phase)
      ? [opts.phase]
      : []
    : MINI_PHASE_ORDER;

  if (!opts.mainOnly) {
    for (const phase of miniPhases) {
      const r = await runOnePhase({
        phase,
        trials: 1,
        batchPrefix: "mini",
        progress,
        opts,
      });
      if (!r.ok) {
        await writeLoopStatus({
          state: "stopped",
          stopped_at_phase: phase,
          next_command: `node scripts/ready_single_user/mini_loop.mjs --phase=${phase}`,
        });
        console.error(`[mini_loop] Stopped at ${phase}. Run: npm run ready:single:recover`);
        process.exit(r.exitCode ?? 2);
      }
    }
    if (!opts.phase) {
      console.log("\n[mini_loop] All mini phases PASS.");
    }
  }

  const runMain =
    !opts.miniOnly
    && !opts.phase
    && (opts.mainOnly || miniPhases.length === 0 || miniPhases.length === MINI_PHASE_ORDER.length);

  if (runMain) {
    const allMiniPass = MINI_PHASE_ORDER.every((p) => progress.phases[p]?.status === "PASS");
    if (!allMiniPass && !opts.mainOnly) {
      await writeLoopStatus({ state: "blocked", reason: "mini_incomplete" });
      process.exit(2);
    }

    console.log("\n[mini_loop] === Starting main n=5 ===\n");
    for (const phase of MAIN_PHASE_ORDER) {
      const r = await runOnePhase({
        phase,
        trials: opts.mainTrials,
        batchPrefix: "main",
        progress,
        opts,
      });
      if (!r.ok) {
        process.exit(r.exitCode ?? 2);
      }
    }
  }

  await writePipelineSummary(progress);
  await writeLoopStatus({ state: "done", exit_code: 0 });
  console.log("[mini_loop] DONE — npm run ready:single:recover or read AUTOPILOT_SUMMARY.md");
}

main().catch(async (e) => {
  await writeLoopStatus({ state: "error", last_error: String(e?.message || e) });
  console.error(e);
  process.exit(1);
});
