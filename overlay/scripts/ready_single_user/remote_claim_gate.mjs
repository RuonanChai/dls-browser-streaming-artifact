/**
 * Pre-registered remote claim gate — 10% effect size on primary user-visible metrics only.
 * Not remote_sanity / not RAD-206 / not network_p95 as primary wins.
 */
import { READY_PEER_WIN_MARGIN } from "./constants.mjs";
import { aggregateBaselineRemoteStats } from "./remote_stats.mjs";

/** Lower-is-better: READY <= (1/margin) * Spark → 10% improvement when margin=1.1 */
const LOWER_FACTOR = 1 / READY_PEER_WIN_MARGIN;
const HIGHER_FACTOR = READY_PEER_WIN_MARGIN;
const QUALITY_EXCEPTION_FACTOR = 1.2;
const BYTES_PER_VISIBLE_CAP = 1.5;
const FRAME_P95_CAP = 1.2;
const SEVERE_OUTLIER_RATE_MAX = 0.2;
const SEVERE_OUTLIER_RATE_IDEAL = 0.1;
const PRIMARY_WINS_REQUIRED = 2;

export const REMOTE_DEV_PHASES = new Set(["phase_remote_dev"]);
export const REMOTE_VALIDATION_PHASES = new Set(["phase_remote_validation"]);
export const REMOTE_TEST_MAIN_PHASES = new Set(["phase_remote_test_main"]);

export function remotePhaseAllowsAutoFix(phase) {
  return REMOTE_DEV_PHASES.has(phase) || REMOTE_VALIDATION_PHASES.has(phase);
}

export function remotePhaseIsFrozen(phase) {
  return REMOTE_TEST_MAIN_PHASES.has(phase);
}

