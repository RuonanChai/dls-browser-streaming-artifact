/**
 * Run one ablation experiment cell (v2 instrumentation).
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CdpNetworkAuditor, summarizeCdpNetworkAudit } from "../../vrc-paper/experiments/cdp_network_audit.mjs";
import { writeAuditCsv } from "../../vrc-paper/experiments/audit_io.mjs";
import { attachLocalStutterTraceCollector } from "./local_stutter_trace_collector.mjs";
import { replayCameraTrace } from "../ready_single_user/trace_replay.mjs";
import { MonitoredAssetServer, probeMonitoredServer } from "./local_stutter_asset_server.mjs";
import { ServerProcessMonitor } from "./local_stutter_server_process_monitor.mjs";
import { WindowsSystemMonitor } from "./local_stutter_windows_system_monitor.mjs";
import { writeServerMonitorArtifacts } from "./local_stutter_server_summary.mjs";
import { buildAblationHtml } from "./local_stutter_ablation_html.mjs";
import {
  buildExperimentSummaryRow,
  writeExperimentSummaryMd,
} from "./local_stutter_ablation_metrics.mjs";
import { collectGpuBackend } from "./local_stutter_ablation_gpu_backend.mjs";
import { loadRadRangeManifest, manifestForRadUrl } from "./ablation_rad_range_manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const PURE_RENDER_MODES = new Set([
  "render_only",
  "render_only_pure",
  "static_camera_render_only",
  "static_camera_render_only_pure",
  "moving_camera_render_only",
  "moving_camera_render_only_pure",
  "render_plus_camera_only",
  "render_plus_visibility_only",
  "render_plus_lod_update_only",
]);

const FULL_REPLAY_MODES = new Set(["fetch_only_full", "parse_only_full"]);

function parseSimpleCsv(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.split(",");
    const o = {};
    header.forEach((h, j) => {
      const v = cols[j] ?? "";
      o[h] = v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : v;
    });
    return o;
  });
}

export async function startPageStaticServer(preferredPort, pathOverrides) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
  };
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      let p = decodeURIComponent(u.pathname);
      if (p === "/") p = "/index.html";
      let disk = pathOverrides?.get(p);
      const rel = p.replace(/^\//, "");
      if (!disk && p.startsWith("/examples/")) disk = path.join(projectRoot, rel);
      else if (!disk && p.startsWith("/dist/")) disk = path.join(projectRoot, rel);
      else if (!disk && p.startsWith("/node_modules/")) disk = path.join(projectRoot, rel);
      if (!disk || !existsSync(disk) || !statSync(disk).isFile()) {
        res.writeHead(404);
        res.end("404");
        return;
      }
      res.setHeader("Content-Type", mime[path.extname(disk).toLowerCase()] || "application/octet-stream");
      res.writeHead(200);
      res.end(readFileSync(disk));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e?.message || e));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort > 0 ? preferredPort : 0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}

export async function orbitCamera(page, durationMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < durationMs) {
    const a = ((Date.now() - t0) / durationMs) * Math.PI * 2;
    await page.evaluate((angle) => {
      const c = window.__slDiagCam;
      if (!c) return;
      const r = 6;
      c.position.set(Math.sin(angle) * r, 2.2 + Math.sin(angle * 0.5) * 0.5, Math.cos(angle) * r - 1.1);
      c.lookAt(0, 0, 0);
      c.updateMatrixWorld(true);
    }, a);
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function waitForRadPreloadStable(page, { timeoutMs, minRequests = 280, stableMs = 2500 }) {
  const t0 = Date.now();
  let last = -1;
  let lastChange = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await page.evaluate(() => window.__ablationProbe?.getRadStats?.() ?? {});
    const n = Number(st.preload_rad_requests) || 0;
    if (n !== last) {
      last = n;
      lastChange = Date.now();
    }
    if (n >= minRequests && Date.now() - lastChange >= stableMs) {
      return { ok: true, count: n, elapsedMs: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const st = await page.evaluate(() => window.__ablationProbe?.getRadStats?.() ?? {});
  return { ok: false, count: Number(st.preload_rad_requests) || 0, elapsedMs: Date.now() - t0 };
}

function summarizeMeasureNet(cdpRows, measureRadCount) {
  if (measureRadCount > 0) {
    return { net_total_p50_ms: 0, net_total_p95_ms: 0, net_total_p99_ms: 0, measure_rad_blocked: measureRadCount };
  }
  const radRows = cdpRows.filter((r) => String(r.url || "").includes(".rad") && r.completed);
  return summarizeCdpNetworkAudit(radRows.slice(-20), "u0");
}

export async function startMonitoredAssetServer(runDir, runId, port) {
  const listenPort = port > 0 ? port : 0;
  const srv = new MonitoredAssetServer({
    rootDir: projectRoot,
    port: listenPort,
    runDir,
    runId,
  });
  const info = await srv.start();
  await probeMonitoredServer(info.base);
  return { srv, ...info };
}

/**
 * @param {{
 *   experimentId: string,
 *   runDir: string,
 *   ablationMode: string,
 *   headless: boolean,
 *   pixelRatio: string,
 *   warmupMs: number,
 *   moveMs: number,
 *   traceChrome: boolean,
 *   assetPort: number,
 *   phasedMeasure?: boolean,
 *   pureRenderPreload?: boolean,
 *   fullReplay?: boolean,
 *   chromeArgs?: string[],
 *   chromiumLaunchOptions?: Record<string, unknown>,
 *   vrcOpt?: { adaptiveDpr?: boolean, splatBudget?: boolean, lodThrottle?: boolean },
 *   pureRenderPreload?: boolean,
 *   assetBaseOverride?: string,
 *   assetUrlOverride?: string,
 *   blockNetworkOnMeasure?: boolean,
 *   startupMode?: string,
 *   proactive?: { baselineCode: string, budgetBytes: number, oracleDemand?: object[]|null, readyMode?: boolean, predictionHorizonMs?: number, parseBudgetCps?: number, maxParallel?: number },
 *   userDataDir?: string,
 *   runId?: string,
 *   traceReplay?: string,
 * }} spec
 */
