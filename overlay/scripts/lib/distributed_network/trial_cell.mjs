/**
 * One distributed-network trial — wraps local ablation cell, enriches network/trial JSON.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { runAblationCell } from "../local_stutter_ablation_cell.mjs";
import { armCellSpec } from "./constants.mjs";
import { resolveDeliveryProfile } from "./delivery_profiles.mjs";
import { buildDistributedTrialJson } from "./trial_summary.mjs";
import { applyHardGatesToTrialJson, evaluateHardGates } from "./hard_gates.mjs";
import { NVIDIA_CHROME_ARGS, NVIDIA_CHROMIUM_LAUNCH } from "../local_stutter_nvidia_chrome.mjs";

function writeNetworkJsonl(runDir, rows) {
  const p = path.join(runDir, "raw_logs", `network_${path.basename(runDir)}.jsonl`);
  return fs
    .mkdir(path.dirname(p), { recursive: true })
    .then(() =>
      fs.writeFile(
        p,
        rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
        "utf8",
      ),
    )
    .then(() => p);
}

/**
 * @param {{
 *   batchDir: string,
 *   trialDescriptor: object,
 *   profilesDoc: object,
 *   machineMeta?: object,
 *   assetPortOffset?: number,
 * }} opts
 */
export async function runDistributedNetworkTrial(opts) {
  const { batchDir, trialDescriptor, profilesDoc, machineMeta = {}, assetPortOffset = 0 } = opts;
  const cell = armCellSpec(trialDescriptor.arm_id, {
    warmupMs: trialDescriptor.warmup_ms,
    moveMs: trialDescriptor.move_ms,
    measurementMode: trialDescriptor.measurement_mode,
  });

  const delivery = resolveDeliveryProfile(trialDescriptor.delivery_profile, profilesDoc);
  const trialId = [
    trialDescriptor.delivery_profile,
    trialDescriptor.scenario,
    trialDescriptor.arm_id,
    trialDescriptor.measurement_mode,
    `t${trialDescriptor.trial_index}`,
    trialDescriptor.client_id,
  ].join("__");

  const runDir = path.join(batchDir, "per_trial_runs", trialId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.join(batchDir, "raw_logs"), { recursive: true });

  const sessionT0 = Date.now();
  let assetUrl = delivery.asset_url;
  let cacheHeaderRows = [];

  const cellOpts = {
    experimentId: cell.experimentId,
    runDir,
    ablationMode: cell.ablationMode,
    headless: false,
    pixelRatio: cell.pixelRatio,
    warmupMs: trialDescriptor.warmup_ms ?? 12_000,
    moveMs: trialDescriptor.move_ms ?? 18_000,
    traceChrome: process.env.VRC_TRACE_CHROME !== "0",
    assetPort: 19200 + assetPortOffset,
    phasedMeasure: cell.phasedMeasure,
    pureRenderPreload: cell.pureRenderPreload,
    fullReplay: cell.fullReplay,
    chromeArgs: NVIDIA_CHROME_ARGS,
    chromiumLaunchOptions: NVIDIA_CHROMIUM_LAUNCH,
    blockNetworkOnMeasure: trialDescriptor.measurement_mode === "warm_steady_render_mode",
    startupMode: trialDescriptor.startup_mode ?? "steady_state",
  };

  if (!delivery.useLocalMonitoredServer && delivery.asset_url) {
    cellOpts.assetBaseOverride = delivery.asset_base;
    cellOpts.assetUrlOverride = delivery.asset_url;
  }

  let result;
  let error = null;
  const isTransientGoto = (e) => {
    const msg = String(e?.message || e || "");
    return /net::ERR_ABORTED|net::ERR_CONNECTION_REFUSED|net::ERR_EMPTY_RESPONSE|Target page, context or browser has been closed|waitForFunction: Timeout|page\.goto: Timeout/i.test(msg);
  };
  const trialTimeoutMs = trialDescriptor.timeout_ms || 1_200_000;
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`trial_cell timeout after ${ms}ms`)), ms)),
  ]);
  try {
    result = await withTimeout(runAblationCell(cellOpts), trialTimeoutMs);
  } catch (e) {
    if (isTransientGoto(e)) {
      console.warn(`[trial_cell] transient browser error, retrying once: ${String(e?.message || e).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        result = await withTimeout(runAblationCell(cellOpts), trialTimeoutMs);
        error = null;
      } catch (e2) {
        error = e2;
        result = { row: { run_dir: runDir, error: String(e2?.message || e2) }, gpuBackend: {} };
      }
    } else {
      error = e;
      result = { row: { run_dir: runDir, error: String(e?.message || e) }, gpuBackend: {} };
    }
  }

  const row = result.row ?? {};
  const gpuBackend = result.gpuBackend ?? {};
  if (!assetUrl) {
    const summaryPath = path.join(runDir, "summary", "experiment_summary.json");
    try {
      const srv = JSON.parse(readFileSync(path.join(runDir, "gpu_backend.json"), "utf8"));
      void srv;
    } catch { /* */ }
    const auditExists = await fs
      .access(path.join(runDir, "cdp_network_audit.csv"))
      .then(() => true)
      .catch(() => false);
    if (auditExists) {
      const cdpText = readFileSync(path.join(runDir, "cdp_network_audit.csv"), "utf8");
      const lines = cdpText.trim().split(/\r?\n/);
      if (lines.length > 1) {
        const urlCol = lines[0].split(",").indexOf("url");
        const url = lines[1].split(",")[urlCol]?.replace(/^"|"$/g, "");
        if (url?.includes(".rad")) assetUrl = url.split("?")[0];
      }
    }
    if (!assetUrl) {
      assetUrl = `http://127.0.0.1:${cellOpts.assetPort}/examples/streaming-lod/coit-40m-sh1-lod.rad`;
    }
  }

  let cdpRows = [];
  try {
    const csvPath = path.join(runDir, "cdp_network_audit.csv");
    const text = (await fs.readFile(csvPath, "utf8")).trim();
    if (text) {
      const lines = text.split(/\r?\n/);
      const header = lines[0].split(",");
      cdpRows = lines.slice(1).filter(Boolean).map((line) => {
        const cols = line.split(",");
        const o = {};
        header.forEach((h, j) => {
          const v = cols[j] ?? "";
          o[h] = v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : v.replace(/^"|"$/g, "");
        });
        return o;
      });
    }
  } catch {
    /* optional */
  }

  if (cdpRows.length) {
    await writeNetworkJsonl(runDir, cdpRows);
  }

  let probeExtras = {};
  try {
    probeExtras = JSON.parse(
      await fs.readFile(path.join(runDir, "summary", "probe_frame_times.json"), "utf8"),
    );
  } catch { /* */ }
  try {
    const summaryRow = JSON.parse(
      await fs.readFile(path.join(runDir, "summary", "experiment_summary.json"), "utf8"),
    );
    probeExtras = { ...summaryRow, ...probeExtras };
  } catch { /* */ }

  const pageUrl = row.page_url ?? probeExtras.page_url ?? null;
  const preloadDurationMs = trialDescriptor.warmup_ms ?? 12_000;
  const measureDurationMs = trialDescriptor.move_ms ?? 18_000;
  const radRows = cdpRows.filter((r) => String(r.url || "").includes(".rad"));
  const sentTimes = radRows.map((r) => Number(r.requestWillBeSent)).filter(Number.isFinite);
  let firstRadMs = null;
  if (sentTimes.length) {
    const minSent = Math.min(...sentTimes);
    const maxSent = Math.max(...sentTimes);
    if (minSent > 1e12) {
      firstRadMs = Math.max(0, minSent - sessionT0);
    } else if (maxSent - minSent < 600_000) {
      firstRadMs = Math.max(0, minSent - minSent);
    } else {
      firstRadMs = null;
    }
  }

  const trialJson = buildDistributedTrialJson({
    trialId,
    trialDescriptor,
    deliveryResolved: delivery,
    row,
    gpuBackend,
    probeExtras,
    cdpRows,
    cacheHeaderRows,
    pageUrl,
    assetUrl,
    timings: {
      preload_duration_ms: preloadDurationMs,
      measure_duration_ms: measureDurationMs,
      time_to_first_rad_request_ms: firstRadMs,
    },
    machineMeta: {
      machine_id: machineMeta.machine_id ?? process.env.VRC_MACHINE_ID ?? "local",
      worker_id: machineMeta.worker_id ?? process.env.VRC_WORKER_ID ?? "w0",
      browser_context_id: machineMeta.browser_context_id ?? null,
    },
    error: error ? String(error?.message || error) : row.error,
  });

  const gateEval = evaluateHardGates(trialJson);
  applyHardGatesToTrialJson(trialJson, gateEval);

  const outPath = path.join(batchDir, "per_trial_json", `${trialId}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(trialJson, null, 2)}\n`, "utf8");

  const workerLog = path.join(batchDir, "raw_logs", `worker_${machineMeta.worker_id ?? "w0"}.log`);
  await fs.appendFile(
    workerLog,
    `[${new Date().toISOString()}] ${trialId} status=${trialJson.status} fps=${trialJson.measure_fps} rad=${trialJson.measure_rad_requests} gates=${gateEval.failures.join(";") || "ok"}\n`,
    "utf8",
  ).catch(() => {});

  return { trialJson, runDir, outPath, error, gateEval };
}
