/**
 * Remote-phase statistics: visible latency, quality@time, outlier filtering, claim gate inputs.
 */
import { READY_PEER_WIN_MARGIN } from "./constants.mjs";
import { timeToVisibleChunks } from "./readiness_metrics.mjs";

export const REMOTE_PHASE_NAMES = new Set([
  "phase_remote_direct",
  "phase_remote_direct_cold",
  "phase_remote_warm_equal",
  "phase_remote_dev",
  "phase_remote_validation",
  "phase_remote_test_main",
]);

export function isRemotePhase(phase) {
  return REMOTE_PHASE_NAMES.has(phase) || String(phase || "").startsWith("phase_remote");
}

/** Backfill visible metrics on legacy trial JSON (pre metrics_version 8). */
export function enrichRemoteTrialMetrics(t) {
  if (t.time_to_1M_visible_splats_ms != null && t.quality_at_5s != null) return t;
  const vis =
    t.visible_splat_timeline
    || t.proactive_snapshot?.visible_splat_timeline
    || [];
  if (!vis.length) return t;
  const m = computeVisibleTimelineMetrics(vis, t.measure_duration_ms ?? 40_000);
  return {
    ...t,
    time_to_1M_visible_splats_ms: t.time_to_1M_visible_splats_ms ?? m.time_to_1M_visible_splats_ms,
    quality_at_1s: t.quality_at_1s ?? m.quality_at_1s,
    quality_at_3s: t.quality_at_3s ?? m.quality_at_3s,
    quality_at_5s: t.quality_at_5s ?? t.visible_splat_count_5s ?? m.quality_at_5s,
    quality_at_10s: t.quality_at_10s ?? t.visible_splat_count_10s ?? m.quality_at_10s,
    blank_ratio: t.blank_ratio ?? m.blank_ratio,
    blank_ratio_0_10s: t.blank_ratio_0_10s ?? m.blank_ratio_0_10s,
    blank_time_ms: t.blank_time_ms ?? m.blank_time_ms,
  };
}

export function timeToVisibleSplats(timeline, targetSplats = 1_000_000) {
  for (const e of timeline || []) {
    if ((e.visible_splat_count ?? 0) >= targetSplats) return e.t;
  }
  return null;
}

/** Alias for paper / gate wording. */
export function timeTo1MVisibleSplats(timeline) {
  return timeToVisibleSplats(timeline, 1_000_000);
}

export function visibleAtSec(timeline, sec) {
  const target = sec * 1000;
  let best = 0;
  for (const e of timeline || []) {
    if ((e.t ?? 0) <= target) best = Math.max(best, e.visible_splat_count ?? 0);
  }
  return best;
}

export function computeVisibleTimelineMetrics(timeline, measureDurationMs = 40_000) {
  const tl = timeline || [];
  const visibleMax = tl.reduce((m, e) => Math.max(m, e.visible_splat_count ?? 0), 0);
  const fv =
    tl.find((e) => (e.visible_splat_count ?? 0) > 0)?.t ?? null;

  let blankMs = 0;
  let lastT = 0;
  let hadVisible = false;
  for (const e of tl) {
    const t = e.t ?? 0;
    const vis = (e.visible_splat_count ?? 0) > 0;
    if (!hadVisible && !vis && t > lastT) blankMs += t - lastT;
    if (vis) hadVisible = true;
    lastT = t;
  }
  if (!hadVisible) blankMs = measureDurationMs;

  let blankMs0_10 = 0;
  let lastT10 = 0;
  let hadVisible10 = false;
  const windowMs = 10_000;
  for (const e of tl) {
    const t = e.t ?? 0;
    if (t > windowMs) break;
    const vis = (e.visible_splat_count ?? 0) > 0;
    if (!hadVisible10 && !vis && t > lastT10) blankMs0_10 += t - lastT10;
    if (vis) hadVisible10 = true;
    lastT10 = t;
  }
  if (!hadVisible10) blankMs0_10 = Math.min(windowMs, measureDurationMs);

  const duration = Math.max(1, measureDurationMs);
  // quality_at_Ns: visible splats at N seconds AFTER first_visible (user-perceived t0).
  // This aligns with first_visible_splat_ms which uses startup_monitor_t0.
  const fvOffsetMs = fv ?? 0;
  function visibleAfterFv(sec) {
    const target = fvOffsetMs + sec * 1000;
    let best = 0;
    for (const e of tl) {
      if ((e.t ?? 0) <= target) best = Math.max(best, e.visible_splat_count ?? 0);
    }
    return best;
  }
  return {
    first_visible_splat_ms: fv,
    time_to_1M_visible_splats_ms: timeTo1MVisibleSplats(tl),
    time_to_50_visible_chunks_ms: timeToVisibleChunks(tl, 50),
    visible_splat_max: visibleMax,
    visible_splat_count_1s: visibleAtSec(tl, 1),
    visible_splat_count_3s: visibleAtSec(tl, 3),
    visible_splat_count_5s: visibleAtSec(tl, 5),
    visible_splat_count_10s: visibleAtSec(tl, 10),
    quality_at_1s: visibleAfterFv(1),
    quality_at_3s: visibleAfterFv(3),
    quality_at_5s: visibleAfterFv(5),
    quality_at_10s: visibleAfterFv(10),
    session_t0_offset_ms: fvOffsetMs,
    blank_time_ms: blankMs,
    blank_ratio: blankMs / duration,
    blank_ratio_0_10s: blankMs0_10 / windowMs,
    empty_time_ms: blankMs,
  };
}

