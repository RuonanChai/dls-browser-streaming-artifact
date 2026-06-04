/**
 * Parse chrome_trace.json (traceEvents) for single-user stutter diagnosis.
 */
import fs from "node:fs";

function durMs(ev) {
  if (ev.dur != null && Number(ev.dur) > 0) return Number(ev.dur) / 1000;
  return 0;
}

function nameOf(ev) {
  return String(ev.name ?? "");
}

function loadTraceEvents(tracePath) {
  const raw = fs.readFileSync(tracePath, "utf8").trim();
  if (!raw) throw new Error("empty_trace_file");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid_json:${e.message}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.traceEvents)) return parsed.traceEvents;
  if (parsed.metadata && Array.isArray(parsed.traceEvents)) return parsed.traceEvents;
  throw new Error("no_traceEvents_array");
}

const MAIN_RE =
  /^(RunTask|FunctionCall|EvaluateScript|V8\.Execute|TaskQueueManager::ProcessTaskFromWorkQueue|JSFrame)/;
const LONG_TASK_MS = 50;
const LAYOUT_RE = /^(Layout|UpdateLayoutTree|PrePaint|Paint)/;
const RASTER_RE = /^(RasterTask|Rasterize|GPUTask)/;
const COMPOSITE_RE = /^(CompositeLayers|LayerTreeHostImpl|ActivateLayerTree|DrawFrame|BeginMainThreadFrame|DrawFrame)/;
const GPU_RE = /^(Gpu|GPU|VizCompositorThread|Display::DrawAndSwap|GLES2|GrContext)/;
const LOADING_RE = /^(ResourceSendRequest|ResourceReceiveResponse|ResourceFinish|Loading)/;
const FRAME_RE = /^(BeginFrame|DrawFrame|BeginMainThreadFrame)/;

/**
 * @param {string} tracePath
 */
export function parseChromeTraceSummary(tracePath) {
  const events = loadTraceEvents(tracePath);
  const fileSize = fs.statSync(tracePath).size;

  const nameCounts = {};
  let mainThreadEventCount = 0;
  let rendererEventCount = 0;
  let gpuEventCount = 0;
  let compositorEventCount = 0;
  let loadingEventCount = 0;

  const tidCounts = new Map();
  for (const ev of events) {
    if (ev.ph !== "X" && ev.ph !== "b") continue;
    const n = nameOf(ev);
    nameCounts[n] = (nameCounts[n] || 0) + 1;
    const tid = ev.tid ?? 0;
    tidCounts.set(tid, (tidCounts.get(tid) || 0) + 1);
    if (MAIN_RE.test(n)) mainThreadEventCount += 1;
    if (/Compositor|DrawFrame|BeginFrame|Raster|CompositeLayers/i.test(n)) compositorEventCount += 1;
    if (GPU_RE.test(n)) gpuEventCount += 1;
    if (LOADING_RE.test(n)) loadingEventCount += 1;
    if (/Renderer|CrRendererMain|ThreadPoolService/i.test(String(ev.args?.name || ev.cat || ""))) {
      rendererEventCount += 1;
    }
  }

  let mainTid = 0;
  let max = 0;
  for (const [tid, c] of tidCounts) {
    if (c > max) {
      max = c;
      mainTid = tid;
    }
  }

  let main_script_ms = 0;
  let long_task_count = 0;
  let long_task_total_ms = 0;
  let long_task_max_ms = 0;
  let layout_ms = 0;
  let paint_ms = 0;
  let raster_ms = 0;
  let composite_ms = 0;
  let gpu_ms = 0;
  let loading_event_ms = 0;
  let frame_event_count = 0;
  let draw_frame_count = 0;

  for (const ev of events) {
    if (ev.ph !== "X" && ev.ph !== "b") continue;
    const n = nameOf(ev);
    const d = durMs(ev);
    const onMain = (ev.tid ?? 0) === mainTid;

    if (onMain && MAIN_RE.test(n)) {
      main_script_ms += d;
      if (d > LONG_TASK_MS) {
        long_task_count += 1;
        long_task_total_ms += d;
        if (d > long_task_max_ms) long_task_max_ms = d;
      }
    }
    if (LAYOUT_RE.test(n)) {
      layout_ms += d;
      if (/Paint/.test(n)) paint_ms += d;
    }
    if (RASTER_RE.test(n)) raster_ms += d;
    if (COMPOSITE_RE.test(n)) composite_ms += d;
    if (GPU_RE.test(n)) gpu_ms += d;
    if (LOADING_RE.test(n)) loading_event_ms += d;
    if (FRAME_RE.test(n)) frame_event_count += 1;
    if (/DrawFrame/.test(n)) draw_frame_count += 1;
  }

  const total_events = events.length;
  const trace_ok =
    total_events > 1000 &&
    fileSize > 100 * 1024 &&
    (main_script_ms > 0 || gpu_ms > 0 || composite_ms > 0 || loading_event_ms > 0);

  const topNames = Object.entries(nameCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([name, count]) => ({ name, count }));

  return {
    trace_ok,
    trace_file_size: fileSize,
    total_events,
    event_name_counts: topNames,
    main_thread_event_count: mainThreadEventCount,
    renderer_event_count: rendererEventCount,
    gpu_event_count: gpuEventCount,
    compositor_event_count: compositorEventCount,
    loading_event_count: loadingEventCount,
    main_tid: mainTid,
    main_script_ms: Math.round(main_script_ms * 10) / 10,
    long_task_count,
    long_task_total_ms: Math.round(long_task_total_ms * 10) / 10,
    long_task_max_ms: Math.round(long_task_max_ms * 10) / 10,
    layout_ms: Math.round(layout_ms * 10) / 10,
    paint_ms: Math.round(paint_ms * 10) / 10,
    raster_ms: Math.round(raster_ms * 10) / 10,
    composite_ms: Math.round(composite_ms * 10) / 10,
    gpu_ms: Math.round(gpu_ms * 10) / 10,
    loading_event_ms: Math.round(loading_event_ms * 10) / 10,
    frame_event_count,
    draw_frame_count,
    parser_error: trace_ok ? "" : total_events <= 1000 ? "too_few_events" : "zero_bucket_ms",
    trace_layout_paint_ms: Math.round((layout_ms + paint_ms) * 10) / 10,
    trace_longtask_count: long_task_count,
    trace_raster_ms: Math.round(raster_ms * 10) / 10,
    trace_composite_ms: Math.round(composite_ms * 10) / 10,
    trace_gpu_ms: Math.round(gpu_ms * 10) / 10,
    trace_main_script_ms: Math.round(main_script_ms * 10) / 10,
  };
}
