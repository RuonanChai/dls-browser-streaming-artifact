#!/usr/bin/env node
/**
 * Experiment Supervisor — wraps run.mjs with monitoring, validation, and auto-fix.
 *
 * Workflow:
 *   1. Preflight: CDN reachable, disk space, no stale Chrome
 *   2. Run trials via run.mjs (existing infra)
 *   3. After each trial: per-trial hard gate check (existing evaluateTrialGate)
 *   4. After batch: deterministic review (pass_criteria_loader)
 *      + LLM review at claim_gate phases (P1-1, P1-2, P1-3, P1-4)
 *   5. Decide:
 *        - all_pass        -> write LOOP_STATUS BLOCKED|COMPLETED, exit 0
 *        - soft_fail only  -> dispatch fix; if requires_full_rerun, restart batch
 *        - hard_fail       -> write BLOCKER, LOOP_STATUS BLOCKED, exit 2
 *
 * Status file (paper_materials/ready_single_user_v1/supervisor/LOOP_STATUS.json):
 *   {
 *     "status": "RUNNING" | "COMPLETED" | "BLOCKED",
 *     "phase": "P0-1_..." | "P1-1_main_ablation" | ...,
 *     "reason": "CLAIM_GATE_FAILED" | "PREFLIGHT_FAILED" | "FIX_RETRY_LIMIT" | "OK",
 *     "requires_human_review": true | false,
 *     "batchDir": "...",
 *     "attempt": 1,
 *     "updated_at": "ISO8601"
 *   }
 */
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePhase, aggregateBaselines } from "./pass_criteria_loader.mjs";
import { dispatchFix } from "./fix_dispatcher.mjs";
import { deterministicReview, emitLlmReviewRequest } from "./invoke_review_agent.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const STATUS_PATH = path.join(
  PROJECT_ROOT,
  "paper_materials/ready_single_user_v1/supervisor/LOOP_STATUS.json",
);

const MAX_FIX_RETRIES = 3;
const CLAIM_GATE_PHASES = new Set([
  "P1-1_main_ablation",
  "P1-2_rtt_sensitivity",
  "P1-3_trace_robustness",
  "P1-4_scene_robustness",
]);

// =============================================================================
// Status writer (single source of truth)
// =============================================================================

async function writeStatus(s) {
  const status = {
    status: s.status, // RUNNING | COMPLETED | BLOCKED
    phase: s.phase,
    reason: s.reason || "OK",
    requires_human_review: s.requires_human_review === true,
    batchDir: s.batchDir || null,
    attempt: s.attempt || 1,
    detail: s.detail || null,
    updated_at: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(STATUS_PATH), { recursive: true });
  await fs.writeFile(STATUS_PATH, JSON.stringify(status, null, 2), "utf8");
  console.log(`[supervisor] STATUS: ${status.status} phase=${status.phase} reason=${status.reason}`);
  return status;
}

// =============================================================================
// Preflight
// =============================================================================

async function preflightCheck(phase) {
  const issues = [];

  // 1. Curl GCS asset
  const gcsUrl =
    process.env.VRC_CDN2_ASSET_URL ||
    "https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/coit-40m-sh1-lod.rad";
  const r = spawnSync(
    "curl.exe",
    ["-sI", "--connect-timeout", "12", "-H", "Range: bytes=0-1023", gcsUrl],
    { encoding: "utf8", windowsHide: true },
  );
  const out = (r.stdout || "") + (r.stderr || "");
  if (!/206|200/.test(out)) {
    issues.push(`CDN unreachable: ${gcsUrl}`);
  }

  // 2. Disk space (>5GB free on D:)
  const diskCmd = spawnSync(
    "powershell.exe",
    ["-Command", "(Get-PSDrive D).Free / 1GB"],
    { encoding: "utf8", windowsHide: true },
  );
  const freeGb = parseFloat((diskCmd.stdout || "0").trim());
  if (Number.isFinite(freeGb) && freeGb < 5) {
    issues.push(`Low disk space: ${freeGb.toFixed(1)} GB free on D:`);
  }

  // 3. Kill stale Chrome (older than 5 min)
  spawnSync(
    "powershell.exe",
    [
      "-Command",
      "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -lt (Get-Date).AddMinutes(-5) } | Stop-Process -Force -ErrorAction SilentlyContinue",
    ],
    { windowsHide: true },
  );

  return { ok: issues.length === 0, issues };
}