function percentile(v, p) {
  const a = [...v].filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1);
  return a[Math.max(0, idx)];
}

export function mean(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function std(xs) {
  const m = mean(xs);
  if (m == null) return null;
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
}

export function iqrBounds(values, k = 1.5) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 3) return null;
  const q1 = percentile(v, 25);
  const q3 = percentile(v, 75);
  const iqr = q3 - q1;
  return { lo: q1 - k * iqr, hi: q3 + k * iqr, q1, q3, iqr };
}

const HARD_FV_MS = 20_000;
const MIN_IQR_SPREAD_MS = 200;

/** Severe FV outlier: IQR on FV (n≥3) or hard cap when sibling normal exists. */
export function severeOutlierTrialKeys(trials, { field = "first_visible_splat_ms" } = {}) {
  const byBase = {};
  for (const t of trials) {
    const k = t.baseline_name || t.baseline_id;
    if (!byBase[k]) byBase[k] = [];
    byBase[k].push(t);
  }
  const flagged = new Set();
  for (const group of Object.values(byBase)) {
    for (const t of group) {
      const v = t[field];
      const hasNormal = group.some(
        (o) => o !== t && Number.isFinite(o[field]) && o[field] < 15_000,
      );
      if (Number.isFinite(v) && v >= HARD_FV_MS && hasNormal) flagged.add(t);
    }
    if (group.length < 3) continue;
    const vals = group.map((t) => t[field]).filter(Number.isFinite);
    const b = iqrBounds(vals);
    if (!b || b.iqr < MIN_IQR_SPREAD_MS) continue;
    for (const t of group) {
      const v = t[field];
      if (Number.isFinite(v) && (v < b.lo || v > b.hi)) flagged.add(t);
    }
  }
  return flagged;
}

export function trialMetric(t, key) {
  const map = {
    first_visible_splat_ms: t.first_visible_splat_ms ?? t.measured_first_visible_ms,
    time_to_1M_visible_splats_ms: t.time_to_1M_visible_splats_ms,
    visible_splat_max: t.visible_splat_max ?? t.visible_chunks,
    quality_at_5s: t.quality_at_5s ?? t.visible_splat_count_5s,
    cdp_rad_206_count: t.cdp_rad_206_count,
    completed_chunks: t.completed_chunks,
    measure_fps: t.measure_fps,
    frame_p95_ms: t.frame_p95_ms,
    throughput_cdp_session_mbps: t.throughput_cdp_session_mbps,
    blank_ratio: t.blank_ratio,
    blank_ratio_0_10s: t.blank_ratio_0_10s,
    bytes_per_visible_splat:
      t.bytes_per_visible_splat
      ?? ((t.total_received_bytes ?? 0) > 0 && (t.visible_splat_max ?? 0) > 0
        ? (t.total_received_bytes ?? 0) / (t.visible_splat_max ?? 1)
        : null),
  };
  return map[key] ?? t[key];
}

