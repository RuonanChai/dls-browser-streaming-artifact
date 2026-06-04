import { percentile, stats, summarizeFrameMetrics } from "../local_stutter_ablation_metrics.mjs";
import { latencyStats } from "../../../vrc-paper/experiments/audit_io.mjs";

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

function p99FromStats(s) {
  return s?.p99 ?? 0;
}

function summarizeRadCdpRows(cdpRows) {
  const rad = cdpRows.filter((r) => /\.rad(\?|#|$)/i.test(String(r.url || "")) && r.completed);
  const ttfb = rad.map((r) => Number(r.ttfb_ms)).filter(Number.isFinite);
  const dl = rad.map((r) => Number(r.download_ms)).filter(Number.isFinite);
  const tot = rad.map((r) => Number(r.network_total_ms)).filter(Number.isFinite);
  const ttfbS = latencyStats(ttfb);
  const dlS = latencyStats(dl);
  const totS = latencyStats(tot);
  const ttfbSorted = [...ttfb].sort((a, b) => a - b);
  const dlSorted = [...dl].sort((a, b) => a - b);
  const totSorted = [...tot].sort((a, b) => a - b);
  const bytes = rad.reduce((s, r) => s + Number(r.encodedDataLength ?? 0), 0);
  const protocols = [...new Set(rad.map((r) => r.protocol).filter(Boolean))];
  const statuses = [...new Set(rad.map((r) => String(r.status)).filter(Boolean))];
  const rangeHeaders = rad.map((r) => r.range_header).filter(Boolean);
  const firstSent = rad.length
    ? Math.min(...rad.map((r) => r.requestWillBeSent).filter(Number.isFinite))
    : null;

  return {
    total_rad_requests: rad.length,
    protocol: protocols[0] ?? null,
    protocols,
    status_code: statuses.includes("206") ? 206 : Number(statuses[0]) || null,
    range_request_header: rangeHeaders[0] ?? null,
    ttfb_p50_ms: ttfbS.p50,
    ttfb_p95_ms: ttfbS.p95,
    ttfb_p99_ms: percentile(ttfbSorted, 0.99),
    download_p50_ms: dlS.p50,
    download_p95_ms: dlS.p95,
    download_p99_ms: percentile(dlSorted, 0.99),
    request_total_p50_ms: totS.p50,
    request_total_p95_ms: totS.p95,
    request_total_p99_ms: percentile(totSorted, 0.99),
    server_total_p50_ms: totS.p50,
    server_total_p95_ms: totS.p95,
    server_total_p99_ms: percentile(totSorted, 0.99),
    total_bytes: bytes,
    time_to_first_rad_request_ms: firstSent,
    status_206_count: rad.filter((r) => String(r.status) === "206").length,
  };
}

function mergeCacheHeaders(headerRows) {
  const pick = (name) => {
    for (const h of headerRows) {
      const v = h?.[name] ?? h?.[name.toLowerCase()];
      if (v) return String(v);
    }
    return null;
  };
  return {
    "cf-cache-status": pick("cf-cache-status"),
    age: pick("age"),
    "x-cache": pick("x-cache"),
    via: pick("via"),
    "server-timing": pick("server-timing"),
    "content-range": pick("content-range"),
  };
}

/**
 * Build per-trial JSON matching distributed network benchmark schema.
 */
export function buildDistributedTrialJson(ctx) {
  const {
    trialDescriptor,
    deliveryResolved,
    row,
    gpuBackend,
    probeExtras,
    cdpRows,
    cacheHeaderRows,
    pageUrl,
    assetUrl,
    timings,
    machineMeta,
    error,
  } = ctx;

  const measureFts = probeExtras?.measure_frame_times ?? [];
  const fm = summarizeFrameMetrics(measureFts);
  const thresh = frameThresholdCounts(measureFts);
  const radNet = summarizeRadCdpRows(cdpRows ?? []);
  const cache = mergeCacheHeaders(cacheHeaderRows ?? []);

  const preloadRad = row?.preload_rad_requests ?? probeExtras?.preload_rad_requests ?? 0;
  const measureRad = row?.measure_rad_requests ?? probeExtras?.measure_rad_requests ?? 0;
  const totalRad = preloadRad + measureRad;
  const preloadBytes = row?.total_fetch_bytes
    ? Math.round((row.total_fetch_bytes * preloadRad) / Math.max(1, totalRad))
    : radNet.total_bytes;
  const measureBytes = (row?.total_fetch_bytes ?? radNet.total_bytes) - preloadBytes;

  const measureDurationMs = timings?.measure_duration_ms ?? 0;
  const preloadDurationMs = timings?.preload_duration_ms ?? 0;
  const startupMode =
    trialDescriptor.startup_mode ?? row?.startup_mode ?? probeExtras?.startup_mode ?? "steady_state";
  const isColdStart = startupMode === "cold_start" || trialDescriptor.warmup_ms === 0;
  const measureMbps =
    measureDurationMs > 0 ? (measureBytes * 8) / measureDurationMs / 1000 : null;
  const throughputMbps =
    (preloadDurationMs + measureDurationMs) > 0
      ? ((preloadBytes + measureBytes) * 8) / (preloadDurationMs + measureDurationMs) / 1000
      : measureMbps;

  const isPure = trialDescriptor.measurement_mode === "warm_steady_render_mode";
  const qoeProxy =
    probeExtras?.quality_proxy ??
    (row?.visible_splat_count && row?.target_rendered_splats
      ? row.visible_splat_count / row.target_rendered_splats
      : row?.visible_splat_count ?? null);

  return {
    trial_id: ctx.trialId,
    timestamp: new Date().toISOString(),
    delivery_profile: trialDescriptor.delivery_profile,
    VRC_DELIVERY_PROFILE: trialDescriptor.delivery_profile,
    cdn_label: deliveryResolved.cdn_label ?? null,
    scenario: trialDescriptor.scenario,
    startup_mode: startupMode,
    arm_id: trialDescriptor.arm_id,
    measurement_mode: trialDescriptor.measurement_mode,
    trial_index: trialDescriptor.trial_index,
    client_id: trialDescriptor.client_id,
    client_count: trialDescriptor.client_count,

    preload_blocked_before_measure: isPure || row?.pure_render_valid != null,
    network_blocked_during_measure:
      trialDescriptor.measurement_mode === "warm_steady_render_mode" ||
      trialDescriptor.arm_id === "E8_pure_render",
    measure_rad_requests: measureRad,

    asset_url: assetUrl,
    page_url: pageUrl,
    protocol: radNet.protocol,
    next_hop_protocol: probeExtras?.next_hop_protocol ?? null,
    status_code: radNet.status_code,
    range_request_header: radNet.range_request_header,
    content_range_response: cache["content-range"],

    total_rad_requests: totalRad,
    preload_rad_requests: preloadRad,
    total_bytes: row?.total_fetch_bytes ?? radNet.total_bytes,
    preload_bytes: preloadBytes,
    measure_bytes: measureBytes,
    time_to_first_rad_request_ms: timings?.time_to_first_rad_request_ms ?? radNet.time_to_first_rad_request_ms,
    /** @deprecated configured preload wait only — never use as first-visible latency */
    time_to_ready_ms: null,
    configured_preload_duration_ms: preloadDurationMs,
    warmup_duration_ms: row?.warmup_duration_ms ?? preloadDurationMs,
    preload_duration_ms: preloadDurationMs,
    measure_duration_ms: measureDurationMs,
    first_visible_splat_ms: row?.first_visible_splat_ms ?? probeExtras?.first_visible_splat_ms ?? null,
    first_nonblack_frame_ms: row?.first_nonblack_frame_ms ?? probeExtras?.first_nonblack_frame_ms ?? null,
    first_quality_10k_splats_ms:
      row?.first_quality_10k_splats_ms ?? probeExtras?.first_quality_10k_splats_ms ?? null,
    first_quality_100k_splats_ms:
      row?.first_quality_100k_splats_ms ?? probeExtras?.first_quality_100k_splats_ms ?? null,
    first_rad_request_ms: row?.first_rad_request_ms ?? probeExtras?.first_rad_request_ms ?? null,
    canvas_luma_sampling_ok: row?.canvas_luma_sampling_ok ?? probeExtras?.canvas_luma_sampling_ok ?? false,
    cold_start_effective: isColdStart,
    throughput_Mbps: throughputMbps != null ? Math.round(throughputMbps * 100) / 100 : null,
    ttfb_p50_ms: radNet.ttfb_p50_ms,
    ttfb_p95_ms: radNet.ttfb_p95_ms,
    ttfb_p99_ms: radNet.ttfb_p99_ms,
    download_p50_ms: radNet.download_p50_ms,
    download_p95_ms: radNet.download_p95_ms,
    download_p99_ms: radNet.download_p99_ms,
    request_total_p50_ms: radNet.request_total_p50_ms,
    request_total_p95_ms: radNet.request_total_p95_ms,
    request_total_p99_ms: radNet.request_total_p99_ms,
    server_total_p50_ms: row?.server_total_p50_ms ?? radNet.server_total_p50_ms,
    server_total_p95_ms: row?.server_total_p95_ms ?? radNet.server_total_p95_ms,
    server_total_p99_ms: row?.server_total_p99_ms ?? radNet.server_total_p99_ms,

    cache_headers: cache,

    machine_id: machineMeta.machine_id,
    worker_id: machineMeta.worker_id,
    browser_context_id: machineMeta.browser_context_id ?? null,
    gpu_vendor: gpuBackend?.webgl_vendor ?? row?.webgl_vendor ?? "",
    gpu_renderer: gpuBackend?.webgl_renderer ?? row?.webgl_renderer ?? "",
    angle_backend: gpuBackend?.is_angle ? "angle" : "",
    headed_or_headless: row?.headed ? "headed" : "headless",
    visibilityState: probeExtras?.visibility_state ?? row?.visibility_state ?? "",
    devicePixelRatio: gpuBackend?.device_pixel_ratio ?? row?.device_pixel_ratio,
    drawingBufferWidth: gpuBackend?.drawing_buffer_width ?? row?.drawing_buffer_width,
    drawingBufferHeight: gpuBackend?.drawing_buffer_height ?? row?.drawing_buffer_height,

    measure_fps: row?.measure_fps_mean ?? fm.fps_mean ?? null,
    frame_mean_ms: Math.round(thresh.frame_mean_ms * 100) / 100,
    frame_p50_ms: fm.frame_p50_ms,
    frame_p95_ms: fm.frame_p95_ms,
    frame_p99_ms: fm.frame_p99_ms,
    frame_max_ms: thresh.frame_max_ms,
    frames_over_16ms: thresh.frames_over_16ms,
    frames_over_33ms: thresh.frames_over_33ms,
    frames_over_50ms: thresh.frames_over_50ms,
    frames_over_100ms: thresh.frames_over_100ms,
    renderer_render_p95_ms: row?.renderer_render_call_p95_ms ?? null,
    upload_cpu_p95_ms: row?.upload_cpu_time_p95_ms ?? null,
    parse_p95_ms: row?.parse_p95_ms ?? null,
    parse_call_count: row?.parse_call_count ?? null,
    parse_total_ms: row?.parse_total_ms ?? null,
    visible_splat_count: row?.visible_splat_count ?? probeExtras?.visible_splat_count ?? null,
    target_rendered_splats: row?.target_rendered_splats ?? probeExtras?.target_rendered_splats ?? null,
    rendered_splat_count: row?.rendered_splat_count ?? probeExtras?.rendered_splat_count ?? null,
    js_heap_peak_mb: row?.js_heap_peak_mb ?? null,
    rss_peak_mb: row?.rss_peak_mb ?? null,
    qoe_proxy: qoeProxy,
    pure_render_valid: row?.pure_render_valid ?? null,

    throttle: deliveryResolved.throttle ?? null,
    crash: !!error,
    timeout: false,
    error: error ? String(error) : null,
    status: error ? "failed" : "completed",
    run_dir: row?.run_dir ?? null,
  };
}
