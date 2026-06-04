/**
 * Auto-fix dispatcher.
 * Maps fix_category strings (from pass_criteria.json) to repair actions.
 *
 * Each fix:
 *   - inspects relevant code/state
 *   - applies a deterministic repair
 *   - records before/after diff in fix_log.md
 *   - returns { applied: bool, requires_full_rerun: bool, detail: string }
 *
 * Hard claim failures (auto_fix: null) are never dispatched here.
 * They escalate to human via supervisor.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

/** Read a file safely. */
async function readFile(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Append to fix log. */
async function logFix(batchDir, entry) {
  const logPath = path.join(batchDir, "fix_log.md");
  const ts = new Date().toISOString();
  const block = `\n## ${ts} — ${entry.category}\n\n` +
    `**Phase**: ${entry.phase}\n` +
    `**Reason**: ${entry.reason}\n` +
    `**Action**: ${entry.action}\n` +
    `**Result**: ${entry.applied ? "APPLIED" : "SKIPPED"}\n` +
    (entry.requires_full_rerun ? `**Requires full rerun**: yes\n` : "") +
    (entry.diff ? `\n\`\`\`\n${entry.diff}\n\`\`\`\n` : "") +
    "\n---\n";
  let prev = (await readFile(logPath)) || "# Fix Log\n";
  await fs.writeFile(logPath, prev + block, "utf8");
}

// =============================================================================
// Individual fix handlers
// =============================================================================

/** Fix: predecode flag is leaking into a baseline that should not have it. */
async function fix_predecode_leak(ctx) {
  const corePath = path.join(PROJECT_ROOT, "scripts/lib/ready/ready_core.js");
  const code = await readFile(corePath);
  if (!code) {
    return { applied: false, requires_full_rerun: false, detail: "ready_core.js not found" };
  }
  // Check that isReadyP, READY-C, Naive-PF do not set predecode flag
  // The actual flag is in the controller's preDecodeChunk gate
  const ctrlPath = path.join(PROJECT_ROOT, "scripts/lib/proactive_prefetch_controller.js");
  const ctrl = await readFile(ctrlPath);
  const leakRegex = /flags\.isReadyP.*preDecodeChunk|flags\.isNaive.*preDecodeChunk|flags\.isReadyC.*preDecodeChunk/;
  if (ctrl && leakRegex.test(ctrl)) {
    return {
      applied: false,
      requires_full_rerun: true,
      detail: "predecode call site references baseline that should not have predecode; manual code fix required",
    };
  }
  return {
    applied: false,
    requires_full_rerun: false,
    detail: "no obvious predecode leak in source; check runtime baseline_code routing",
  };
}

/** Fix: continuous scheduling firing on a baseline that should be one-shot. */
async function fix_continuous_leak(ctx) {
  const ctrlPath = path.join(PROJECT_ROOT, "scripts/lib/ready/ready_controller.js");
  const code = await readFile(ctrlPath);
  if (!code) {
    return { applied: false, requires_full_rerun: false, detail: "ready_controller.js not found" };
  }
  if (!/setInterval.*runSchedulingTick/.test(code)) {
    return { applied: false, requires_full_rerun: false, detail: "no setInterval found; controller may not start" };
  }
  return {
    applied: false,
    requires_full_rerun: true,
    detail: "continuous tick is firing on a one-shot baseline; check method-flag gate around setInterval",
  };
}

/** Fix: session prior accidentally enabled in READY (should only be in READY-S). */
async function fix_session_prior_leak(ctx) {
  const corePath = path.join(PROJECT_ROOT, "scripts/lib/ready/ready_core.js");
  const code = await readFile(corePath);
  if (!code) {
    return { applied: false, requires_full_rerun: false, detail: "ready_core.js not found" };
  }
  // Expect: useSessionPrediction: isReadyS  (NOT isReadyG || isReadyFull)
  const m = code.match(/useSessionPrediction:\s*([^,\n]+)/);
  if (!m) {
    return { applied: false, requires_full_rerun: false, detail: "useSessionPrediction not found in flags" };
  }
  const expr = m[1].trim();
  if (expr === "isReadyS") {
    return { applied: true, requires_full_rerun: false, detail: "already correctly gated to isReadyS" };
  }
  // Auto-fix: replace with isReadyS
  const fixed = code.replace(
    /useSessionPrediction:\s*[^,\n]+/,
    "useSessionPrediction: isReadyS",
  );
  await fs.writeFile(corePath, fixed, "utf8");
  return {
    applied: true,
    requires_full_rerun: true,
    detail: `useSessionPrediction was '${expr}', changed to 'isReadyS'`,
    diff: `- useSessionPrediction: ${expr}\n+ useSessionPrediction: isReadyS`,
  };
}

/** Fix: instrumentation timestamp fields not being recorded. */
async function fix_instrumentation_hook(ctx) {
  // This requires inspecting the failed trial JSON to see which fields are null
  const probePath = path.join(PROJECT_ROOT, "scripts/lib/proactive_chunk_probe.js");
  const code = await readFile(probePath);
  if (!code) {
    return { applied: false, requires_full_rerun: false, detail: "probe file not found" };
  }
  const missing = ctx.missing_fields || [];
  const hookFields = {
    "prefetch_enqueue_time": "notePrefetchEnqueue",
    "predecode_start_time": "notePredecodeStart",
    "predecode_end_time": "notePredecodeEnd",
    "cache_lookup_time": "noteCacheLookup",
    "cache_hit_time": "noteCacheHit",
    "first_byte_time": "noteFirstByte",
    "response_end_time": "noteResponseEnd",
    "gpu_upload_start_time": "noteUploadStart",
    "gpu_upload_end_time": "noteUploadComplete",
  };
  const absentHooks = missing.filter((f) => {
    const hook = hookFields[f];
    return hook && !code.includes(hook);
  });
  if (absentHooks.length === 0) {
    return {
      applied: false,
      requires_full_rerun: false,
      detail: "all hooks present in source; failure may be runtime call site issue",
    };
  }
  return {
    applied: false,
    requires_full_rerun: true,
    detail: `instrumentation hooks missing: ${absentHooks.join(", ")} — manual addition required`,
  };
}

/** Fix: cache_hit_kind not summing to 100% across decoded/raw/network. */
async function fix_cache_kind_label(ctx) {
  const ctrlPath = path.join(PROJECT_ROOT, "scripts/lib/proactive_prefetch_controller.js");
  const code = await readFile(ctrlPath);
  if (!code) {
    return { applied: false, requires_full_rerun: false, detail: "controller not found" };
  }
  if (!/cache_hit_kind/.test(code)) {
    return {
      applied: false,
      requires_full_rerun: true,
      detail: "cache_hit_kind label not yet implemented in fetch intercept; manual addition required",
    };
  }
  return {
    applied: false,
    requires_full_rerun: false,
    detail: "cache_hit_kind labels present; aggregation logic may be wrong",
  };
}

/** Fix: FPS regression (system overload). Reduce maxParallel for READY. */
async function fix_fps_regression(ctx) {
  const trialCellPath = path.join(PROJECT_ROOT, "scripts/ready_single_user/trial_cell.mjs");
  const code = await readFile(trialCellPath);
  if (!code) {
    return { applied: false, requires_full_rerun: false, detail: "trial_cell.mjs not found" };
  }
  const m = code.match(/maxParallel:\s*arm\?\.ready_aware[\s\S]{0,200}?:\s*3/);
  if (!m) {
    return { applied: false, requires_full_rerun: false, detail: "maxParallel pattern not found" };
  }
  // Already at 3; reducing to 2 may help under heavy GPU load
  if (/delivery\.delivery_role\s*===\s*"remote"\s*\?\s*3/.test(code)) {
    const fixed = code.replace(
      /delivery\.delivery_role\s*===\s*"remote"\s*\?\s*3/,
      'delivery.delivery_role === "remote" ? 2',
    );
    await fs.writeFile(trialCellPath, fixed, "utf8");
    return {
      applied: true,
      requires_full_rerun: true,
      detail: "reduced remote maxParallel from 3 to 2 to relieve GPU/worker contention",
      diff: "- maxParallel: ... remote ? 3 ...\n+ maxParallel: ... remote ? 2 ...",
    };
  }
  return {
    applied: false,
    requires_full_rerun: false,
    detail: "maxParallel already at minimum configured value",
  };
}

/** Fix: stale Chrome processes consuming resources. */
async function fix_cleanup_processes(ctx) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", [
      "-Command",
      "Get-Process chrome,node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -lt (Get-Date).AddMinutes(-5) } | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Host done",
    ]);
    ps.on("close", () => {
      resolve({
        applied: true,
        requires_full_rerun: false,
        detail: "killed stale chrome/node processes older than 5 min",
      });
    });
  });
}

