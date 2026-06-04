/**
 * Render load scaling v2 — true rendered splat budget via lodSplatScale.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { attachLocalStutterTraceCollector } from "./local_stutter_trace_collector.mjs";
import { MonitoredAssetServer, probeMonitoredServer } from "./local_stutter_asset_server.mjs";
import { buildAblationHtml } from "./local_stutter_ablation_html.mjs";
import { loadRadRangeManifest, manifestForRadUrl } from "./ablation_rad_range_manifest.mjs";
import { summarizeFrameMetrics, stats, percentile } from "./local_stutter_ablation_metrics.mjs";
import { collectGpuBackendDetailed } from "./render_bottleneck_gpu.mjs";
import {
  startPageStaticServer,
  orbitCamera,
} from "./local_stutter_ablation_cell.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return 0;
  return percentile(s, 0.5);
}

async function waitFullPreload(page, timeoutMs) {
  const t0 = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = await page.evaluate(
      () => window.__ablationProbe?.getRadStats?.()?.preload_rad_requests ?? 0,
    );
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    }
    if (n >= 300 && Date.now() - stableSince >= 2000) return { ok: true, count: n };
    await new Promise((r) => setTimeout(r, 400));
  }
  const count = await page.evaluate(
    () => window.__ablationProbe?.getRadStats?.()?.preload_rad_requests ?? 0,
  );
  return { ok: count >= 280, count };
}

/**
 * @param {{
 *   experimentId: string,
 *   runDir: string,
 *   renderSplatBudgetPercent: number,
 *   measureMs?: number,
 *   preloadMaxMs?: number,
 *   assetPort?: number,
 * }} spec
 */
