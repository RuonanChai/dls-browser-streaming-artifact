/**
 * Optimization batch trial rows + arm aggregation.
 */
import { summarizeFrameMetrics } from "./local_stutter_ablation_metrics.mjs";
import { validateNvidiaTrial } from "./local_stutter_confirm_gpu.mjs";

function frameThresholdCounts(fts) {
  const xs = (fts ?? []).filter((x) => x > 0 && x < 5000);
  return {
    frames_over_33ms: xs.filter((x) => x > 33.33).length,
    frames_over_100ms: xs.filter((x) => x > 100).length,
    frame_p95_ms: xs.length
      ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]
      : 0,
  };
}

export function buildOptimizationTrialRow({
  runId,
  timestamp,
  arm,
  trialId,
  row,
  gpuBackend,
  probeExtras,
  chromeExecutable,
  chromeArgs,
}) {
  const measureFts = probeExtras?.measure_frame_times ?? [];
  const fm = summarizeFrameMetrics(measureFts);
  const thresh = frameThresholdCounts(measureFts);
  const gpuVal = validateNvidiaTrial(gpuBackend, chromeArgs);

  return {
    run_id: runId,
    timestamp,
    arm_id: arm.id,
    arm_name: arm.name,
    arm_group: arm.group ?? "",
    trial_id: trialId,
    trial_valid: gpuVal.trial_valid && row?.trace_ok !== false,
    invalid_reason: gpuVal.invalid_reason || "",
    ablation_mode: row?.ablation_mode,
    measure_fps: row?.measure_fps_mean ?? null,
    preload_fps: row?.preload_fps_mean ?? null,
    frame_p95_ms: fm.frame_p95_ms ?? thresh.frame_p95_ms,
    frames_over_33ms: fm.long_frame_over_33ms_count ?? thresh.frames_over_33ms,
    frames_over_100ms: fm.long_frame_over_100ms_count ?? thresh.frames_over_100ms,
    measure_rad_requests: row?.measure_rad_requests,
    server_p95_ms: row?.server_total_p95_ms,
    client_net_p95_ms: row?.client_network_total_p95_ms,
    visible_splat_count: row?.visible_splat_count ?? probeExtras?.visible_splat_count,
    target_rendered_splats: row?.target_rendered_splats ?? probeExtras?.target_rendered_splats,
    rendered_splat_count: row?.rendered_splat_count,
    render_scale_current: probeExtras?.render_scale_current ?? row?.render_scale_current,
    render_scale_mean: probeExtras?.render_scale_mean ?? row?.render_scale_mean,
    render_scale_min: probeExtras?.render_scale_min ?? row?.render_scale_min,
    render_scale_change_count: probeExtras?.render_scale_change_count ?? row?.render_scale_change_count,
    budget_scale_current: probeExtras?.budget_scale_current ?? row?.budget_scale_current,
    budget_scale_mean: probeExtras?.budget_scale_mean ?? row?.budget_scale_mean,
    budget_scale_min: probeExtras?.budget_scale_min ?? row?.budget_scale_min,
    budget_scale_change_count: probeExtras?.budget_scale_change_count ?? row?.budget_scale_change_count,
    lod_update_count: probeExtras?.lod_update_count ?? row?.lod_update_count,
    visibility_update_count: probeExtras?.visibility_update_count ?? row?.visibility_update_count,
    skipped_lod_update_count: probeExtras?.skipped_lod_update_count ?? row?.skipped_lod_update_count,
    quality_proxy: probeExtras?.quality_proxy ?? row?.quality_proxy,
    devicePixelRatio: row?.device_pixel_ratio,
    drawingBufferWidth: row?.drawing_buffer_width,
    drawingBufferHeight: row?.drawing_buffer_height,
    gpu_renderer: row?.webgl_renderer,
    run_dir: row?.run_dir,
    VRC_OPT_ADAPTIVE_DPR: arm.vrcOpt?.adaptiveDpr ? 1 : 0,
    VRC_OPT_SPLAT_BUDGET: arm.vrcOpt?.splatBudget ? 1 : 0,
    VRC_OPT_LOD_THROTTLE: arm.vrcOpt?.lodThrottle ? 1 : 0,
  };
}

export function aggregateOptimizationByArm(trials) {
  const valid = trials.filter((t) => t.trial_valid);
  const byArm = new Map();
  for (const t of valid) byArm.set(t.arm_id, [...(byArm.get(t.arm_id) ?? []), t]);
  const rows = [];
  for (const [armId, ts] of byArm) {
    const nums = (k) => ts.map((x) => Number(x[k])).filter((n) => Number.isFinite(n));
    const mean = (k) => {
      const v = nums(k);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    rows.push({
      arm_id: armId,
      arm_name: ts[0]?.arm_name ?? armId,
      arm_group: ts[0]?.arm_group ?? "",
      valid_trials: ts.length,
      measure_fps_mean: mean("measure_fps"),
      frame_p95_mean: mean("frame_p95_ms"),
      frames_over_33ms_mean: mean("frames_over_33ms"),
      frames_over_100ms_mean: mean("frames_over_100ms"),
      render_scale_mean: mean("render_scale_mean"),
      budget_scale_mean: mean("budget_scale_mean"),
      quality_proxy_mean: mean("quality_proxy"),
      measure_rad_max: Math.max(0, ...nums("measure_rad_requests")),
    });
  }
  rows.sort((a, b) => a.arm_id.localeCompare(b.arm_id));
  return rows;
}