/** Fix: RTT throttling not actually applied at runtime. */
async function fix_rtt_throttle_not_applied(ctx) {
  return {
    applied: false,
    requires_full_rerun: true,
    detail: "RTT throttling appears to not affect measured fetch latency; verify Network.emulateNetworkConditions is invoked before page load",
  };
}

// =============================================================================
// Dispatcher table
// =============================================================================

const FIX_HANDLERS = {
  // P0 sanity / mechanism leaks
  ready_p_predecode_leak_or_continuous_leak: fix_predecode_leak,
  ready_r_predecode_or_continuous_misrouted: fix_continuous_leak,
  ready_c_continuous_misrouted: fix_continuous_leak,
  ready_full_mechanism_or_session_prior_leak: fix_session_prior_leak,
  ready_s_session_prior_disabled: fix_session_prior_leak,
  naive_pf_predecode_leak: fix_predecode_leak,
  spark_od_misroute: fix_predecode_leak,
  session_prior_misrouted: fix_session_prior_leak,
  ready_predecode_leak: fix_predecode_leak,

  // Instrumentation
  instrumentation_hook_misplaced: fix_instrumentation_hook,
  derivation_missing: fix_instrumentation_hook,
  cache_kind_mislabeled: fix_cache_kind_label,

  // Resource / system
  system_overload_reduce_concurrency: fix_fps_regression,
  ready_fps_regression_reduce_predecode_concurrency: fix_fps_regression,
  concurrency_unfair_check_maxParallel: fix_cleanup_processes,
  low_rtt_overhead_too_high: fix_fps_regression,

  // Network/throttle
  rtt_throttling_not_actually_applied: fix_rtt_throttle_not_applied,

  // Hard failures (claim gate) — should never reach here, but guard
  ablation_inversion_check_baseline_implementation: null,
  scene_specific_anomaly_investigate: null,
  upper_bound_simulator_resource_constraint_too_tight: null,
  simulator_pipeline_model_wrong: null,
  matplotlib_render_failed: null,
  fill_nan_with_explicit_missing_marker: null,
  missing_figure_reference: null,
  missing_baseline_definition: null,
  wrong_flag_routing: null,
  config_mismatch_per_baseline: null,
};

/**
 * Dispatch a fix.
 * @param {string} category - fix_category from pass_criteria.json
 * @param {object} ctx - { batchDir, phase, missing_fields, ... }
 * @returns {Promise<{applied, requires_full_rerun, detail, diff?}>}
 */
export async function dispatchFix(category, ctx) {
  const handler = FIX_HANDLERS[category];
  if (handler === undefined) {
    return {
      applied: false,
      requires_full_rerun: false,
      detail: `unknown fix category: ${category}`,
    };
  }
  if (handler === null) {
    return {
      applied: false,
      requires_full_rerun: false,
      detail: `category ${category} requires human review (no auto-fix)`,
    };
  }
  const result = await handler(ctx);
  if (ctx.batchDir) {
    await logFix(ctx.batchDir, {
      category,
      phase: ctx.phase || "unknown",
      reason: ctx.reason || "auto-fix triggered",
      action: handler.name,
      ...result,
    });
  }
  return result;
}

/** List all known fix categories (for sanity check). */
export function listKnownCategories() {
  return Object.keys(FIX_HANDLERS);
}
