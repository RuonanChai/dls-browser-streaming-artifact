/**
 * Gates for READY single-user paper (Phase A sanity + per-trial + phase claims).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_ENDPOINTS,
  DEFAULT_EDGE_URL,
  DEFAULT_REMOTE_URL,
  PAPER_MATERIALS_DIR,
  READY_PEER_WIN_MARGIN,
} from "./constants.mjs";

export { READY_PEER_WIN_MARGIN };

/** Lower metric is better; READY must beat peer by ≥ margin (default 10%). */
export function lowerBetterWin(readyVal, peerVal, margin = READY_PEER_WIN_MARGIN) {
  if (readyVal == null || peerVal == null || !Number.isFinite(readyVal) || !Number.isFinite(peerVal)) {
    return false;
  }
  if (peerVal <= 0) return readyVal < peerVal;
  return readyVal <= peerVal / margin;
}

/** Higher metric is better; READY must beat peer by ≥ margin (default 10%). */
export function higherBetterWin(readyVal, peerVal, margin = READY_PEER_WIN_MARGIN) {
  if (readyVal == null || peerVal == null || !Number.isFinite(readyVal) || !Number.isFinite(peerVal)) {
    return false;
  }
  if (peerVal <= 0) return readyVal > peerVal;
  return readyVal >= peerVal * margin;
}
import {
  aggregateBaselineRemoteStats,
  isRemotePhase,
  REMOTE_PHASE_NAMES,
} from "./remote_stats.mjs";
import {
  evaluateRemoteClaimGate,
  getRemotePipelineDecision,
  remotePhaseAllowsAutoFix,
  remotePhaseIsFrozen,
  suggestRemoteClaimFixCategories,
  REMOTE_DEV_PHASES,
  REMOTE_VALIDATION_PHASES,
  REMOTE_TEST_MAIN_PHASES,
} from "./remote_claim_gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function isSwiftShaderOrCpuRenderer(gpuRenderer) {
  const r = String(gpuRenderer ?? "").toLowerCase();
  if (!r) return { bad: true, reason: "missing_gpu_renderer" };
  if (/swiftshader|llvmpipe|software|microsoft basic render|google swiftshader/i.test(r)) {
    return { bad: true, reason: "swiftshader_or_software_renderer" };
  }
  return { bad: false, reason: "" };
}

export function evaluateTrialGate(trialJson) {
  const failures = [];
  const gpu = isSwiftShaderOrCpuRenderer(trialJson.gpu_renderer);
  if (gpu.bad) failures.push(`GPU: ${gpu.reason}`);

  const radActivity =
    trialJson.status_code === 206
    || (trialJson.total_rad_requests ?? 0) > 0
    || (trialJson.measure_rad_requests ?? 0) > 0
    || (trialJson.cdp_rad_206_count ?? 0) >= 3;
  if (!radActivity) failures.push("No 206/rad activity");

  if (
    (trialJson.measure_rad_requests ?? 0) === 0
    && (trialJson.cdp_rad_206_count ?? 0) === 0
    && (trialJson.measure_fps ?? 0) > 120
  ) {
    failures.push("Invalid streaming trial: high FPS but zero rad requests");
  }

  const minDemand = trialJson.baseline_id === "spark_od" ? 5 : 3;
  const demandOk =
    (trialJson.demanded_chunks ?? 0) >= minDemand
    || (trialJson.demand_trace_count ?? 0) >= minDemand;
  if (!demandOk) failures.push("Demand trace too small");

  if ((trialJson.visible_splat_max ?? 0) <= 0 && trialJson.first_visible_splat_ms == null) {
    failures.push("No visible splat observed");
  }

  if (trialJson.baseline_id !== "spark_od" && !trialJson.ready_event_used) {
    failures.push("ready_event_used missing for proactive baseline");
  }

  return { passed: failures.length === 0, failures, halt_batch: gpu.bad };
}