export function aggregateBaselineRemoteStats(
  trials,
  baselineName,
  { outlierField = "first_visible_splat_ms", keepAll = false } = {},
) {
  const all = trials.filter(
    (t) => (t.baseline_name || t.baseline_id) === baselineName && t.hard_gate_passed !== false,
  );
  const flagged = keepAll ? new Set() : severeOutlierTrialKeys(all, { field: outlierField });
  const keep = keepAll ? all : all.filter((t) => !flagged.has(t));

  const pick = (arr, key) => arr.map((t) => trialMetric(t, key)).filter(Number.isFinite);

  const fvAll = pick(all, "first_visible_splat_ms");
  const fvKeep = pick(keep, "first_visible_splat_ms");
  const t1mAll = pick(all, "time_to_1M_visible_splats_ms");
  const t1mKeep = pick(keep, "time_to_1M_visible_splats_ms");

  return {
    baseline_name: baselineName,
    n_raw: all.length,
    n_clean: keep.length,
    severe_outlier_count: flagged.size,
    outlier_trial_keys: [...flagged].map((t) => t.trial_key || t.trial_id),
    first_visible_ms_mean: mean(fvAll),
    first_visible_ms_std: std(fvAll),
    first_visible_ms_median: percentile(fvAll, 50),
    first_visible_ms_iqr: (() => {
      const b = iqrBounds(fvAll);
      return b ? b.iqr : null;
    })(),
    first_visible_ms_mean_filtered: mean(fvKeep),
    first_visible_ms_std_filtered: std(fvKeep),
    time_to_1M_visible_ms_mean: mean(t1mAll),
    time_to_1M_visible_ms_median: percentile(t1mAll, 50),
    time_to_1M_visible_ms_mean_filtered: mean(t1mKeep),
    visible_splat_max_mean: mean(pick(keep, "visible_splat_max")),
    visible_splat_max_median: percentile(pick(keep, "visible_splat_max"), 50),
    quality_at_5s_mean: mean(pick(keep, "quality_at_5s")),
    cdp_rad_206_count_mean: mean(pick(keep, "cdp_rad_206_count")),
    completed_chunks_mean: mean(pick(keep, "completed_chunks")),
    throughput_cdp_session_mbps_mean: mean(pick(keep, "throughput_cdp_session_mbps")),
    measure_fps_mean: mean(pick(keep, "measure_fps")),
    frame_p95_ms_mean: mean(pick(keep, "frame_p95_ms")),
    blank_ratio_mean: mean(pick(keep, "blank_ratio")),
    blank_ratio_0_10s_mean: mean(pick(keep, "blank_ratio_0_10s")),
    blank_ratio_0_10s_median: percentile(pick(keep, "blank_ratio_0_10s"), 50),
    quality_at_5s_median: percentile(pick(keep, "quality_at_5s"), 50),
    bytes_per_visible_splat_mean: mean(pick(keep, "bytes_per_visible_splat")),
    quality_at_1s_mean: mean(pick(keep, "quality_at_1s")),
    quality_at_3s_mean: mean(pick(keep, "quality_at_3s")),
    quality_at_10s_mean: pick(keep, "quality_at_10s").length ? mean(pick(keep, "quality_at_10s")) : null,
  };
}

export function compareReadyVsSpark(statsReady, statsSpark) {
  const readyFvMed = statsReady?.first_visible_ms_median;
  const sparkFvMed = statsSpark?.first_visible_ms_median;
  const readyFvFilt = statsReady?.first_visible_ms_mean_filtered;
  const sparkFvFilt = statsSpark?.first_visible_ms_mean_filtered;

  const readyT1m = statsReady?.time_to_1M_visible_ms_median ?? statsReady?.time_to_1M_visible_ms_mean_filtered;
  const sparkT1m = statsSpark?.time_to_1M_visible_ms_median ?? statsSpark?.time_to_1M_visible_ms_mean_filtered;

  const m = READY_PEER_WIN_MARGIN;
  const startupWin =
    (readyFvMed != null && sparkFvMed != null && sparkFvMed > 0 && readyFvMed <= sparkFvMed / m)
    || (readyT1m != null && sparkT1m != null && sparkT1m > 0 && readyT1m <= sparkT1m / m);

  const visReady = statsReady?.visible_splat_max_median ?? statsReady?.visible_splat_max_mean;
  const visSpark = statsSpark?.visible_splat_max_median ?? statsSpark?.visible_splat_max_mean;
  const q5Ready = statsReady?.quality_at_5s_mean;
  const q5Spark = statsSpark?.quality_at_5s_mean;
  const visibleContentWin =
    (visReady != null && visSpark != null && visSpark > 0 && visReady >= m * visSpark)
    || (q5Ready != null && q5Spark != null && q5Spark > 0 && q5Ready >= m * q5Spark);

  const radWin =
    (statsReady?.cdp_rad_206_count_mean ?? 0) >= m * (statsSpark?.cdp_rad_206_count_mean ?? 0);
  const chunkWin =
    (statsReady?.completed_chunks_mean ?? 0) >= m * (statsSpark?.completed_chunks_mean ?? 0);

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

  return {
    startupWin,
    visibleContentWin,
    radWin,
    chunkWin,
    dataActivityWin: radWin && chunkWin,
    readyLosesStartup,
    oppositeStories,
    readyFvMed,
    sparkFvMed,
    readyFvFilt,
    sparkFvFilt,
  };
}
