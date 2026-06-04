/**
 * Lightweight render bottleneck experiment cell (pure render / E8b).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { attachLocalStutterTraceCollector } from "./local_stutter_trace_collector.mjs";
import { MonitoredAssetServer, probeMonitoredServer } from "./local_stutter_asset_server.mjs";
import { buildAblationHtml } from "./local_stutter_ablation_html.mjs";
import { loadRadRangeManifest, manifestForRadUrl } from "./ablation_rad_range_manifest.mjs";
import { summarizeFrameMetrics, stats } from "./local_stutter_ablation_metrics.mjs";
import { collectGpuBackendDetailed } from "./render_bottleneck_gpu.mjs";
import {
  startPageStaticServer,
  orbitCamera,
} from "./local_stutter_ablation_cell.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const MANIFEST_CHUNK_COUNT = 340;

const BASE_CHROME_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--force-high-performance-gpu",
];

export function buildChromeArgs(profile) {
  switch (profile) {
    case "angle_d3d11":
      return [...BASE_CHROME_ARGS, "--enable-gpu", "--use-angle=d3d11"];
    case "angle_d3d11on12":
      return [...BASE_CHROME_ARGS, "--enable-gpu", "--use-angle=d3d11on12"];
    case "angle_gl":
      return [...BASE_CHROME_ARGS, "--enable-gpu", "--use-angle=gl"];
    case "gpu_raster":
      return [
        ...BASE_CHROME_ARGS,
        "--enable-gpu",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
      ];
    case "disable_gpu":
      return [...BASE_CHROME_ARGS, "--disable-gpu"];
    case "default":
    default:
      return [
        ...BASE_CHROME_ARGS,
        "--enable-gpu",
        "--ignore-gpu-blocklist",
      ];
  }
}

async function waitPreloadChunks(page, targetChunks, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = await page.evaluate(
      () => window.__ablationProbe?.getRadStats?.()?.preload_rad_requests ?? 0,
    );
    if (n >= targetChunks) return { ok: true, count: n };
    await new Promise((r) => setTimeout(r, 400));
  }
  const count = await page.evaluate(
    () => window.__ablationProbe?.getRadStats?.()?.preload_rad_requests ?? 0,
  );
  return { ok: false, count };
}

export async function collectRenderLoadSnapshot(page) {
  return page.evaluate(() => {
    const spark = window.__slDiagSpark;
    const renderer = window.__slDiagRenderer;
    const probe = window.__ablationProbe?.getSnapshot?.() ?? {};
    const ri = renderer?.info?.render ?? {};
    const mem = renderer?.info?.memory ?? {};
    return {
      loaded_chunk_count: probe.preload_rad_requests ?? 0,
      loaded_splat_count: spark?.lodSplatCount ?? spark?.maxSplats ?? null,
      visible_splat_count:
        spark?.display?.numSplats ?? spark?.numSplats ?? spark?.lodSplatCount ?? null,
      render_calls: ri.calls ?? 0,
      render_triangles: ri.triangles ?? 0,
      render_points: ri.points ?? 0,
      memory_geometries: mem.geometries ?? 0,
      memory_textures: mem.textures ?? 0,
      gpu_buffer_bytes_estimated: probe.upload?.bytes_estimated ?? 0,
      spark_lod_splat_scale: spark?.lodSplatScale ?? null,
      spark_max_splats: spark?.maxSplats ?? null,
    };
  });
}

/**
 * @param {{
 *   experimentId: string,
 *   runDir: string,
 *   chromeProfile?: string,
 *   chromeArgs?: string[],
 *   viewport?: { width: number, height: number },
 *   loadPercent?: number,
 *   measureMs?: number,
 *   preloadMaxMs?: number,
 *   pixelRatio?: string,
 *   assetPort?: number,
 *   traceChrome?: boolean,
 * }} spec
 */