export async function runAblationCell(spec) {
  const {
    experimentId,
    runDir,
    ablationMode,
    headless,
    pixelRatio,
    warmupMs = 20_000,
    moveMs = 40_000,
    traceChrome = true,
    assetPort = 0,
    phasedMeasure = false,
    pureRenderPreload = spec.pureRenderPreload ?? PURE_RENDER_MODES.has(ablationMode),
    fullReplay = FULL_REPLAY_MODES.has(ablationMode),
    chromeArgs: chromeArgsOverride,
    chromiumLaunchOptions = {},
    vrcOpt = {},
    assetBaseOverride,
    assetUrlOverride,
    blockNetworkOnMeasure = true,
    startupMode = "steady_state",
    proactive = null,
    userDataDir = null,
    runId = null,
    traceReplay = null,
    networkProfile = null,
  } = spec;

  const summaryDir = path.join(runDir, "summary");
  await fs.mkdir(summaryDir, { recursive: true });
  const sessionId = `ablation_${experimentId}_${Date.now()}`;
  const sessionT0 = Date.now();
  let pageSrv = null;
  let assetSrv = null;
  let procMon = null;
  let winMon = null;
  let browser = null;
  let context = null;

  if (!assetBaseOverride) {
    await cleanupStaleAblationProcesses();
  }

  if (assetBaseOverride) {
    assetSrv = {
      base: assetBaseOverride.replace(/\/$/, ""),
      srv: { requestRows: [], stop: async () => [] },
    };
  } else {
    assetSrv = await startMonitoredAssetServer(
      runDir,
      sessionId,
      assetPort > 0 ? assetPort : 0,
    );
  }
  procMon = new ServerProcessMonitor(runDir);
  await procMon.start();
  winMon = new WindowsSystemMonitor(runDir);
  await winMon.start();

  const { outFile: patchedHtml } = await buildAblationHtml({
    assetBase: assetSrv.base,
    assetUrl: assetUrlOverride || null,
    ablationMode,
    pixelRatio,
    label: experimentId,
    startupMode,
    proactiveBaselineCode: proactive?.baselineCode ?? null,
    prefetchBudgetBytes: proactive?.budgetBytes ?? 512 * 1024 * 1024,
  });

  const pathOverrides = new Map();
  pathOverrides.set("/examples/streaming-lod/index.html", patchedHtml);
  pageSrv = await startPageStaticServer(0, pathOverrides);

  const pageUrl = new URL(`${pageSrv.base}/examples/streaming-lod/index.html`);
  pageUrl.searchParams.set("world", "Coit Tower, SF");
  pageUrl.searchParams.set("ablation_mode", ablationMode);
  pageUrl.searchParams.set("VRC_DIAG_MODE", ablationMode);
  pageUrl.searchParams.set("pixel_ratio", pixelRatio);
  pageUrl.searchParams.set("VRC_PIXEL_RATIO", pixelRatio);
  if (process.env.VRC_FORCE_GL_FINISH_AFTER_UPLOAD === "true") {
    pageUrl.searchParams.set("VRC_FORCE_GL_FINISH_AFTER_UPLOAD", "1");
  }
  const envBool = (k) => {
    const v = process.env[k];
    if (v === "true" || v === "1") return "1";
    if (v === "false" || v === "0") return "0";
    return null;
  };
  for (const k of ["VRC_DISABLE_LOD_UPDATE", "VRC_DISABLE_GPU_UPLOAD", "VRC_DISABLE_RENDER_LOOP"]) {
    const v = envBool(k);
    if (v != null) pageUrl.searchParams.set(k, v);
  }
  if (vrcOpt.adaptiveDpr) pageUrl.searchParams.set("VRC_OPT_ADAPTIVE_DPR", "1");
  if (vrcOpt.splatBudget) pageUrl.searchParams.set("VRC_OPT_SPLAT_BUDGET", "1");
  if (vrcOpt.lodThrottle) pageUrl.searchParams.set("VRC_OPT_LOD_THROTTLE", "1");
  pageUrl.searchParams.set("VRC_STARTUP_MODE", startupMode);
  if (proactive?.baselineCode) {
    pageUrl.searchParams.set("VRC_PROACTIVE", "1");
    pageUrl.searchParams.set("VRC_PROACTIVE_BASELINE", proactive.baselineCode);
    pageUrl.searchParams.set("VRC_PREFETCH_BUDGET_BYTES", String(proactive.budgetBytes ?? 128 * 1024 * 1024));
    pageUrl.searchParams.set("VRC_PREFETCH_MAX_PARALLEL", String(proactive.maxParallel ?? 2));
    if (proactive.readyMode) pageUrl.searchParams.set("VRC_PROACTIVE_READY", "1");
    if (proactive.predictionHorizonMs) pageUrl.searchParams.set("VRC_PREDICTION_HORIZON_MS", String(proactive.predictionHorizonMs));
    if (proactive.parseBudgetCps) pageUrl.searchParams.set("VRC_PARSE_BUDGET_CPS", String(proactive.parseBudgetCps));
    if (assetUrlOverride) pageUrl.searchParams.set("VRC_RAD_URL", assetUrlOverride);
    if (proactive.deliveryRole) pageUrl.searchParams.set("VRC_DELIVERY_ROLE", proactive.deliveryRole);
  }
  if (runId) pageUrl.searchParams.set("run_id", runId);

  const chromeArgs = chromeArgsOverride ?? [
    "--disable-dev-shm-usage",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--force-high-performance-gpu",
    "--use-angle=d3d11",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ];
  if (headless && !chromeArgsOverride) chromeArgs.push("--headless=new");

  const launchOpts = {
    headless,
    args: chromeArgs,
    viewport: { width: 1280, height: 720 },
    ...chromiumLaunchOptions,
  };
  if (userDataDir) {
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
    browser = null;
  } else {
    browser = await chromium.launch({
      headless,
      args: chromeArgs,
      ...chromiumLaunchOptions,
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  }
  const meta = { userId: "u0", sessionId, method: "AblationV2", scenario: "nearby", trial: 0 };

  let traceRec = null;
  let netAuditor = null;
  try {
    const radUrl =
      assetUrlOverride || `${assetSrv.base}/examples/streaming-lod/coit-40m-sh1-lod.rad`;
    const radManifest = manifestForRadUrl(loadRadRangeManifest(), radUrl);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.addInitScript(
      ({ manifest, oracleDemand, oracleVisibleGt, oracleKeySchema, radUrl, coalesceK, sdlK }) => {
        window.__ablationRadManifest = manifest;
        window.__proactiveRadManifest = manifest;
        window.__proactiveOracleDemand = oracleDemand ?? [];
        window.__proactiveVisibleGroundTruth = oracleVisibleGt ?? [];
        window.__proactiveOracleKeySchema = oracleKeySchema ?? "range_bytes";
        window.__proactiveRadUrl = radUrl;
        if (coalesceK > 1) window.__sparkCoalesceK = coalesceK;
        if (sdlK > 0) window.__sparkSdlK = sdlK;
      },
      {
        manifest: radManifest,
        oracleDemand: proactive?.oracleDemand ?? [],
        oracleVisibleGt: proactive?.oracleVisibleGt ?? [],
        oracleKeySchema: proactive?.oracleKeySchema ?? "range_bytes",
        radUrl,
        coalesceK: spec.coalesceK ?? 1,
        sdlK: spec.sdlK ?? 0,
      },
    );
    const cdpNet = await context.newCDPSession(page);
    netAuditor = new CdpNetworkAuditor(cdpNet, meta);
    await netAuditor.start();

    // Apply CDP network throttling if networkProfile is specified
    if (networkProfile && (networkProfile.rtt_ms > 0 || networkProfile.bandwidth_mbps > 0)) {
      const downloadThroughput = networkProfile.bandwidth_mbps
        ? (networkProfile.bandwidth_mbps * 1024 * 1024) / 8
        : -1; // -1 = no throttle
      const uploadThroughput = downloadThroughput;
      const latency = networkProfile.rtt_ms || 0;
      await cdpNet.send("Network.emulateNetworkConditions", {
        offline: false,
        latency,
        downloadThroughput,
        uploadThroughput,
      });
      console.log(`[ablation] CDP throttle: rtt=${latency}ms bw=${networkProfile.bandwidth_mbps}Mbps`);
    }

    async function moveCamera(durationMs) {
      if (staticCam) {
        await new Promise((r) => setTimeout(r, durationMs));
        return;
      }
      const mode = traceReplay || "orbit";
      if (mode === "orbit") await orbitCamera(page, durationMs);
      else await replayCameraTrace(page, mode, durationMs);
    }

    if (traceChrome) {
      traceRec = await attachLocalStutterTraceCollector(page, {
        userId: "u0",
        runDir,
        headless,
        chromeExecutable: "",
      });
    }

    await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForFunction(() => window.__slDiagCam != null, undefined, { timeout: 300_000 });
    await page.evaluate(() => window.__ablationStartStartupMonitor?.());
    if (proactive?.baselineCode && proactive.baselineCode !== "B0") {
      const prefetchDelay = proactive.deliveryRole === "remote" ? 500 : 1500;
      await page.waitForTimeout(prefetchDelay);
      await page.evaluate(() => window.__proactiveStartPrefetch?.());
    }

    const gpuBackend = await collectGpuBackend(page, { headless });
    await fs.writeFile(path.join(runDir, "gpu_backend.json"), `${JSON.stringify(gpuBackend, null, 2)}\n`);

    const staticCam =
      ablationMode === "static_camera_render_only" ||
      ablationMode === "static_camera_render_only_pure" ||
      ablationMode === "render_plus_lod_update_only";

    if (fullReplay && ablationMode === "fetch_only_full") {
      await page.evaluate(() => window.__ablationSetPhase?.("preload"));
      try {
        await page.waitForFunction(
          () => (window.__ablationProbe?.getSnapshot?.()?.total_fetch_requests ?? 0) >= 200,
          undefined,
          { timeout: 600_000 },
        );
      } catch (e) {
        const fetchCount = await page.evaluate(() => window.__ablationProbe?.getSnapshot?.()?.total_fetch_requests ?? 0);
        console.warn(`[ablation] ${experimentId} fetch_only_full preload timeout after 600s (got ${fetchCount} fetches, needed 200) — proceeding to measure`);
      }
      await page.evaluate(() => window.__ablationBeginMeasurePhase?.());
      if (!staticCam) await moveCamera(moveMs);
      else await new Promise((r) => setTimeout(r, moveMs));
    } else if (fullReplay) {
      await page.evaluate(() => window.__ablationSetPhase?.("preload"));
      if (!staticCam) await moveCamera(warmupMs + moveMs);
      else await new Promise((r) => setTimeout(r, warmupMs + moveMs));
    } else if (pureRenderPreload) {
      await page.evaluate(() => window.__ablationSetPhase?.("preload"));
      const preloadDeadline = Date.now() + Math.max(warmupMs, 120_000);
      let stable = { ok: false, count: 0 };
      while (Date.now() < preloadDeadline) {
        if (!staticCam) await moveCamera(5000);
        else await new Promise((r) => setTimeout(r, 5000));
        stable = await waitForRadPreloadStable(page, {
          timeoutMs: 3000,
          minRequests: 340,
          stableMs: 3000,
        });
        if (stable.ok || stable.count >= 340) break;
      }
      console.log(`[ablation] ${experimentId} preload rad_requests=${stable.count} stable=${stable.ok}`);
      await new Promise((r) => setTimeout(r, 3000));
      await page.evaluate(() => {
        window.__ablationBlockNetwork?.();
        window.__ablationBeginMeasurePhase?.();
      });
      await new Promise((r) => setTimeout(r, 5000));
      await page.evaluate(() => window.__ablationSetPhase?.("measure"));
      if (!staticCam) await moveCamera(moveMs);
      else await new Promise((r) => setTimeout(r, moveMs));
    } else if (phasedMeasure) {
      await page.evaluate(() => window.__ablationSetPhase?.("preload"));
      if (!staticCam) await moveCamera(warmupMs);
      else await new Promise((r) => setTimeout(r, warmupMs));
      if (blockNetworkOnMeasure) {
        await page.evaluate(() => window.__ablationBeginMeasurePhase?.());
      } else {
        await page.evaluate(() => {
          window.__ablationSetPhase?.("measure");
          const d = window.__stutterDiag;
          if (d) {
            d.measure_frame_times = [];
            d.measure_jank_33 = 0;
            d.measure_jank_100 = 0;
            d.frame_times = d.measure_frame_times;
          }
        });
      }
      await page.evaluate(() => window.__ablationSetPhase?.("measure"));
      if (!staticCam) await moveCamera(moveMs);
      else await new Promise((r) => setTimeout(r, moveMs));
    } else {
      await page.evaluate(() => window.__ablationSetPhase?.("preload"));
      if (!staticCam) await moveCamera(warmupMs + moveMs);
      else await new Promise((r) => setTimeout(r, warmupMs + moveMs));
    }

    const probeData = await page.evaluate(() => {
      const snap = window.__ablationProbe?.getSnapshot?.() ?? {};
      const diag = window.__stutterDiag ?? {};
      const splats = window.__ablationReadSplatCounts?.() ?? {};
      const optMetrics = window.__vrcOptGetMetrics?.() ?? {};
      const startup = window.__ablationGetStartupSnapshot?.() ?? {};
      const proactiveSnap = window.__proactiveChunkProbe?.getSnapshot?.() ?? {};
      const prefetchStart = window.__proactiveStartPrefetch?.() ?? null;
      const oracleAudit = window.__oracleRunAudit ?? prefetchStart?.oracle_audit ?? null;
      const cacheKeyDiag = window.__cacheKeyDiag ?? null;
      return {
        ...snap,
        ...startup,
        proactive_snapshot: proactiveSnap,
        oracle_run_audit: oracleAudit,
        prefetch_start: prefetchStart,
        cache_key_diag: cacheKeyDiag,
        cfg: snap.cfg,
        preload: snap.preload,
        measure: snap.measure,
        upload: snap.upload,
        ...splats,
        ...optMetrics,
        preload_frame_times: diag.preload_frame_times ? [...diag.preload_frame_times] : [],
        measure_frame_times: diag.measure_frame_times
          ? [...diag.measure_frame_times]
          : diag.frame_times
            ? [...diag.frame_times]
            : [],
        frame_times: diag.measure_frame_times?.length
          ? [...diag.measure_frame_times]
          : diag.frame_times
            ? [...diag.frame_times]
            : [],
        headed: !/HeadlessChrome/i.test(navigator.userAgent),
        pixel_ratio: new URLSearchParams(location.search).get("pixel_ratio"),
        visibility_state: document.visibilityState,
      };
    });

    probeData.pure_render_valid = pureRenderPreload
      ? (probeData.measure_rad_requests ?? 0) === 0
      : null;

    await netAuditor.stop();
    let traceSummary = { trace_ok: false, trace_error: "trace_disabled" };
    if (traceRec) {
      await page.waitForTimeout(2000);
      traceSummary = await traceRec.stop({ flushMs: 0 });
    }

    const cdpRows = netAuditor.getCsvRows();
    writeAuditCsv(cdpRows, path.join(runDir, "cdp_network_audit.csv"));
    const net = summarizeCdpNetworkAudit(cdpRows, "u0");
    const measureNet = summarizeMeasureNet(cdpRows, probeData.measure_rad_requests ?? 0);

    let serverRows = assetSrv.srv.requestRows ?? [];
    if (assetSrv.srv.server) {
      serverRows = await assetSrv.srv.stop();
    }
    const processRows = await procMon.stop();
    await winMon.stop();
    const windowsRows = parseSimpleCsv(path.join(runDir, "server_monitor", "windows_system_monitor.csv"));

    const { summary: serverSummary } = await writeServerMonitorArtifacts(runDir, summaryDir, {
      serverRows,
      processRows,
      windowsRows,
      cdpRows,
      sessionDurationMs: Date.now() - sessionT0,
      clientNetP95: net.net_total_p95_ms,
    });

    const row = await buildExperimentSummaryRow({
      experimentId,
      diagnosisLabel: ablationMode,
      runDir,
      probeSnapshot: probeData,
      net,
      measureNet,
      serverSummary,
      traceSummary,
      processRows,
      gpuBackend,
    });
    row.headed = !headless;
    row.pixel_ratio = pixelRatio;
    row.page_url = pageUrl.toString();
    row.asset_url = radUrl;
    row.startup_mode = startupMode;
    row.warmup_duration_ms = warmupMs;
    row.configured_preload_duration_ms = warmupMs;
    row.first_visible_splat_ms = probeData.first_visible_splat_ms ?? null;
    row.first_nonblack_frame_ms = probeData.first_nonblack_frame_ms ?? null;
    row.first_quality_10k_splats_ms = probeData.first_quality_10k_splats_ms ?? null;
    row.first_quality_100k_splats_ms = probeData.first_quality_100k_splats_ms ?? null;
    row.first_rad_request_ms = probeData.first_rad_request_ms ?? null;
    row.canvas_luma_sampling_ok = probeData.canvas_luma_sampling_ok ?? false;
    row.cache_key_diag = probeData.cache_key_diag ?? null;
    if (probeData.proactive_snapshot) {
      Object.assign(row, {
        proactive_snapshot: probeData.proactive_snapshot,
        useful_chunks_before_demand: probeData.proactive_snapshot.useful_chunks_before_demand,
        demanded_chunks: probeData.proactive_snapshot.demanded_chunks,
        deadline_miss_ratio_50ms: probeData.proactive_snapshot.deadline_miss_ratio_50ms,
        deadline_miss_ratio_100ms: probeData.proactive_snapshot.deadline_miss_ratio_100ms,
        wasted_prefetch_bytes: probeData.proactive_snapshot.wasted_prefetch_bytes,
        total_received_bytes: probeData.proactive_snapshot.total_received_bytes,
        useful_bytes_ratio: probeData.proactive_snapshot.useful_bytes_ratio,
        fast_but_empty_detected: probeData.proactive_snapshot.fast_but_empty_detected,
        visible_splat_timeline: probeData.proactive_snapshot.visible_splat_timeline,
      });
    }

    await fs.writeFile(path.join(summaryDir, "experiment_summary.json"), `${JSON.stringify(row, null, 2)}\n`);
    await fs.writeFile(
      path.join(summaryDir, "probe_frame_times.json"),
      `${JSON.stringify({
        startup_mode: probeData.startup_mode ?? startupMode,
        first_visible_splat_ms: probeData.first_visible_splat_ms ?? null,
        first_nonblack_frame_ms: probeData.first_nonblack_frame_ms ?? null,
        first_quality_10k_splats_ms: probeData.first_quality_10k_splats_ms ?? null,
        first_quality_100k_splats_ms: probeData.first_quality_100k_splats_ms ?? null,
        first_rad_request_ms: probeData.first_rad_request_ms ?? null,
        canvas_luma_sampling_ok: probeData.canvas_luma_sampling_ok ?? false,
        measure_frame_times: probeData.measure_frame_times ?? [],
        preload_frame_times: probeData.preload_frame_times ?? [],
        visibility_state: probeData.visibility_state,
        visible_splat_count: probeData.visible_splat_count,
        rendered_splat_count: probeData.rendered_splat_count,
        loaded_splat_count: probeData.loaded_splat_count,
        target_rendered_splats: probeData.target_rendered_splats,
        render_scale_mean: probeData.render_scale_mean,
        render_scale_min: probeData.render_scale_min,
        render_scale_change_count: probeData.render_scale_change_count,
        budget_scale_mean: probeData.budget_scale_mean,
        budget_scale_min: probeData.budget_scale_min,
        lod_update_count: probeData.lod_update_count,
        skipped_lod_update_count: probeData.skipped_lod_update_count,
        quality_proxy: probeData.quality_proxy,
      })}\n`,
    );
    await writeExperimentSummaryMd(row, path.join(summaryDir, "experiment_summary.md"));
    await context.close();

    return {
      row,
      serverSummary,
      traceSummary,
      net,
      gpuBackend,
      oracle_run_audit: probeData.oracle_run_audit ?? null,
      prefetch_start: probeData.prefetch_start ?? null,
    };
  } finally {
    try {
      if (context) await context.close();
    } catch { /* */ }
    try {
      if (browser && browser !== context) await browser.close();
    } catch { /* */ }
    try {
      if (pageSrv?.server) await new Promise((resolve) => pageSrv.server.close(() => resolve()));
    } catch { /* */ }
    try {
      if (assetSrv?.srv?.server) await assetSrv.srv.stop();
    } catch { /* */ }
    try {
      if (procMon) await procMon.stop();
    } catch { /* */ }
    try {
      if (winMon) await winMon.stop();
    } catch { /* */ }
  }
}

export async function cleanupStaleAblationProcesses() {
  if (process.platform !== "win32") return;
  const selfPid = process.pid;
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${selfPid} -and $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*stutter-ablation*' -or $_.CommandLine -like '*http-server*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore" },
    );
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*windows_monitor.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore" },
    );
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and ($_.CommandLine -like '*playwright*' -or $_.CommandLine -like '*--remote-debugging-pipe*' -or $_.CommandLine -like '*--enable-automation*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore" },
    );
  } catch { /* */ }
}
