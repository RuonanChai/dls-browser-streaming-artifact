/**
 * Build confirm trial row with extended frame / network fields.
 */
import { stats, summarizeFrameMetrics } from "./local_stutter_ablation_metrics.mjs";
import { inferAngleBackend, validateNvidiaTrial } from "./local_stutter_confirm_gpu.mjs";

function frameThresholdCounts(fts) {
  const xs = (fts ?? []).filter((x) => x > 0 && x < 5000);
  return {
    frames_over_16ms: xs.filter((x) => x > 16.67).length,
    frames_over_33ms: xs.filter((x) => x > 33.33).length,
    frames_over_50ms: xs.filter((x) => x > 50).length,
    frames_over_100ms: xs.filter((x) => x > 100).length,
    frame_max_ms: xs.length ? Math.max(...xs) : 0,
    frame_mean_ms: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
  };
}

export function buildConfirmTrialRow({
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
  const renderer = gpuBackend?.webgl_renderer || row?.webgl_renderer || "";
  const pureModes = new Set([
    "render_only_pure",
    "static_camera_render_only_pure",
    "moving_camera_render_only_pure",
  ]);
  const isPure = pureModes.has(row?.ablation_mode);
  let pureOk = row?.pure_render_valid === true || row?.pure_render_valid === "true";
  if (isPure && Number(row?.measure_rad_requests) > 0) {
    pureOk = false;
    gpuVal.trial_valid = false;
    gpuVal.invalid_reason = [gpuVal.invalid_reason, "pure_measure_rad_requests>0"]
      .filter(Boolean)
      .join(";");
  }

  return {
    run_id: runId,
    timestamp,
    arm_id: arm.id,
    arm_name: arm.name,
    trial_id: trialId,
    trial_valid: gpuVal.trial_valid && (row?.trace_ok !== false) && !row?.error,
    invalid_reason: row?.error || gpuVal.invalid_reason || "",
    gpu_renderer: renderer,
    gpu_vendor: gpuBackend?.webgl_vendor || row?.webgl_vendor || "",
    UNMASKED_VENDOR_WEBGL: gpuBackend?.UNMASKED_VENDOR_WEBGL || gpuBackend?.webgl_vendor || "",
    UNMASKED_RENDERER_WEBGL: gpuBackend?.UNMASKED_RENDERER_WEBGL || gpuBackend?.webgl_renderer || "",
    angle_backend: gpuVal.angle_backend,
    chrome_executable: chromeExecutable || "",
    chrome_launch_args: (chromeArgs || []).join(" "),
    headed_or_headless: row?.headed ? "headed" : "headless",
    devicePixelRatio: gpuBackend?.device_pixel_ratio ?? row?.device_pixel_ratio,
    drawingBufferWidth: gpuBackend?.drawing_buffer_width ?? row?.drawing_buffer_width,
    drawingBufferHeight: gpuBackend?.drawing_buffer_height ?? row?.drawing_buffer_height,
    visibilityState: gpuBackend?.visibility_state ?? probeExtras?.visibility_state ?? "",
    preload_fps: row?.preload_fps_mean ?? null,
    measure_fps: row?.measure_fps_mean ?? null,
    fps_mean: row?.fps_mean ?? null,
    frame_mean_ms: Math.round(thresh.frame_mean_ms * 100) / 100,
    frame_p50_ms: fm.frame_p50_ms,
    frame_p95_ms: fm.frame_p95_ms,
    frame_p99_ms: fm.frame_p99_ms,
    frame_max_ms: thresh.frame_max_ms,
    frames_over_16ms: thresh.frames_over_16ms,
    frames_over_33ms: thresh.frames_over_33ms,
    frames_over_50ms: thresh.frames_over_50ms,
    frames_over_100ms: thresh.frames_over_100ms,
    server_p50_ms: row?.server_total_p50_ms,
    server_p95_ms: row?.server_total_p95_ms,
    client_net_p50_ms: row?.client_network_total_p50_ms,
    client_net_p95_ms: row?.client_network_total_p95_ms,
    preload_rad_requests: row?.preload_rad_requests,
    measure_rad_requests: row?.measure_rad_requests,
    total_rad_requests: (Number(row?.preload_rad_requests) || 0) + (Number(row?.measure_rad_requests) || 0),
    total_bytes: row?.total_fetch_bytes,
    range_request_count: row?.total_fetch_requests,
    renderer_render_p50_ms: row?.renderer_render_call_p50_ms,
    renderer_render_p95_ms: row?.renderer_render_call_p95_ms,
    upload_cpu_p50_ms: row?.upload_cpu_time_p50_ms,
    upload_cpu_p95_ms: row?.upload_cpu_time_p95_ms,
    visible_splat_count: row?.visible_splat_count ?? probeExtras?.visible_splat_count,
    rendered_splat_count: row?.rendered_splat_count ?? probeExtras?.rendered_splat_count,
    target_rendered_splats: row?.target_rendered_splats ?? probeExtras?.target_rendered_splats,
    lod_update_count: null,
    camera_update_count: null,
    trace_gpu_total_ms: row?.gpu_total_ms,
    trace_raster_total_ms: row?.raster_total_ms,
    trace_composite_total_ms: row?.composite_total_ms,
    trace_main_thread_total_ms: row?.main_thread_total_ms,
    trace_script_total_ms: row?.main_thread_total_ms,
    pure_render_valid: pureOk,
    ablation_mode: row?.ablation_mode,
    run_dir: row?.run_dir,
  };
}

export function aggregateByArm(trials) {
  const valid = trials.filter((t) => t.trial_valid);
  const byArm = new Map();
  for (const t of valid) {
    if (!byArm.has(t.arm_id)) byArm.set(t.arm_id, []);
    byArm.get(t.arm_id).push(t);
  }
  const rows = [];
  for (const [armId, ts] of byArm) {
    const nums = (k) => ts.map((x) => Number(x[k])).filter((n) => Number.isFinite(n));
    const mean = (k) => {
      const xs = nums(k);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    rows.push({
      arm_id: armId,
      arm_name: ts[0]?.arm_name,
      valid_trials: ts.length,
      measure_fps_mean: mean("measure_fps"),
      measure_fps_min: nums("measure_fps").length ? Math.min(...nums("measure_fps")) : null,
      measure_fps_max: nums("measure_fps").length ? Math.max(...nums("measure_fps")) : null,
      frame_p95_mean: mean("frame_p95_ms"),
      frames_over_33ms_mean: mean("frames_over_33ms"),
      frames_over_100ms_mean: mean("frames_over_100ms"),
      measure_rad_requests_max: nums("measure_rad_requests").length
        ? Math.max(...nums("measure_rad_requests"))
        : null,
      server_p95_mean: mean("server_p95_ms"),
      client_net_p95_mean: mean("client_net_p95_ms"),
    });
  }
  return rows.sort((a, b) => a.arm_id.localeCompare(b.arm_id));
}