export async function runRenderBottleneckCell(spec) {
  const {
    experimentId,
    runDir,
    chromeProfile = "default",
    chromeArgs = buildChromeArgs(chromeProfile),
    viewport = { width: 1280, height: 720 },
    loadPercent = 100,
    measureMs = 30_000,
    preloadMaxMs = 120_000,
    pixelRatio = "auto",
    assetPort = 0,
    traceChrome = true,
  } = spec;

  await fs.mkdir(runDir, { recursive: true });
  const summaryDir = path.join(runDir, "summary");
  await fs.mkdir(summaryDir, { recursive: true });

  const assetSrv = new MonitoredAssetServer({
    rootDir: projectRoot,
    port: assetPort || 19400 + Math.floor(Math.random() * 40),
    runDir,
    runId: experimentId,
  });
  const assetInfo = await assetSrv.start();
  await probeMonitoredServer(assetInfo.base);

  const { outFile: patchedHtml } = await buildAblationHtml({
    assetBase: assetInfo.base,
    ablationMode: "render_only_pure",
    pixelRatio,
    label: experimentId,
  });

  const pathOverrides = new Map([["/examples/streaming-lod/index.html", patchedHtml]]);
  const pageSrv = await startPageStaticServer(0, pathOverrides);

  const pageUrl = new URL(`${pageSrv.base}/examples/streaming-lod/index.html`);
  pageUrl.searchParams.set("world", "Coit Tower, SF");
  pageUrl.searchParams.set("ablation_mode", "render_only_pure");
  pageUrl.searchParams.set("load_percent", String(loadPercent));

  const browser = await chromium.launch({ headless: false, args: chromeArgs });
  let pageSrvRef = pageSrv;

  try {
    const context = await browser.newContext({ viewport });
    const radUrl = `${assetInfo.base}/examples/streaming-lod/coit-40m-sh1-lod.rad`;
    const manifest = manifestForRadUrl(loadRadRangeManifest(), radUrl);
    const page = await context.newPage();
    await page.addInitScript((m) => {
      window.__ablationRadManifest = m;
    }, manifest);

    let traceRec = null;
    if (traceChrome) {
      traceRec = await attachLocalStutterTraceCollector(page, {
        userId: "u0",
        runDir,
        headless: false,
        chromeExecutable: "",
      });
    }

    await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForFunction(() => window.__slDiagCam != null, undefined, { timeout: 300_000 });

    const targetChunks = Math.max(
      1,
      Math.ceil((MANIFEST_CHUNK_COUNT * loadPercent) / 100),
    );

    await page.evaluate(() => window.__ablationSetPhase?.("preload"));
    const preloadDeadline = Date.now() + preloadMaxMs;
    while (Date.now() < preloadDeadline) {
      await orbitCamera(page, 4000);
      const st = await waitPreloadChunks(page, targetChunks, 1500);
      if (st.ok) break;
      if (loadPercent >= 100 && st.count >= 300) break;
    }

    const preloadChunks = await page.evaluate(
      () => window.__ablationProbe?.getRadStats?.()?.preload_rad_requests ?? 0,
    );
    const loadSnapshotPre = await collectRenderLoadSnapshot(page);

    await new Promise((r) => setTimeout(r, 3000));
    await page.evaluate(() => {
      window.__ablationBlockNetwork?.();
      window.__ablationBeginMeasurePhase?.();
    });
    await page.evaluate(() => window.__ablationSetPhase?.("measure"));

    await orbitCamera(page, measureMs);

    const probeData = await page.evaluate(() => {
      const snap = window.__ablationProbe?.getSnapshot?.() ?? {};
      const diag = window.__stutterDiag ?? {};
      return {
        ...snap,
        measure_frame_times: [...(diag.measure_frame_times || [])],
        measure_rad_requests: snap.measure_rad_requests ?? 0,
      };
    });

    const loadSnapshot = await collectRenderLoadSnapshot(page);
    const gpuBackend = await collectGpuBackendDetailed(page, {
      headless: false,
      chromeArgs,
      chromeProfile,
    });

    let traceSummary = { trace_ok: false, trace_error: "trace_disabled" };
    if (traceRec) {
      await page.waitForTimeout(1500);
      traceSummary = await traceRec.stop({ flushMs: 0 });
    }

    if (assetSrv.server) await assetSrv.stop();

    const frames = summarizeFrameMetrics(probeData.measure_frame_times ?? []);
    const measureRenderCall = stats(probeData.measure?.renderer_render_call_ms ?? []);

    const row = {
      experiment_id: experimentId,
      chrome_profile: chromeProfile,
      load_percent: loadPercent,
      viewport_width: viewport.width,
      viewport_height: viewport.height,
      measure_fps_mean: frames.fps_mean,
      measure_fps_p5: frames.fps_p5,
      measure_frame_p95_ms: frames.frame_p95_ms,
      long_frame_over_33ms_count: frames.long_frame_over_33ms_count,
      long_frame_over_100ms_count: frames.long_frame_over_100ms_count,
      renderer_render_call_p95_ms: measureRenderCall.p95,
      trace_ok: !!traceSummary.trace_ok,
      trace_gpu_ms: traceSummary.trace_gpu_ms ?? 0,
      trace_raster_ms: traceSummary.trace_raster_ms ?? 0,
      trace_composite_ms: traceSummary.trace_composite_ms ?? 0,
      trace_main_ms: traceSummary.trace_main_script_ms ?? 0,
      measure_rad_requests: probeData.measure_rad_requests ?? 0,
      pure_render_valid: (probeData.measure_rad_requests ?? 0) === 0,
      preload_rad_requests: preloadChunks,
      target_chunk_count: targetChunks,
      ...loadSnapshot,
      ...gpuBackend,
      canvas_css_size: `${gpuBackend.canvas_css_width}x${gpuBackend.canvas_css_height}`,
      drawing_buffer_size: `${gpuBackend.drawing_buffer_width}x${gpuBackend.drawing_buffer_height}`,
    };

    await fs.writeFile(path.join(runDir, "gpu_backend.json"), `${JSON.stringify(gpuBackend, null, 2)}\n`);
    await fs.writeFile(path.join(summaryDir, "experiment_summary.json"), `${JSON.stringify(row, null, 2)}\n`);

    await context.close();
    return { row, gpuBackend, traceSummary };
  } finally {
    await browser.close().catch(() => {});
    if (pageSrvRef?.server) {
      await new Promise((resolve) => pageSrvRef.server.close(() => resolve()));
    }
  }
}