export async function runRenderLoadScalingCell(spec) {
  const {
    experimentId,
    runDir,
    renderSplatBudgetPercent,
    measureMs = 30_000,
    preloadMaxMs = 120_000,
    assetPort = 0,
  } = spec;

  await fs.mkdir(path.join(runDir, "summary"), { recursive: true });

  const assetSrv = new MonitoredAssetServer({
    rootDir: projectRoot,
    port: assetPort || 19600 + Math.floor(Math.random() * 30),
    runDir,
    runId: experimentId,
  });
  const assetInfo = await assetSrv.start();
  await probeMonitoredServer(assetInfo.base);

  const { outFile: patchedHtml } = await buildAblationHtml({
    assetBase: assetInfo.base,
    ablationMode: "render_only_pure",
    pixelRatio: "auto",
    label: experimentId,
  });

  const pageSrv = await startPageStaticServer(
    0,
    new Map([["/examples/streaming-lod/index.html", patchedHtml]]),
  );

  const pageUrl = new URL(`${pageSrv.base}/examples/streaming-lod/index.html`);
  pageUrl.searchParams.set("world", "Coit Tower, SF");
  pageUrl.searchParams.set("ablation_mode", "render_only_pure");
  pageUrl.searchParams.set("render_splat_budget_percent", String(renderSplatBudgetPercent));

  const chromeArgs = [
    "--disable-dev-shm-usage",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--force-high-performance-gpu",
    "--use-angle=d3d11",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ];

  const browser = await chromium.launch({ headless: false, args: chromeArgs });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const radUrl = `${assetInfo.base}/examples/streaming-lod/coit-40m-sh1-lod.rad`;
    const manifest = manifestForRadUrl(loadRadRangeManifest(), radUrl);
    const page = await context.newPage();
    await page.addInitScript((m) => {
      window.__ablationRadManifest = m;
    }, manifest);

    const traceRec = await attachLocalStutterTraceCollector(page, {
      userId: "u0",
      runDir,
      headless: false,
      chromeExecutable: "",
    });

    await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForFunction(() => window.__slDiagCam != null, undefined, { timeout: 300_000 });

    await page.evaluate(() => window.__ablationSetPhase?.("preload"));
    const preloadDeadline = Date.now() + preloadMaxMs;
    let preload = { ok: false, count: 0 };
    while (Date.now() < preloadDeadline) {
      await orbitCamera(page, 5000);
      preload = await waitFullPreload(page, 3000);
      if (preload.ok) break;
    }

    const preloadCounts = await page.evaluate(() => window.__ablationReadSplatCounts?.() ?? {});

    const budgetResult = await page.evaluate((pct) => window.__ablationApplyRenderSplatBudget?.(pct), renderSplatBudgetPercent);
    await page.evaluate(() => window.__ablationLockLodFetchers?.());

    await orbitCamera(page, 4000);
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
      const counts = window.__ablationReadSplatCounts?.() ?? {};
      const ri = window.__slDiagRenderer?.info?.render ?? {};
      return {
        ...snap,
        ...counts,
        measure_frame_times: [...(diag.measure_frame_times || [])],
        measure_rad_requests: snap.measure_rad_requests ?? 0,
        render_calls: ri.calls ?? 0,
        render_points: ri.points ?? 0,
        render_triangles: ri.triangles ?? 0,
      };
    });

    const gpuBackend = await collectGpuBackendDetailed(page, {
      headless: false,
      chromeArgs,
      chromeProfile: "default",
    });

    await page.waitForTimeout(1500);
    const traceSummary = await traceRec.stop({ flushMs: 0 });

    if (assetSrv.server) await assetSrv.stop();

    const frames = summarizeFrameMetrics(probeData.measure_frame_times ?? []);
    const renderedSamples = probeData.rendered_splat_samples ?? [];
    const drawCalls = probeData.draw_calls_per_frame ?? [];
    const renderedMedian = median(renderedSamples);
    const drawCallsMean = drawCalls.length
      ? drawCalls.reduce((a, b) => a + b, 0) / drawCalls.length
      : 0;

    const pureOk =
      (probeData.measure_rad_requests ?? 0) === 0 && preload.ok;

    const renderedCount =
      renderedMedian ||
      probeData.rendered_splat_count ||
      probeData.visible_splat_count ||
      budgetResult?.target_rendered_splats ||
      0;

    const row = {
      experiment_id: experimentId,
      render_splat_budget_percent: renderSplatBudgetPercent,
      preload_complete: preload.ok,
      preload_rad_requests: preload.count,
      measure_rad_requests: probeData.measure_rad_requests ?? 0,
      pure_ok: pureOk,
      loaded_splat_count: preloadCounts.loaded_splat_count ?? probeData.loaded_splat_count,
      visible_splat_count: probeData.visible_splat_count,
      rendered_splat_count: renderedCount,
      rendered_splat_count_p95: percentile([...renderedSamples].sort((a, b) => a - b), 0.95),
      target_rendered_splats: budgetResult?.target_rendered_splats,
      lod_splat_scale: budgetResult?.lod_splat_scale,
      draw_calls_per_frame_mean: Math.round(drawCallsMean * 100) / 100,
      render_calls_total: probeData.render_calls ?? 0,
      render_points: probeData.render_points ?? 0,
      render_triangles: probeData.render_triangles ?? 0,
      gpu_buffer_bytes_estimated: probeData.upload?.bytes_estimated ?? 0,
      canvas_css_width: gpuBackend.canvas_css_width,
      canvas_css_height: gpuBackend.canvas_css_height,
      drawing_buffer_width: gpuBackend.drawing_buffer_width,
      drawing_buffer_height: gpuBackend.drawing_buffer_height,
      device_pixel_ratio: gpuBackend.device_pixel_ratio,
      measure_fps_mean: frames.fps_mean,
      measure_frame_p95_ms: frames.frame_p95_ms,
      long_frame_over_33ms_count: frames.long_frame_over_33ms_count,
      long_frame_over_100ms_count: frames.long_frame_over_100ms_count,
      trace_ok: !!traceSummary.trace_ok,
      trace_gpu_ms: traceSummary.trace_gpu_ms ?? 0,
      trace_raster_ms: traceSummary.trace_raster_ms ?? 0,
      trace_composite_ms: traceSummary.trace_composite_ms ?? 0,
      webgl_renderer: gpuBackend.webgl_renderer,
      is_integrated_gpu: gpuBackend.is_integrated_gpu,
      run_invalid: false,
      run_invalid_reason: "",
    };

    await context.close();

    await fs.writeFile(path.join(runDir, "gpu_backend.json"), `${JSON.stringify(gpuBackend, null, 2)}\n`);
    await fs.writeFile(
      path.join(runDir, "summary", "experiment_summary.json"),
      `${JSON.stringify(row, null, 2)}\n`,
    );

    return { row, gpuBackend, traceSummary };
  } finally {
    await browser.close().catch(() => {});
    if (pageSrv?.server) await new Promise((r) => pageSrv.server.close(() => r()));
  }
}
