/**
 * Aggregate ablation run metrics into unified summary row (v2).
 */
import fs from "node:fs/promises";

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export function stats(values) {
  const xs = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!xs.length) return { p50: 0, p95: 0, p99: 0, mean: 0, count: 0, sum: 0 };
  return {
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    p99: percentile(xs, 0.99),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    sum: xs.reduce((a, b) => a + b, 0),
    count: xs.length,
  };
}

export function summarizeFrameMetrics(frameTimes) {
  const fts = (frameTimes ?? []).filter((x) => x > 0 && x < 5000);
  if (!fts.length) {
    return {
      fps_mean: 0,
      fps_p5: 0,
      frame_p50_ms: 0,
      frame_p95_ms: 0,
      frame_p99_ms: 0,
      long_frame_over_33ms_count: 0,
      long_frame_over_100ms_count: 0,
    };
  }
  const sorted = [...fts].sort((a, b) => a - b);
  const mean = fts.reduce((a, b) => a + b, 0) / fts.length;
  const fpsSamples = fts.map((dt) => 1000 / dt).sort((a, b) => a - b);
  const st = stats(fts);
  return {
    fps_mean: Math.round((1000 / mean) * 10) / 10,
    fps_p5: Math.round(percentile(fpsSamples, 0.05) * 10) / 10,
    frame_p50_ms: st.p50,
    frame_p95_ms: st.p95,
    frame_p99_ms: st.p99,
    long_frame_over_33ms_count: fts.filter((x) => x > 33.33).length,
    long_frame_over_100ms_count: fts.filter((x) => x > 100).length,
  };
}

export async function buildExperimentSummaryRow({
  experimentId,
  diagnosisLabel,
  runDir,
  probeSnapshot,
  net,
  serverSummary,
  traceSummary,
  processRows,
  gpuBackend,
  measureNet,
}) {
  const snap = probeSnapshot ?? {};
  const preload = snap.preload ?? {};
  const measure = snap.measure ?? {};
  const upload = snap.upload ?? {};

  const preloadFetch = stats(preload.fetch_total_ms ?? []);
  const measureFetch = stats(measure.fetch_total_ms ?? []);
  const preloadParse = stats(preload.parse_total_ms ?? []);
  const measureParse = stats(measure.parse_total_ms ?? []);
  const preloadRenderCall = stats(preload.renderer_render_call_ms ?? []);
  const measureRenderCall = stats(measure.renderer_render_call_ms ?? []);

  const measureFrames = summarizeFrameMetrics(snap.measure_frame_times ?? snap.frame_times ?? []);
  const preloadFrames = summarizeFrameMetrics(snap.preload_frame_times ?? []);

  const elP95 = stats(processRows.map((r) => Number(r.event_loop_delay_p95_ms)));
  const elMax = Math.max(0, ...processRows.map((r) => Number(r.event_loop_delay_max_ms) || 0));
  const rssPeak = Math.max(0, ...processRows.map((r) => Number(r.node_process_rss_mb) || 0));
  const heapPeak = Math.max(0, ...processRows.map((r) => Number(r.node_process_heap_used_mb) || 0));
  const rl = serverSummary?.request_level ?? {};
  const mn = measureNet ?? net;

  const gb = gpuBackend ?? {};

  return {
    experiment_id: experimentId,
    diagnosis_label: diagnosisLabel,
    run_dir: runDir,
    ablation_mode: snap.cfg?.mode ?? diagnosisLabel,
    headed: snap.headed,
    pixel_ratio: snap.pixel_ratio,
    trace_ok: !!traceSummary?.trace_ok,

    server_total_p50_ms: rl.server_total_p50_ms ?? 0,
    server_total_p95_ms: rl.server_total_p95_ms ?? 0,
    server_total_p99_ms: rl.server_total_p99_ms ?? 0,
    server_ttfb_p50_ms: rl.server_ttfb_p50_ms ?? 0,
    server_ttfb_p95_ms: rl.server_ttfb_p95_ms ?? 0,
    client_network_total_p50_ms: mn?.net_total_p50_ms ?? net?.net_total_p95_ms ?? 0,
    client_network_total_p95_ms: mn?.net_total_p95_ms ?? net?.net_total_p95_ms ?? 0,
    client_network_total_p99_ms: mn?.net_total_p99_ms ?? net?.net_total_p95_ms ?? 0,

    total_fetch_requests: snap.total_fetch_requests ?? 0,
    total_fetch_bytes: snap.total_fetch_bytes ?? 0,
    parse_call_count: snap.parse_call_count ?? 0,
    parse_total_ms: snap.parse_total_ms_sum ?? 0,
    parse_p95_ms: snap.parse_p95_ms ?? 0,

    preload_rad_requests: snap.preload_rad_requests ?? 0,
    measure_rad_requests: snap.measure_rad_requests ?? 0,
    preload_fetch_p95_ms: preloadFetch.p95,
    measure_fetch_p95_ms: measureFetch.p95,
    preload_parse_p95_ms: preloadParse.p95,
    measure_parse_p95_ms: measureParse.p95,

    upload_call_count: upload.call_count ?? 0,
    upload_bytes_estimated: upload.bytes_estimated ?? 0,
    upload_cpu_time_p50_ms: snap.upload_cpu_time_p50_ms ?? 0,
    upload_cpu_time_p95_ms: snap.upload_cpu_time_p95_ms ?? 0,
    largest_upload_bytes: upload.largest_upload_bytes ?? 0,
    largest_upload_time_ms: upload.largest_upload_time_ms ?? 0,
    upload_long_call_count_over_16ms: upload.long_call_count_over_16ms ?? 0,

    renderer_render_call_p50_ms: measureRenderCall.p50 || preloadRenderCall.p50,
    renderer_render_call_p95_ms: measureRenderCall.p95 || preloadRenderCall.p95,
    renderer_render_call_p99_ms: measureRenderCall.p99 || preloadRenderCall.p99,

    preload_fps_mean: preloadFrames.fps_mean,
    measure_fps_mean: measureFrames.fps_mean,
    fps_mean: measureFrames.fps_mean || preloadFrames.fps_mean,
    fps_p5: measureFrames.fps_p5,
    measure_frame_p95_ms: measureFrames.frame_p95_ms,
    preload_frame_p95_ms: preloadFrames.frame_p95_ms,
    long_frame_over_33ms_count: measureFrames.long_frame_over_33ms_count,
    long_frame_over_100ms_count: measureFrames.long_frame_over_100ms_count,
    visible_splat_count: snap.visible_splat_count ?? null,
    rendered_splat_count: snap.rendered_splat_count ?? null,
    loaded_splat_count: snap.loaded_splat_count ?? null,
    target_rendered_splats: snap.target_rendered_splats ?? null,
    visibility_state: snap.visibility_state ?? null,

    main_thread_total_ms: traceSummary?.trace_main_script_ms ?? 0,
    gpu_total_ms: traceSummary?.trace_gpu_ms ?? 0,
    raster_total_ms: traceSummary?.trace_raster_ms ?? 0,
    composite_total_ms: traceSummary?.trace_composite_ms ?? 0,
    js_heap_peak_mb: heapPeak,
    rss_peak_mb: rssPeak,
    event_loop_delay_p95_ms: elP95.p95,
    event_loop_delay_max_ms: elMax,

    webgl_vendor: gb.webgl_vendor ?? "",
    webgl_renderer: gb.webgl_renderer ?? "",
    chrome_version: gb.chrome_version ?? "",
    device_pixel_ratio: gb.device_pixel_ratio ?? "",
    canvas_css_width: gb.canvas_css_width ?? "",
    canvas_css_height: gb.canvas_css_height ?? "",
    drawing_buffer_width: gb.drawing_buffer_width ?? "",
    drawing_buffer_height: gb.drawing_buffer_height ?? "",
    is_angle: gb.is_angle ?? false,
    is_swiftshader: gb.is_swiftshader ?? false,
    pure_render_valid: snap.pure_render_valid ?? null,
  };
}