function pickStat(stats, keys) {
  for (const k of keys) {
    const v = stats?.[k];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Evaluate 4 pre-registered primary metrics (median / mean aggregates). */
export function evaluateRemotePrimaryMetrics(readyStats, sparkStats) {
  const t1mR = pickStat(readyStats, ["time_to_1M_visible_ms_median", "time_to_1M_visible_ms_mean_filtered"]);
  const t1mS = pickStat(sparkStats, ["time_to_1M_visible_ms_median", "time_to_1M_visible_ms_mean_filtered"]);
  const t1mWin = t1mR != null && t1mS != null && t1mS > 0 && t1mR <= LOWER_FACTOR * t1mS;

  const blankR = pickStat(readyStats, ["blank_ratio_0_10s_median", "blank_ratio_0_10s_mean", "blank_ratio_mean"]);
  const blankS = pickStat(sparkStats, ["blank_ratio_0_10s_median", "blank_ratio_0_10s_mean", "blank_ratio_mean"]);
  const blankWin = blankR != null && blankS != null && blankS > 0 && blankR <= LOWER_FACTOR * blankS;

  const q5R = pickStat(readyStats, ["quality_at_5s_median", "quality_at_5s_mean"]);
  const q5S = pickStat(sparkStats, ["quality_at_5s_median", "quality_at_5s_mean"]);
  const q5Win = q5R != null && q5S != null && q5S > 0 && q5R >= HIGHER_FACTOR * q5S;

  const fvR = pickStat(readyStats, ["first_visible_ms_median"]);
  const fvS = pickStat(sparkStats, ["first_visible_ms_median"]);
  const fvWinAux = fvR != null && fvS != null && fvS > 0 && fvR <= LOWER_FACTOR * fvS;

  const wins = [
    { id: "time_to_1M_visible_splats", win: t1mWin, ready: t1mR, spark: t1mS, rule: "READY <= 0.9× Spark" },
    { id: "blank_ratio_0_10s", win: blankWin, ready: blankR, spark: blankS, rule: "READY <= 0.9× Spark" },
    { id: "quality_at_5s", win: q5Win, ready: q5R, spark: q5S, rule: "READY >= 1.1× Spark" },
    { id: "first_visible_splat_ms_aux", win: fvWinAux, ready: fvR, spark: fvS, rule: "READY <= 0.9× Spark (aux)" },
  ];
  const winCount = wins.filter((w) => w.win).length;

  const startupWin = t1mWin || fvWinAux;
  const timeToContentWin = t1mWin;
  const visibleContentWin = q5Win;

  return {
    wins,
    win_count: winCount,
    primary_two_of_four: winCount >= PRIMARY_WINS_REQUIRED,
    startup_win: startupWin,
    time_to_content_win: timeToContentWin,
    visible_content_win: visibleContentWin,
    t1m_win: t1mWin,
    blank_win: blankWin,
    q5_win: q5Win,
    fv_aux_win: fvWinAux,
  };
}

/** Same primaries on raw (unfiltered) medians — detect outlier-only wins. */
export function evaluateRemotePrimaryMetricsRaw(trials, readyName = "READY", sparkName = "Spark-OD") {
  const readyStats = aggregateBaselineRemoteStats(trials, readyName, { keepAll: true });
  const sparkStats = aggregateBaselineRemoteStats(trials, sparkName, { keepAll: true });
  return evaluateRemotePrimaryMetrics(readyStats, sparkStats);
}

export function evaluateRemoteClaimGate({
  trials,
  infraGate,
  readyName = "READY",
  sparkName = "Spark-OD",
  phase = "phase_remote_direct_cold",
}) {
  const readyStats = aggregateBaselineRemoteStats(trials, readyName);
  const sparkStats = aggregateBaselineRemoteStats(trials, sparkName);
  const sampleN = Math.min(readyStats?.n_raw ?? 0, sparkStats?.n_raw ?? 0);

  if (!infraGate || infraGate.color === "RED") {
    return buildClaimResult({
      phase,
      color: "RED",
      reason: "infra_not_green",
      infraGate,
      readyStats,
      sparkStats,
      sampleN,
    });
  }

  if (!readyStats?.n_raw || !sparkStats?.n_raw) {
    return buildClaimResult({
      phase,
      color: "RED",
      reason: "missing_ready_or_spark_rows",
      infraGate,
      readyStats,
      sparkStats,
      sampleN,
    });
  }

  const primary = evaluateRemotePrimaryMetrics(readyStats, sparkStats);
  let primaryRaw = null;
  try {
    primaryRaw = evaluateRemotePrimaryMetricsRaw(trials, readyName, sparkName);
  } catch {
    primaryRaw = primary;
  }

  const winsOnlyAfterOutlierRemoval =
    (primaryRaw?.win_count ?? 0) < PRIMARY_WINS_REQUIRED && primary.primary_two_of_four;

  const readyFvMed = readyStats.first_visible_ms_median;
  const sparkFvMed = sparkStats.first_visible_ms_median;
  const readyFvFilt = readyStats.first_visible_ms_mean_filtered;
  const sparkFvFilt = sparkStats.first_visible_ms_mean_filtered;

  const readyLosesStartup =
    readyFvMed != null
    && sparkFvMed != null
    && readyFvMed > sparkFvMed
    && readyFvFilt != null
    && sparkFvFilt != null
    && readyFvFilt > sparkFvFilt;

  const oppositeStories =
    readyFvMed != null
    && sparkFvMed != null
    && readyFvFilt != null
    && sparkFvFilt != null
    && ((readyFvMed < sparkFvMed && readyFvFilt > sparkFvFilt)
      || (readyFvMed > sparkFvMed && readyFvFilt < sparkFvFilt));

  const startupWin = primary.startup_win && !readyLosesStartup;

  const readyFps = readyStats.measure_fps_mean;
  const sparkFp95 = sparkStats.frame_p95_ms_mean;
  const readyFp95 = readyStats.frame_p95_ms_mean;

  const fpsOk = readyFps != null && readyFps >= 60;
  const frameP95Ok =
    readyFp95 == null
    || sparkFp95 == null
    || !Number.isFinite(sparkFp95)
    || sparkFp95 <= 0
    || readyFp95 <= FRAME_P95_CAP * sparkFp95;

  const readyOutlierRate = sampleN > 0 ? (readyStats.severe_outlier_count ?? 0) / sampleN : 0;
  const sparkOutlierRate = sampleN > 0 ? (sparkStats.severe_outlier_count ?? 0) / sampleN : 0;
  const outlierRateOk =
    readyOutlierRate <= SEVERE_OUTLIER_RATE_MAX && sparkOutlierRate <= SEVERE_OUTLIER_RATE_MAX;

  const bpvR = readyStats.bytes_per_visible_splat_mean;
  const bpvS = sparkStats.bytes_per_visible_splat_mean;
  const q5Ratio =
    primary.wins.find((w) => w.id === "quality_at_5s")?.spark > 0
      ? (primary.wins.find((w) => w.id === "quality_at_5s")?.ready ?? 0)
        / primary.wins.find((w) => w.id === "quality_at_5s")?.spark
      : null;
  const bytesOk =
    bpvR == null
    || bpvS == null
    || bpvS <= 0
    || bpvR <= BYTES_PER_VISIBLE_CAP * bpvS
    || (q5Ratio != null && q5Ratio >= QUALITY_EXCEPTION_FACTOR);

  const metricsMissing =
    primary.wins.find((w) => w.id === "time_to_1M_visible_splats")?.ready == null
    && primary.wins.find((w) => w.id === "quality_at_5s")?.ready == null;

  const cacheUncontrolled = trials.some(
    (t) =>
      String(t.remote_protocol_audit?.cache_state || t.cache_state || "").match(/uncontrolled|mixed/i),
  );
  const cacheConflict = cacheUncontrolled && oppositeStories;

  const checks = {
    infra_green: infraGate.color === "GREEN",
    primary_two_of_four: primary.primary_two_of_four,
    primary_win_count: primary.win_count,
    startup_win: startupWin,
    time_to_content_win: primary.time_to_content_win,
    visible_content_win: primary.visible_content_win,
    fps_ge_60: fpsOk,
    frame_p95_safe: frameP95Ok,
    outlier_rate_ok: outlierRateOk,
    bytes_per_visible_ok: bytesOk,
    robust_no_opposite_stories: !oppositeStories,
    ready_not_loses_median_and_filtered_fv: !readyLosesStartup,
    wins_only_after_outlier_removal: winsOnlyAfterOutlierRemoval,
    metrics_not_missing: !metricsMissing,
    no_cache_conflict: !cacheConflict,
  };

  let color = "RED";
  let reason = "";

  if (!checks.infra_green) {
    color = "RED";
    reason = "infra_not_green";
  } else if (metricsMissing) {
    color = "RED";
    reason = "metrics_missing";
  } else if (!outlierRateOk) {
    color = "RED";
    reason = "outlier_rate_too_high";
  } else if (cacheConflict) {
    color = "RED";
    reason = "cache_uncontrolled_conflict";
  } else if (
    !primary.visible_content_win
    && !primary.time_to_content_win
    && !startupWin
  ) {
    color = "RED";
    reason = "loses_startup_and_visible";
  } else if (
    checks.primary_two_of_four
    && fpsOk
    && frameP95Ok
    && bytesOk
    && !oppositeStories
    && !readyLosesStartup
    && !winsOnlyAfterOutlierRemoval
    && sampleN >= 5
  ) {
    color = "GREEN";
    reason = "pre_registered_primary_2of4";
  } else if (winsOnlyAfterOutlierRemoval && primary.primary_two_of_four) {
    color = "YELLOW";
    reason = "wins_only_after_outlier_removal";
  } else if (
    primary.visible_content_win
    && !primary.time_to_content_win
    && !startupWin
    && fpsOk
  ) {
    color = "YELLOW";
    reason = "visible_gain_no_startup";
  } else if (
    (startupWin || primary.time_to_content_win)
    && !primary.visible_content_win
    && fpsOk
  ) {
    color = "YELLOW";
    reason = "startup_gain_no_visible";
  } else if (
    (primary.win_count >= 1 || primary.visible_content_win || startupWin)
    && sampleN < 5
  ) {
    color = "YELLOW";
    reason = "n_too_small_or_high_variance";
  } else if (primary.win_count >= 1 && fpsOk && !oppositeStories) {
    color = "YELLOW";
    reason = "directional_partial";
  } else {
    color = "RED";
    reason = reason || "claim_criteria_not_met";
  }

  if (remotePhaseIsFrozen(phase) && color !== "GREEN") {
    reason = `${reason};test_main_frozen_no_autofix`;
  }

  return buildClaimResult({
    phase,
    color,
    reason,
    infraGate,
    readyStats,
    sparkStats,
    sampleN,
    primary,
    primaryRaw,
    checks,
    startupWin,
    oppositeStories,
    readyOutlierRate,
    sparkOutlierRate,
    winsOnlyAfterOutlierRemoval,
  });
}

function buildClaimResult(ctx) {
  const {
    phase,
    color,
    reason = "",
    infraGate,
    readyStats,
    sparkStats,
    sampleN = 0,
    primary = null,
    primaryRaw = null,
    checks = {},
    startupWin = false,
    winsOnlyAfterOutlierRemoval = false,
    readyOutlierRate = 0,
    sparkOutlierRate = 0,
  } = ctx;

  const claimIsStatistical = sampleN >= 5;
  const autoFixAllowed = remotePhaseAllowsAutoFix(phase) && !remotePhaseIsFrozen(phase);

  return {
    phase,
    gate_mode: "remote_claim",
    color,
    reason,
    checks,
    primary_metrics: primary,
    primary_metrics_raw: primaryRaw,
    ready_stats: readyStats,
    spark_stats: sparkStats,
    claim_sample_n: sampleN,
    claim_is_statistical: claimIsStatistical,
    auto_fix_allowed: autoFixAllowed,
    code_frozen: remotePhaseIsFrozen(phase),
    proceed_mini_chain: false,
    eligible_main_n5: false,
    proceed_main_n5: false,
    may_claim_ready_solves_remote: color === "GREEN" && claimIsStatistical,
    may_write_motivation_only: color === "YELLOW",
    wins_only_after_outlier_removal: winsOnlyAfterOutlierRemoval,
    startup_win: startupWin,
    ready_outlier_rate: readyOutlierRate,
    spark_outlier_rate: sparkOutlierRate,
    note:
      color === "GREEN"
        ? "Pre-registered: ≥2/4 primary user-visible metrics at ≥10% vs Spark-OD; safety + robustness pass."
        : color === "YELLOW"
          ? "Partial remote effect — do not write full 'READY solves remote direct'."
          : "Do NOT write 'READY solves remote direct'. Infra GREEN alone is insufficient.",
  };
}

export function suggestRemoteClaimFixCategories({ gate, claim, phase, iteration = 0 }) {
  const cats = [];
  const c = claim?.checks || {};
  const infra = gate?.remote_infra_gate;

  if (infra?.color === "RED" || c.infra_green === false) {
    cats.push("infra_error");
  }
  if (claim?.reason === "metrics_missing" || c.metrics_not_missing === false) {
    cats.push("metric_missing");
  }
  if (claim?.reason === "cache_uncontrolled_conflict" || c.no_cache_conflict === false) {
    cats.push("cache_contamination");
  }
  if (c.startup_win === false || c.ready_not_loses_median_and_filtered_fv === false) {
    cats.push("startup_regression");
  }
  if (c.visible_content_win === false && c.primary_two_of_four === false) {
    cats.push("low_visible_content");
  }
  if (c.bytes_per_visible_ok === false) {
    cats.push("excessive_waste");
  }
  if (c.fps_ge_60 === false || c.frame_p95_safe === false) {
    cats.push("FPS_regression");
  }
  if (claim?.reason === "outlier_rate_too_high") {
    cats.push("statistically_unstable");
  }
  if (
    claim?.color === "RED"
    && !cats.length
    && iteration >= 2
  ) {
    cats.push("design_no_gain");
  }
  if (claim?.color === "RED" && sampleNSmall(claim)) {
    cats.push("statistically_unstable");
  }
  return [...new Set(cats)];
}

function sampleNSmall(claim) {
  return (claim?.claim_sample_n ?? 0) < 5;
}

export function getRemotePipelineDecision({ phase, infra, claim, iteration = 0 }) {
  if (remotePhaseIsFrozen(phase)) {
    return claim?.color === "GREEN" ? "report_only" : "stop";
  }
  if (infra?.color === "RED") {
    return iteration < 3 ? "continue_fix" : "stop";
  }
  if (claim?.color === "GREEN" && REMOTE_VALIDATION_PHASES.has(phase)) {
    return "freeze_and_test";
  }
  if (claim?.color === "GREEN" && REMOTE_DEV_PHASES.has(phase)) {
    return "advance_to_validation";
  }
  if (claim?.color === "RED" && iteration >= 3) {
    return "stop";
  }
  if (claim?.color === "RED" || claim?.color === "YELLOW") {
    return iteration < 3 ? "rerun_same_phase" : "stop";
  }
  return "rerun_same_phase";
}