// =============================================================================
// Run a batch via run.mjs
// =============================================================================

function runBatch({ phaseName, trials, methods, batchDir, resume }) {
  const args = [
    "scripts/ready_single_user/run.mjs",
    `--phase=${phaseName}`,
    `--trials=${trials}`,
  ];
  if (methods && methods.length) args.push(`--methods=${methods.join(",")}`);
  if (batchDir) args.push(`--batchDir=${batchDir}`);
  if (resume) args.push("--resume");

  console.log(`[supervisor] Running: node ${args.join(" ")}`);
  const r = spawnSync("node", args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  return { exitCode: r.status, signal: r.signal };
}

// =============================================================================
// Find the most recent batch directory
// =============================================================================

async function findLatestBatchDir() {
  const runsDir = path.join(
    PROJECT_ROOT,
    "paper_materials/ready_single_user_v1/runs",
  );
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
    .map((e) => path.join(runsDir, e.name))
    .sort();
  return dirs[dirs.length - 1];
}

// =============================================================================
// Main supervised run
// =============================================================================

/**
 * Supervise a single phase.
 *
 * @param {Object} opts
 * @param {string} opts.phase     - pass_criteria phase id (e.g. "P1-1_main_ablation")
 * @param {string} opts.runPhase  - run.mjs phase name (e.g. "phase_remote_gcs_dev")
 * @param {number} opts.trials    - n trials per baseline
 * @param {string[]} opts.methods - baseline ids to run
 */
export async function supervisePhase(opts) {
  const { phase, runPhase, trials, methods } = opts;
  let attempt = 1;
  let batchDir = null;
  const fixHistory = [];

  await writeStatus({
    status: "RUNNING",
    phase,
    reason: "starting",
    attempt,
  });

  while (attempt <= MAX_FIX_RETRIES + 1) {
    // 1. Preflight
    const pre = await preflightCheck(phase);
    if (!pre.ok) {
      await writeStatus({
        status: "BLOCKED",
        phase,
        reason: "PREFLIGHT_FAILED",
        requires_human_review: true,
        detail: pre.issues.join("; "),
      });
      return { ok: false, reason: "PREFLIGHT_FAILED", issues: pre.issues };
    }

    // 2. Run batch (or resume after fix that didn't require full rerun)
    const resumeMode = attempt > 1 && batchDir != null && !fixHistory.some((f) => f.requires_full_rerun);
    if (!resumeMode) batchDir = null; // fresh batch
    const runResult = runBatch({
      phaseName: runPhase,
      trials,
      methods,
      batchDir,
      resume: resumeMode,
    });

    // Locate the batch directory if not yet known
    if (!batchDir) batchDir = await findLatestBatchDir();
    console.log(`[supervisor] batchDir: ${batchDir}`);

    if (runResult.exitCode !== 0) {
      console.warn(`[supervisor] run.mjs exited with code ${runResult.exitCode}; continuing to review`);
    }

    // 3. Deterministic review
    const review = await deterministicReview(batchDir, phase);

    // 4. LLM review (claim_gate phases only)
    if (CLAIM_GATE_PHASES.has(phase)) {
      emitLlmReviewRequest(batchDir, phase);
      // Note: parent Claude session is expected to invoke the sub-agent.
      // Supervisor proceeds based on deterministic result; LLM verdict
      // is advisory and recorded in claim_guard.md.
    }

    // 5. Decide
    if (review.evalResult.all_pass) {
      await writeStatus({
        status: "COMPLETED",
        phase,
        reason: "OK",
        requires_human_review: false,
        batchDir,
        attempt,
      });
      return { ok: true, batchDir, evalResult: review.evalResult };
    }

    // Hard failures (claim gate or null auto_fix) → BLOCKED
    if (review.evalResult.hard_failures.length > 0) {
      const reason = review.evalResult.is_claim_gate
        ? "CLAIM_GATE_FAILED"
        : "HARD_GATE_FAILED";
      await writeStatus({
        status: "BLOCKED",
        phase,
        reason,
        requires_human_review: true,
        batchDir,
        attempt,
        detail: review.evalResult.hard_failures.map((f) => f.check_id).join(", "),
      });
      return {
        ok: false,
        reason,
        batchDir,
        hard_failures: review.evalResult.hard_failures,
      };
    }

    // Soft failures only → dispatch fixes
    if (attempt > MAX_FIX_RETRIES) {
      await writeStatus({
        status: "BLOCKED",
        phase,
        reason: "FIX_RETRY_LIMIT",
        requires_human_review: true,
        batchDir,
        attempt,
        detail: review.evalResult.soft_failures.map((f) => f.check_id).join(", "),
      });
      return {
        ok: false,
        reason: "FIX_RETRY_LIMIT",
        batchDir,
        soft_failures: review.evalResult.soft_failures,
      };
    }

    console.log(`[supervisor] Attempt ${attempt}: applying ${review.evalResult.soft_failures.length} fixes`);
    let anyFullRerun = false;
    for (const f of review.evalResult.soft_failures) {
      const fix = await dispatchFix(f.auto_fix, {
        batchDir,
        phase,
        reason: f.detail,
        missing_fields: f.missing_fields,
      });
      console.log(`[supervisor]   fix ${f.auto_fix}: applied=${fix.applied} fullRerun=${fix.requires_full_rerun}`);
      fixHistory.push({ ...fix, category: f.auto_fix, attempt });
      if (fix.requires_full_rerun) anyFullRerun = true;
    }

    attempt += 1;
    if (anyFullRerun) {
      console.log(`[supervisor] Code changed; full batch rerun on attempt ${attempt}`);
    } else {
      console.log(`[supervisor] No code change; resuming same batch on attempt ${attempt}`);
    }
  }

  // Should not reach here
  await writeStatus({
    status: "BLOCKED",
    phase,
    reason: "FIX_RETRY_LIMIT",
    requires_human_review: true,
    batchDir,
    attempt,
  });
  return { ok: false, reason: "FIX_RETRY_LIMIT", batchDir };
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(argv) {
  const o = { phase: null, runPhase: null, trials: 1, methods: null };
  for (const a of argv) {
    if (a.startsWith("--phase=")) o.phase = a.slice(8);
    else if (a.startsWith("--runPhase=")) o.runPhase = a.slice(11);
    else if (a.startsWith("--trials=")) o.trials = Number(a.slice(9));
    else if (a.startsWith("--methods=")) o.methods = a.slice(10).split(",");
  }
  return o;
}

const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
  process.argv[1].endsWith("experiment_supervisor.mjs");

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.phase || !opts.runPhase) {
    console.error(
      "Usage: node experiment_supervisor.mjs --phase=<pass_criteria_phase_id> --runPhase=<run.mjs phase> --trials=N [--methods=a,b,c]",
    );
    console.error(
      "Example: node experiment_supervisor.mjs --phase=P0-4_sanity_check --runPhase=phase_remote_gcs_dev --trials=3",
    );
    process.exit(1);
  }
  supervisePhase(opts).then((r) => {
    if (r.ok) {
      console.log(`[supervisor] PHASE ${opts.phase} COMPLETED`);
      process.exit(0);
    } else {
      console.error(`[supervisor] PHASE ${opts.phase} BLOCKED: ${r.reason}`);
      process.exit(2);
    }
  }).catch((e) => {
    console.error(`[supervisor] FATAL:`, e);
    writeStatus({
      status: "BLOCKED",
      phase: opts.phase,
      reason: "SUPERVISOR_CRASH",
      requires_human_review: true,
      detail: String(e),
    }).finally(() => process.exit(3));
  });
}