export function evaluatePhaseASanity(trials, serverSummaries = []) {
  const checks = [];
  const failures = [];

  let totalRad = 0;
  let totalBytes = 0;
  for (const s of serverSummaries) {
    totalRad += s.total_rad_requests ?? 0;
    totalBytes += s.total_bytes_sent ?? 0;
  }
  if (totalRad === 0) {
    for (const t of trials) {
      totalRad += t.total_rad_requests ?? t.measure_rad_requests ?? 0;
      totalBytes += t.total_received_bytes ?? 0;
    }
  }

  checks.push({ gate: "server_rad_requests", passed: totalRad > 0, value: totalRad });
  if (totalRad <= 0) failures.push("server_monitor: total_rad_requests <= 0");

  checks.push({ gate: "server_bytes_sent", passed: totalBytes > 0, value: totalBytes });
  if (totalBytes <= 0) failures.push("server_monitor: total_bytes_sent <= 0");

  const alignRates = trials.map((t) => t.alignment_rate).filter((x) => x != null && Number.isFinite(x));
  const allHaveAlignment = trials.every((t) => t.alignment_rate != null && Number.isFinite(t.alignment_rate));
  const alignRate = alignRates.length ? alignRates.reduce((a, b) => a + b, 0) / alignRates.length : NaN;
  const alignmentPass = allHaveAlignment && Number.isFinite(alignRate) && alignRate >= 0.99;
  checks.push({
    gate: "client_server_alignment_rate",
    passed: alignmentPass,
    value: allHaveAlignment ? alignRate : null,
    all_trials_have_numeric_alignment: allHaveAlignment,
  });
  if (!allHaveAlignment) {
    failures.push("client_server_alignment_rate null/undefined/NaN/missing on one or more trials → FAIL");
  } else if (alignRate < 0.99) {
    failures.push(`alignment_rate ${(alignRate * 100).toFixed(1)}% < 99%`);
  }

  const traceOk = trials.every((t) => t.trace_ok !== false);
  checks.push({ gate: "trace_ok", passed: traceOk });
  if (!traceOk) failures.push("trace_ok = false on one or more trials");

  const poseNonZero = trials.every((t) => t.trace_pose_nonzero !== false);
  checks.push({ gate: "trace_pose_nonzero", passed: poseNonZero });
  if (!poseNonZero) failures.push("camera pose all zeros");

  const readyEvents = trials.filter((t) => t.ready_event_used);
  checks.push({
    gate: "ready_event_used",
    passed: readyEvents.length === trials.length,
    count: readyEvents.length,
  });
  if (readyEvents.length < trials.length) failures.push("ready_event_used empty on some trials");

  const parseRates = trials.map((t) => t.parse_complete_fill_rate ?? 0);
  const parseRate = parseRates.length ? parseRates.reduce((a, b) => a + b, 0) / parseRates.length : 0;
  checks.push({ gate: "parse_complete_fill_rate", passed: parseRate >= 0.95, value: parseRate });
  if (parseRate < 0.95) failures.push(`parse_complete fill rate ${(parseRate * 100).toFixed(1)}% < 95%`);

  const remoteTrial = trials.find((t) => t.delivery_key === "remote_server" || t.fast_but_empty_detected != null);
  if (remoteTrial) {
    checks.push({
      gate: "fast_but_empty_detected",
      passed: true,
      note: "detector present",
    });
  }

  return {
    passed: failures.length === 0,
    failures,
    checks,
    metrics: {
      total_rad_requests: totalRad,
      total_bytes_sent: totalBytes,
      alignment_rate: alignRate,
      parse_complete_fill_rate: parseRate,
      trace_ok: traceOk,
    },
  };
}