export function writeSummaryCsv(rows, filePath) {
  if (!rows.length) return;
  const allKeys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [allKeys.join(","), ...rows.map((r) => allKeys.map((k) => esc(r[k])).join(","))];
  return fs.writeFile(filePath, lines.join("\n"), "utf8");
}

export function formatExperimentSummaryMd(row) {
  return [
    `# ${row.experiment_id} · ${row.diagnosis_label}`,
    "",
    "## 测量窗口",
    `- measure_fps_mean: ${row.measure_fps_mean}`,
    `- measure_frame_p95_ms: ${row.measure_frame_p95_ms}`,
    `- measure_rad_requests: ${row.measure_rad_requests} (pure render 须为 0)`,
    `- pure_render_valid: ${row.pure_render_valid}`,
    "",
    "## Fetch / Parse / Upload",
    `- total_fetch_requests: ${row.total_fetch_requests}`,
    `- total_fetch_bytes: ${row.total_fetch_bytes}`,
    `- parse_call_count: ${row.parse_call_count} · parse_p95_ms: ${row.parse_p95_ms}`,
    `- upload_call_count: ${row.upload_call_count} · upload_cpu_p95: ${row.upload_cpu_time_p95_ms}ms`,
    "",
    "## GPU / Server",
    `- webgl_renderer: ${row.webgl_renderer}`,
    `- server_p95: ${row.server_total_p95_ms}ms · net_p95: ${row.client_network_total_p95_ms}ms`,
    `- renderer_render_call_p95_ms: ${row.renderer_render_call_p95_ms} (仅 JS 调用耗时)`,
    `- trace gpu/raster/composite: ${row.gpu_total_ms} / ${row.raster_total_ms} / ${row.composite_total_ms} ms`,
    "",
  ].join("\n");
}

export async function writeExperimentSummaryMd(row, filePath) {
  await fs.writeFile(filePath, formatExperimentSummaryMd(row), "utf8");
}