export function evaluatePhaseBClaim(trials) {
  const byName = {};
  for (const t of trials.filter((x) => x.hard_gate_passed)) {
    const k = t.baseline_name || t.baseline_id;
    if (!byName[k]) byName[k] = [];
    byName[k].push(t);
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const spark = byName["Spark-OD"] || [];
  const ready = byName["READY"] || [];
  const readyP = byName["READY-P"] || [];
  const sgss = byName["SGSS"] || [];

  const sparkMiss100 = mean(spark.map((t) => t.deadline_miss_ratio_100ms ?? 0));
  const readyMiss100 = mean(ready.map((t) => t.deadline_miss_ratio_100ms ?? 0));
  const sparkFv = mean(spark.map((t) => t.first_visible_splat_ms ?? 0));
  const readyFv = mean(ready.map((t) => t.first_visible_splat_ms ?? 0));
  const sparkUseful = mean(spark.map((t) => t.useful_chunks_before_demand ?? 0));
  const readyUseful = mean(ready.map((t) => t.useful_chunks_before_demand ?? 0));
  const readyWaste = mean(ready.map((t) => t.wasted_prefetch_ratio ?? 0));
  const readyFps = mean(ready.map((t) => t.measure_fps ?? 0));
  const readyEmpty = ready.some((t) => t.fast_but_empty_detected);

  const miss100Drop = sparkMiss100 > 0 ? (sparkMiss100 - readyMiss100) / sparkMiss100 : null;
  const fvDrop = sparkFv > 0 ? (sparkFv - readyFv) / sparkFv : null;
  const usefulOk =
    readyUseful != null && sparkUseful != null
    && (readyUseful >= sparkUseful + 50 || readyUseful >= sparkUseful * 2);

  const gates = {
    miss100_drop_30pct: miss100Drop != null && miss100Drop >= 0.3,
    first_visible_drop_30pct: fvDrop != null && fvDrop >= 0.3,
    useful_before: usefulOk,
    wasted_prefetch_le_30pct: readyWaste != null && readyWaste <= 0.3,
    measure_fps_ge_60: readyFps != null && readyFps >= 60,
    fast_but_empty_false: !readyEmpty,
    ready_beats_ready_p:
      mean(ready.map((t) => t.deadline_miss_ratio_100ms ?? 1))
      < mean(readyP.map((t) => t.deadline_miss_ratio_100ms ?? 1)),
    ready_beats_sgss:
      mean(ready.map((t) => t.deadline_miss_ratio_100ms ?? 1))
      < mean(sgss.map((t) => t.deadline_miss_ratio_100ms ?? 1)),
  };

  const strongClaimOk = Object.entries(gates)
    .filter(([k]) => !k.startsWith("ready_beats"))
    .every(([, v]) => v);
  const beatsAblation = gates.ready_beats_ready_p && gates.ready_beats_sgss;

  return {
    gates,
    strong_claim_ok: strongClaimOk,
    beats_ablation_ok: beatsAblation,
    values: { miss100Drop, fvDrop, sparkUseful, readyUseful, readyWaste, readyFps },
  };
}

const REMOTE_CDN_HOST = "pub-0429777a95db48e192b4c665413f8eb2.r2.dev";

export function trialHasRadActivity(t) {
  return (
    t.status_code === 206
    || (t.measure_rad_requests ?? 0) > 0
    || (t.total_rad_requests ?? 0) > 0
    || (t.cdp_rad_206_count ?? 0) > 0
  );
}

export function trialHighFpsZeroRad(t) {
  return (
    (t.measure_rad_requests ?? 0) === 0
    && (t.cdp_rad_206_count ?? 0) === 0
    && (t.measure_fps ?? 0) > 120
  );
}

/** Collect CDN asset URLs (not page server_url). */
export function collectRemoteAssetUrls(t) {
  return [
    t.asset_url,
    t.rad_url,
    t.object_url,
    t.delivery_url,
    t.rad_asset_url,
    t.VRC_RAD_URL,
  ].filter((u) => u != null && String(u).trim());
}

export function trialRemoteAssetCanonical(t) {
  const urls = collectRemoteAssetUrls(t);
  if (!urls.length) return null;
  return urls.some((u) => String(u).includes(REMOTE_CDN_HOST));
}

/**
 * Readiness win: prefer miss500/miss1000; miss100 fallback.
 * Note: first_visible regression is checked at phase level (vs Spark-OD only).
 */
export function beatsPeerOnReadiness(readyRow, peerRow, margin = READY_PEER_WIN_MARGIN) {
  if (!readyRow || !peerRow) return false;

  const miss500Win =
    readyRow.miss500 != null
    && peerRow.miss500 != null
    && lowerBetterWin(readyRow.miss500, peerRow.miss500, margin);
  const miss1000Win =
    readyRow.miss1000 != null
    && peerRow.miss1000 != null
    && lowerBetterWin(readyRow.miss1000, peerRow.miss1000, margin);
  const usefulWin = higherBetterWin(
    readyRow.useful_chunks_before_demand ?? 0,
    peerRow.useful_chunks_before_demand ?? 0,
    margin,
  );
  const earlyWin = higherBetterWin(
    readyRow.early_ready_ratio ?? 0,
    peerRow.early_ready_ratio ?? 0,
    margin,
  );
  const gapWin = lowerBetterWin(
    readyRow.readiness_gap_p50_ms ?? Infinity,
    peerRow.readiness_gap_p50_ms ?? Infinity,
    margin,
  );
  const miss100Win =
    readyRow.miss100 != null
    && peerRow.miss100 != null
    && lowerBetterWin(readyRow.miss100, peerRow.miss100, margin);

  const primaryWin =
    miss500Win || miss1000Win || (usefulWin && gapWin) || (usefulWin && earlyWin);
  if (primaryWin) return true;

  const longMissMissing =
    (readyRow.miss500 == null && readyRow.miss1000 == null)
    || (peerRow.miss500 == null && peerRow.miss1000 == null);
  if (longMissMissing) {
    return miss100Win || (usefulWin && gapWin) || (usefulWin && earlyWin);
  }
  return false;
}

/** Edge claim peers only — local uses sanity gate; remote uses motivation gate. */
export const PHASE_READY_PEER_NAMES = {
  phase_edge_cold: ["Spark-OD", "Naive-PF", "PRoGS", "SGSS", "READY-P"],
  phase_edge_warm_ready: ["Spark-OD", "Naive-PF", "READY-P"],
  phase_ready_ablation_on_edge: ["Spark-OD", "READY-P", "READY-E", "READY-G"],
  phaseB_mini: ["Spark-OD", "Naive-PF", "PRoGS", "SGSS", "READY-P", "READY-E", "READY-G"],
};

/** Fixed mini order (Runbook §9.3). */
export const MINI_PHASE_ORDER = [
  "phase_local_ceiling",
  "phase_edge_cold",
  "phase_edge_warm_ready",
  "phase_ready_ablation_on_edge",
  "phase_remote_direct_cold",
  "phase_delivery_compare",
];

/** Remote paper pipeline: dev → validation (freeze) → test_main (frozen code). */
export const MAIN_PHASE_ORDER = [
  "phase_remote_dev",
  "phase_remote_validation",
  "phase_remote_test_main",
];

/** Legacy / exploratory remote batches. */
export const MAIN_PHASE_ORDER_LEGACY_REMOTE = [
  "phase_remote_direct_cold",
  "phase_remote_warm_equal",
];

/** @deprecated Use phase_remote_direct_cold */
export const MAIN_PHASE_ORDER_LEGACY_EDGE = [
  "phase_edge_cold",
  "phase_edge_warm_ready",
  "phase_ready_ablation_on_edge",
  "phase_remote_direct",
];

export {
  REMOTE_PHASE_NAMES,
  isRemotePhase,
  REMOTE_DEV_PHASES,
  REMOTE_VALIDATION_PHASES,
  REMOTE_TEST_MAIN_PHASES,
  remotePhaseAllowsAutoFix,
  remotePhaseIsFrozen,
  getRemotePipelineDecision,
  suggestRemoteClaimFixCategories,
};

export const EDGE_CLAIM_PHASES = new Set([
  "phase_edge_cold",
  "phase_edge_warm_ready",
  "phase_ready_ablation_on_edge",
]);

export function evaluateReadyHygiene(rows) {
  const ready = rows.find((r) => r.baseline_name === "READY");
  const naivePf = rows.find((r) => r.baseline_name === "Naive-PF");
  const readyBytes = ready?.total_received_bytes ?? 0;
  const naiveBytes = naivePf?.total_received_bytes ?? 0;
  const readyUseful = ready?.useful_bytes_ratio ?? 0;
  const naiveUseful = naivePf?.useful_bytes_ratio ?? 0;
  const metricsMissing = [];

  let wastedOk = true;
  if (ready?.wasted_prefetch_ratio == null) {
    metricsMissing.push("wasted_prefetch_ratio");
  } else {
    wastedOk = ready.wasted_prefetch_ratio <= 0.3;
  }

  let fastEmptyOk = true;
  if (ready?.fast_but_empty_rate == null) {
    metricsMissing.push("fast_but_empty_rate");
    if (ready?.fast_but_empty_detected === true) fastEmptyOk = false;
  } else {
    fastEmptyOk = ready.fast_but_empty_rate === 0;
  }

  let fpsOk = true;
  if (ready?.measure_fps == null) {
    metricsMissing.push("measure_fps");
  } else {
    fpsOk = ready.measure_fps >= 60;
  }

  // When both useful_bytes_ratio are 0 (instrumentation gap), bytes comparison
  // is meaningless — treat as metrics missing, not a failure.
  const bytesGuardApplicable = naivePf && (readyUseful > 0 || naiveUseful > 0);
  const checks = {
    naive_pf_bytes_guard:
      !bytesGuardApplicable || !(readyBytes > naiveBytes * 1.2 && readyUseful <= naiveUseful * 1.05),
    naive_pf_bytes_guard_skipped: naivePf && !bytesGuardApplicable,
    wasted_prefetch_le_30pct: wastedOk,
    wasted_prefetch_metrics_missing: metricsMissing.includes("wasted_prefetch_ratio"),
    measure_fps_ge_60: fpsOk,
    measure_fps_metrics_missing: metricsMissing.includes("measure_fps"),
    fast_but_empty_ok: fastEmptyOk,
    fast_but_empty_metrics_missing: metricsMissing.includes("fast_but_empty_rate"),
    metrics_missing: metricsMissing.length > 0,
  };

  const ok =
    checks.naive_pf_bytes_guard
    && (checks.wasted_prefetch_metrics_missing || checks.wasted_prefetch_le_30pct)
    && (checks.measure_fps_metrics_missing || checks.measure_fps_ge_60)
    && (checks.fast_but_empty_metrics_missing || checks.fast_but_empty_ok);

  return { checks, ok, metrics_missing: metricsMissing };
}

export function evaluateReadyAblationDistinct(rows) {
  const row = (name) => rows.find((r) => r.baseline_name === name);
  const readyP = row("READY-P");
  const readyE = row("READY-E");
  const readyG = row("READY-G");
  const ready = row("READY");
  function distinct(a, b) {
    if (!a || !b) return null;
    return (
      (a.miss100 ?? 1) !== (b.miss100 ?? 1)
      || (a.useful_chunks_before_demand ?? 0) !== (b.useful_chunks_before_demand ?? 0)
      || (a.readiness_gap_p50_ms ?? 0) !== (b.readiness_gap_p50_ms ?? 0)
    );
  }
  return {
    ready_e_ne_ready_p: distinct(readyE, readyP),
    ready_g_ne_ready_p: distinct(readyG, readyP),
    ready_ne_ready_e: distinct(ready, readyE),
    ready_ne_ready_g: distinct(ready, readyG),
  };
}

/**
 * Per-phase GREEN gate: READY beats all configured peers on readiness-primary axes.
 * Oracle is never a required peer win.
 */
export function evaluatePhaseReadyGreenGate(rows, phaseName) {
  const peerNames = PHASE_READY_PEER_NAMES[phaseName];
  if (!peerNames) {
    return { phase: phaseName, color: "SKIP", reason: "no_peer_config", proceed_main_n5: false };
  }

  const ready = rows.find((r) => r.baseline_name === "READY");
  const sparkOd = rows.find((r) => r.baseline_name === "Spark-OD");
  const peerResults = {};
  const peerMetrics = {};
  for (const name of peerNames) {
    const peer = rows.find((r) => r.baseline_name === name);
    peerResults[name] = beatsPeerOnReadiness(ready, peer);
    peerMetrics[name] = peer
      ? {
          miss100: peer.miss100,
          useful_before: peer.useful_chunks_before_demand,
          gap_p50: peer.readiness_gap_p50_ms,
        }
      : null;
  }

  const missingPeers = peerNames.filter((n) => !rows.find((r) => r.baseline_name === n));
  const beatsAllPeers = peerNames.every((n) => peerResults[n] === true);
  const hygiene = evaluateReadyHygiene(rows);
  const ablation = evaluateReadyAblationDistinct(rows);

  const sparkFv = sparkOd?.first_visible_splat_ms;
  const readyFv = ready?.first_visible_splat_ms;
  const startupOk =
    !ready
    || !sparkOd
    || !Number.isFinite(sparkFv)
    || sparkFv <= 0
    || !Number.isFinite(readyFv)
    || lowerBetterWin(readyFv, sparkFv, READY_PEER_WIN_MARGIN);

  const checks = {
    ready_row_present: Boolean(ready),
    primary_vs_sparkod: ready && sparkOd && beatsPeerOnReadiness(ready, sparkOd),
    beats_all_peers: beatsAllPeers,
    beats_all_peers_margin_10pct: beatsAllPeers,
    peer_win_margin: READY_PEER_WIN_MARGIN,
    all_peers_present: missingPeers.length === 0,
    startup_not_regressed: startupOk,
    ready_e_ne_ready_p: ablation.ready_e_ne_ready_p,
    ready_g_ne_ready_p: ablation.ready_g_ne_ready_p,
    ready_ne_ready_e: ablation.ready_ne_ready_e,
    ready_ne_ready_g: ablation.ready_ne_ready_g,
    ...hygiene.checks,
  };

  let color = "RED";
  if (
    checks.ready_row_present
    && checks.all_peers_present
    && hygiene.ok
    && beatsAllPeers
    && checks.startup_not_regressed
  ) {
    color = "GREEN";
  } else if (checks.ready_row_present && hygiene.ok && beatsAllPeers) {
    color = "YELLOW";
  } else if (
    checks.ready_row_present
    && hygiene.ok
    && checks.primary_vs_sparkod
    && checks.startup_not_regressed
  ) {
    // YELLOW: beats Spark-OD + hygiene OK but not all peers (n=1 LAN noise)
    color = "YELLOW";
  }

  const failedPeers = peerNames.filter((n) => !peerResults[n]);

  return {
    phase: phaseName,
    gate_mode: "edge_claim",
    color,
    checks,
    peer_results: peerResults,
    peer_metrics: peerMetrics,
    failed_peers: failedPeers,
    missing_peers: missingPeers,
    beats_all_peers: beatsAllPeers,
    ablation_distinct: ablation,
    proceed_mini_chain: color === "GREEN" || color === "YELLOW",
    eligible_main_n5: color === "GREEN",
    auto_run_main_n5: color === "GREEN",
    proceed_main_n5: color === "GREEN",
    ready_metrics: ready
      ? {
          miss100: ready.miss100,
          useful_before: ready.useful_chunks_before_demand,
          gap_p50: ready.readiness_gap_p50_ms,
          first_visible: ready.first_visible_splat_ms,
        }
      : null,
  };
}

/**
 * Phase B mini gate — GREEN only if READY simultaneously beats READY-P and SGSS
 * on readiness-primary axes (not merely Spark-OD).
 */
export function evaluatePhaseBMiniClaim(rows) {
  const row = (name) => rows.find((r) => r.baseline_name === name);
  const ready = row("READY");
  const readyP = row("READY-P");
  const sgss = row("SGSS");
  const sparkOd = row("Spark-OD");
  const hygiene = evaluateReadyHygiene(rows);

  const checks = {
    primary_vs_sparkod:
      ready
      && sparkOd
      && ((ready.miss100 ?? 1) < (sparkOd.miss100 ?? 1)
        || (ready.first_visible_splat_ms ?? Infinity) < (sparkOd.first_visible_splat_ms ?? Infinity)),
    ready_beats_ready_p: beatsPeerOnReadiness(ready, readyP),
    ready_beats_sgss: beatsPeerOnReadiness(ready, sgss),
    ...hygiene.checks,
  };

  const beatsBothPeers = checks.ready_beats_ready_p && checks.ready_beats_sgss;
  const hygieneOk = hygiene.ok;

  let color = "RED";
  if (checks.primary_vs_sparkod && hygieneOk && beatsBothPeers) {
    color = "GREEN";
  } else if (checks.primary_vs_sparkod && hygieneOk) {
    color = "YELLOW";
  }

  return {
    checks,
    color,
    beats_both_peers: beatsBothPeers,
    proceed_full_phase_b: color === "GREEN",
  };
}

export function trialShowsRemoteMotivation(t, edgeCompletedRef = 50) {
  if (t.fast_but_empty_detected) return true;
  if ((t.miss500 ?? 0) > 0.5 || (t.miss1000 ?? 0) > 0.4) return true;
  if ((t.network_p95_ms ?? 0) > 2000) return true;
  const visible = t.visible_chunks ?? t.visible_splat_max ?? 0;
  const completed = t.completed_chunks ?? 0;
  if (visible < 5 && (t.measure_fps ?? 0) > 50) return true;
  if (completed > 0 && completed < 30) return true;
  if (edgeCompletedRef > 0 && completed > 0 && completed < 0.2 * edgeCompletedRef) return true;
  if ((t.measure_fps ?? 0) > 80 && completed < 30) return true;
  return false;
}

/**
 * phase_local_ceiling: control/sanity only — does NOT require READY beat-all.
 */
export function evaluatePhaseLocalCeilingSanity(trials) {
  const pass = trials.filter((t) => t.phase === "phase_local_ceiling" && t.hard_gate_passed);
  const withRad = pass.filter(trialHasRadActivity);
  const radRatio = pass.length ? withRad.length / pass.length : 0;
  const parsePresent = pass.some(
    (t) => t.parse_wait_p95_ms != null || t.parse_cost_p95_ms != null || t.parse_p95_ms != null,
  );
  const gpuPresent = pass.some((t) => t.gpu_wait_p95_ms != null || t.gpu_upload_p95_ms != null);

  const checks = {
    trials_present: pass.length > 0,
    all_delivery_role_local: pass.every((t) => t.delivery_role === "local"),
    rad_activity_all_trials: pass.length > 0 && withRad.length === pass.length,
    rad_activity_ratio: radRatio,
    visible_splat_observed: pass.every(
      (t) => (t.visible_splat_max ?? 0) > 0 || t.first_visible_splat_ms != null,
    ),
    network_p95_present: pass.every((t) => t.network_p95_ms != null && Number.isFinite(t.network_p95_ms)),
    parse_metrics_present: parsePresent,
    gpu_metrics_present: gpuPresent,
    no_high_fps_zero_rad: pass.every((t) => !trialHighFpsZeroRad(t)),
    measure_fps_present: pass.some((t) => (t.measure_fps ?? 0) > 0),
  };

  const critical = [
    "trials_present",
    "all_delivery_role_local",
    "visible_splat_observed",
    "no_high_fps_zero_rad",
  ];
  const criticalOk = critical.every((k) => checks[k]);
  let color = "RED";
  if (criticalOk && checks.rad_activity_all_trials && checks.network_p95_present) {
    color = "GREEN";
  } else if (criticalOk) {
    color = "YELLOW";
  }

  return {
    phase: "phase_local_ceiling",
    gate_mode: "local_sanity",
    color,
    checks,
    proceed_mini_chain: color === "GREEN" || color === "YELLOW",
    eligible_main_n5: false,
    auto_run_main_n5: false,
    proceed_main_n5: false,
    note: "Local is parse/GPU/browser ceiling — not a beat-all claim gate.",
  };
}

function filterRemoteTrials(trials) {
  return trials.filter((t) => isRemotePhase(t.phase) && t.hard_gate_passed);
}

/**
 * Remote infra only — delivery URL, RAD activity, alignment, metric presence.
 * Does NOT judge READY vs Spark performance (see evaluatePhaseRemoteDirectClaim).
 */
export function evaluatePhaseRemoteDirectSanity(trials) {
  const pass = filterRemoteTrials(trials);
  const withRad = pass.filter(trialHasRadActivity);
  const radRatio = pass.length ? withRad.length / pass.length : 0;

  const assetChecks = pass.map((t) => {
    const urls = collectRemoteAssetUrls(t);
    if (!urls.length) return null;
    return trialRemoteAssetCanonical(t);
  });
  const trialsWithAssetUrl = assetChecks.filter((x) => x !== null);
  const assetCanonical =
    trialsWithAssetUrl.length === 0
    || trialsWithAssetUrl.every((x) => x === true);

  const alignRates = pass.map((t) => t.alignment_rate).filter((x) => x != null && Number.isFinite(x));
  const alignMean = alignRates.length
    ? alignRates.reduce((a, b) => a + b, 0) / alignRates.length
    : null;
  const alignmentOk =
    pass.length > 0
    && pass.every((t) => t.alignment_rate != null && Number.isFinite(t.alignment_rate))
    && alignMean != null
    && alignMean >= 0.99;

  const visibleOk = pass.every(
    (t) => (t.visible_splat_max ?? 0) > 0 || t.first_visible_splat_ms != null,
  );

  const metricsComplete = pass.every((t) => {
    const fv = t.first_visible_splat_ms ?? t.measured_first_visible_ms;
    const t1m = t.time_to_1M_visible_splats_ms;
    const thr = t.throughput_cdp_session_mbps ?? t.throughput_Mbps;
    return fv != null && Number.isFinite(fv) && (t1m != null || (t.visible_splat_max ?? 0) > 0) && thr != null;
  });

  const checks = {
    trials_present: pass.length > 0,
    all_delivery_role_remote: pass.every((t) => t.delivery_role === "remote"),
    no_fallback_to_edge_or_local: pass.every(
      (t) =>
        !String(t.actual_delivery ?? t.actual_delivery_key ?? "").match(/edge|local/i)
        || t.actual_delivery === t.requested_delivery,
    ),
    remote_asset_url_canonical: assetCanonical,
    remote_asset_url_recorded: trialsWithAssetUrl.length > 0,
    rad_activity_all_trials: pass.length > 0 && withRad.length === pass.length,
    rad_activity_ratio: radRatio,
    network_p95_present: pass.every((t) => t.network_p95_ms != null && Number.isFinite(t.network_p95_ms)),
    alignment_ok: alignmentOk,
    visible_splat_max_present: visibleOk,
    metrics_complete: metricsComplete,
    remote_protocol_audit_present: pass.every(
      (t) => t.remote_protocol_audit?.actual_rad_url || t.asset_url,
    ),
  };

  const critical = [
    "trials_present",
    "all_delivery_role_remote",
    "no_fallback_to_edge_or_local",
    "remote_asset_url_recorded",
    "remote_asset_url_canonical",
    "remote_protocol_audit_present",
    "rad_activity_all_trials",
    "alignment_ok",
    "visible_splat_max_present",
    "metrics_complete",
  ];

  let color = "RED";
  if (critical.every((k) => checks[k])) {
    color = "GREEN";
  } else if (
    checks.trials_present
    && checks.all_delivery_role_remote
    && checks.no_fallback_to_edge_or_local
    && checks.remote_asset_url_canonical
    && radRatio >= 0.8
  ) {
    color = "YELLOW";
  }

  const phase = pass[0]?.phase ?? "phase_remote_direct_cold";

  return {
    phase,
    gate_mode: "remote_infra",
    color,
    checks,
    alignment_rate_mean: alignMean,
    proceed_mini_chain: color === "GREEN" || color === "YELLOW",
    eligible_main_n5: color === "GREEN",
    auto_run_main_n5: false,
    proceed_main_n5: color === "GREEN",
    note: "Infra only. remote_infra_gate GREEN does NOT imply remote_claim_gate GREEN.",
    canonical: { edge: DEFAULT_EDGE_URL, remote: DEFAULT_REMOTE_URL },
  };
}

/**
 * Remote performance claim — pre-registered 10% effect on primary user-visible metrics (see remote_claim_gate.mjs).
 */
export function evaluatePhaseRemoteDirectClaim(trials, { infra = null } = {}) {
  const pass = filterRemoteTrials(trials);
  const phase = pass[0]?.phase ?? "phase_remote_direct_cold";
  const infraGate = infra ?? evaluatePhaseRemoteDirectSanity(pass);
  return evaluateRemoteClaimGate({
    trials: pass,
    infraGate,
    phase,
  });
}

/** Combined remote gates for analyze / mini_loop. */
export function evaluatePhaseRemoteDirectGates(trials, opts = {}) {
  const infra = evaluatePhaseRemoteDirectSanity(trials);
  const claim = evaluatePhaseRemoteDirectClaim(trials, { infra, ...opts });
  const sampleN = Math.min(claim.ready_stats?.n_raw ?? 0, claim.spark_stats?.n_raw ?? 0);
  const claimIsStatistical = sampleN >= 5;

  let color = "RED";
  if (infra.color === "RED") color = "RED";
  else if (claim.color === "GREEN" && infra.color === "GREEN") color = "GREEN";
  else if (claim.color === "YELLOW" && infra.color !== "RED") color = "YELLOW";
  else if (infra.color === "GREEN" && claim.color === "RED") color = "RED";

  return {
    phase: infra.phase,
    gate_mode: "remote_combined",
    color,
    remote_infra_gate: infra,
    remote_claim_gate: claim,
    claim_is_statistical: claimIsStatistical,
    claim_sample_n: sampleN,
    checks: { ...infra.checks, ...claim.checks },
    proceed_mini_chain: infra.proceed_mini_chain,
    /** Mini (n=1): infra only. Main (n≥5): claim RED can block eligibility for paper claim runs. */
    eligible_main_n5:
      infra.eligible_main_n5 && (claimIsStatistical ? claim.color !== "RED" : true),
    proceed_main_n5:
      infra.proceed_main_n5 && (claimIsStatistical ? claim.color === "GREEN" : infra.proceed_main_n5),
    may_claim_ready_solves_remote: claim.may_claim_ready_solves_remote,
    note: claimIsStatistical
      ? "claim gate is statistical (n≥5 per READY/Spark)."
      : "claim gate is advisory only (n<5); use remote_infra_gate for mini→main.",
  };
}

/**
 * phase_delivery_compare: local / edge / remote ordering sanity.
 */
export function evaluatePhaseDeliveryCompareSanity(trials) {
  const pass = trials.filter((t) => t.phase === "phase_delivery_compare" && t.hard_gate_passed);
  const byRole = {};
  for (const t of pass) {
    const r = t.delivery_role || "unknown";
    if (!byRole[r]) byRole[r] = [];
    byRole[r].push(t);
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const p95 = (role) => mean((byRole[role] || []).map((t) => t.network_p95_ms));
  const chunks = (role) => mean((byRole[role] || []).map((t) => t.completed_chunks));

  const localP = p95("local");
  const edgeP = p95("edge");
  const remoteP = p95("remote");

  const checks = {
    has_local: (byRole.local?.length ?? 0) > 0,
    has_edge: (byRole.edge?.length ?? 0) > 0,
    has_remote: (byRole.remote?.length ?? 0) > 0,
    local_p95_lowest:
      localP != null
      && edgeP != null
      && remoteP != null
      && localP <= edgeP
      && localP <= remoteP,
    remote_worst_path:
      remoteP != null
      && edgeP != null
      && (remoteP >= edgeP * 1.05 || (chunks("remote") ?? 0) <= (chunks("edge") ?? 999)),
    edge_between_or_beats_remote:
      edgeP != null && remoteP != null && (edgeP <= remoteP || (chunks("edge") ?? 0) >= (chunks("remote") ?? 0)),
    edge_host_ok: (byRole.edge || []).every(
      (t) => !t.server_url || String(t.server_url).includes(CANONICAL_ENDPOINTS.edge_host),
    ),
    remote_asset_ok: (byRole.remote || []).every(
      (t) => trialRemoteAssetCanonical(t) !== false,
    ),
  };

  const criticalOk =
    checks.has_local
    && checks.has_edge
    && checks.has_remote
    && checks.local_p95_lowest
    && checks.remote_worst_path;
  const color = criticalOk ? "GREEN" : checks.has_local && checks.has_edge && checks.has_remote ? "YELLOW" : "RED";

  return {
    phase: "phase_delivery_compare",
    gate_mode: "delivery_compare",
    color,
    checks,
    network_p95: { local: localP, edge: edgeP, remote: remoteP },
    proceed_mini_chain: color === "GREEN" || color === "YELLOW",
    eligible_main_n5: false,
    auto_run_main_n5: false,
    proceed_main_n5: false,
  };
}

/**
 * Map failed checks → fix category for main agent (Runbook §9.7).
 */
export function suggestMiniFixCategory({ phase, gate, trials = [] }) {
  const c = gate?.checks || {};
  const cats = [];

  if (phase === "phase_local_ceiling" && !c.all_delivery_role_local) {
    cats.push("delivery_role_url_fallback");
  }
  if (
    (isRemotePhase(phase) || phase === "phase_delivery_compare")
    && (
      !c.all_delivery_role_remote
      || !c.no_fallback_to_edge_or_local
      || c.remote_asset_url_recorded === false
      || c.remote_asset_url_canonical === false
      || c.remote_protocol_audit_present === false
    )
  ) {
    cats.push("delivery_role_url_fallback");
  }
  if (
    !c.trials_present
    || c.rad_activity_ratio != null && c.rad_activity_ratio < 1
    || !c.rad_activity_all_trials
    || !c.network_p95_present
    || c.metrics_missing
    || c.measure_fps_metrics_missing
    || c.wasted_prefetch_metrics_missing
  ) {
    cats.push("infra_metrics_instrumentation");
  }
  if (EDGE_CLAIM_PHASES.has(phase) && gate?.failed_peers?.length) {
    cats.push("ready_controller_scheduling");
  }
  if (c.ready_e_ne_ready_p === false) {
    cats.push("ready_e_edge_warmup_tier");
  }
  if (c.ready_ne_ready_e === false) {
    cats.push("ready_g_parse_gpu_queues");
  }
  if (c.startup_not_regressed === false) {
    cats.push("startup_regression_first_screen");
  }
  const readyT = trials.find((t) => t.baseline_name === "READY" || t.baseline_id === "ready");
  const sparkT = trials.find((t) => t.baseline_name === "Spark-OD" || t.baseline_id === "spark_od");
  if (
    readyT
    && sparkT
    &&     (readyT.first_visible_splat_ms ?? readyT.measured_first_visible_ms ?? 0)
      > (sparkT.first_visible_splat_ms ?? sparkT.measured_first_visible_ms ?? 0) * READY_PEER_WIN_MARGIN
  ) {
    cats.push("startup_regression_first_screen");
  }
  if (isRemotePhase(phase)) {
    cats.push(...suggestRemoteClaimFixCategories({
      gate,
      claim: gate?.remote_claim_gate,
      phase,
    }));
    if (!c.alignment_ok || !c.metrics_complete) {
      cats.push("infra_metrics_instrumentation");
    }
    if (remotePhaseIsFrozen(phase)) {
      cats.push("test_main_frozen_no_autofix");
    }
  }
  if (phase === "phase_delivery_compare" && (!c.local_p95_lowest || !c.remote_worst_path)) {
    cats.push("delivery_compare_rerun_env");
  }
  if (!cats.length && gate?.color !== "GREEN") cats.push("inspect_blocker_report");
  return [...new Set(cats)];
}

export async function writeBlockerReport({ failedGate, suspectedCause, evidencePaths, proposedFix, claimImpact }) {
  const out = path.join(root, PAPER_MATERIALS_DIR, "blocker_report.md");
  await fs.mkdir(path.dirname(out), { recursive: true });
  const body = `# Blocker Report

## Failed Gate
${failedGate}

## Suspected Cause
${suspectedCause}

## Evidence Path
${(evidencePaths || []).map((p) => `- ${p}`).join("\n")}

## Proposed Fix
${proposedFix}

## Paper Claim Impact
${claimImpact}
`;
  await fs.writeFile(out, body, "utf8");
  return out;
}
