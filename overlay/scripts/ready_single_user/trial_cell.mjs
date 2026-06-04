/**
 * One DLS evaluation trial (Spark-OD or DLS with __sparkSdlK).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runAblationCell } from "../lib/local_stutter_ablation_cell.mjs";
import { NVIDIA_CHROME_ARGS, NVIDIA_CHROMIUM_LAUNCH } from "../lib/local_stutter_nvidia_chrome.mjs";
import { evaluateTrialGate } from "./gates.mjs";
import { trialId as makeTrialId } from "./matrix.mjs";
import { BASELINES } from "./constants.mjs";
import { assetUrlWithRunId } from "./delivery.mjs";
import { buildDeliveryMetadata } from "./delivery_metadata.mjs";
import {
  computeDeadlineMissRatios,
  timeTo1MVisibleSplats,
  timeToVisibleChunks,
} from "./readiness_metrics.mjs";
import { computeVisibleTimelineMetrics } from "./remote_stats.mjs";
import { cdpRad206Count, enrichProactiveFromCdp, loadCdpRows } from "./cdp_enrich.mjs";
import { loadRadRangeManifest, manifestForRadUrl } from "../lib/ablation_rad_range_manifest.mjs";
import { summarizeTrialThroughput } from "./cdp_throughput.mjs";

function percentile(xs, p) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1);
  return v[Math.max(0, idx)];
}

function visibleAt(timeline, sec) {
  const target = sec * 1000;
  let best = 0;
  for (const e of timeline || []) {
    if ((e.t ?? 0) <= target) best = Math.max(best, e.visible_splat_count ?? 0);
  }
  return best;
}

export async function runVrcTrial({
  batchDir,
  desc,
  delivery,
  requestedDeliveryKey = null,
  assetPortOffset = 0,
  matrix = null,
}) {
  const tid = makeTrialId(desc);
  const runDir = path.join(batchDir, "per_trial_runs", tid);
  await fs.mkdir(runDir, { recursive: true });

  const arm = BASELINES[desc.baseline_id];
  const runId = randomUUID().slice(0, 12);
  const userDataDir = path.join(os.tmpdir(), `dls-chrome-${runId}`);
  await fs.mkdir(userDataDir, { recursive: true });

  let assetUrl = delivery.asset_url;
  if (assetUrl) assetUrl = assetUrlWithRunId(assetUrl, runId);

  const measureStartup =
    desc.startup_mode === "warm_edge" ? "cold_start" : (desc.startup_mode ?? "cold_start");

  const cellResult = await runAblationCell({
    experimentId: desc.baseline_id,
    runDir,
    ablationMode: "normal",
    headless: false,
    pixelRatio: "1",
    warmupMs: desc.warmup_ms ?? 0,
    moveMs: desc.move_ms ?? 40_000,
    traceChrome: process.env.VRC_TRACE_CHROME !== "0",
    assetPort: delivery.useLocalMonitoredServer ? 0 : 19300 + assetPortOffset,
    phasedMeasure: true,
    assetBaseOverride: delivery.asset_base,
    assetUrlOverride: assetUrl,
    startupMode: measureStartup,
    blockNetworkOnMeasure: false,
    chromeArgs: [...NVIDIA_CHROME_ARGS, "--disk-cache-size=1"],
    chromiumLaunchOptions: NVIDIA_CHROMIUM_LAUNCH,
    userDataDir,
    runId,
    traceReplay: desc.trace ?? "orbit",
    networkProfile: desc.network_profile
      ? (matrix?.network_profiles?.[desc.network_profile] ?? null)
      : null,
    coalesceK: 1,
    sdlK: arm?.sdl_k ?? 0,
    proactive: null,
  });

  const row = cellResult.row ?? {};
  const cdpRows = await loadCdpRows(runDir);
  const cdp206 = cdpRad206Count(cdpRows);
  const proactiveSnap = enrichProactiveFromCdp(row.proactive_snapshot ?? {}, cdpRows, {
    assetUrlHint: assetUrl,
    parseFallbackMs: row.parse_p95_ms ?? 0,
    readyEventPolicy: desc.ready_event_policy ?? "parse_or_upload",
  });

  const visTl = proactiveSnap.visible_splat_timeline ?? [];
  const visibleMax = visTl.reduce((m, e) => Math.max(m, e.visible_splat_count ?? 0), 0);
  const visMetrics = computeVisibleTimelineMetrics(visTl, desc.move_ms ?? 40_000);
  const serverSummary = cellResult.serverSummary ?? {};
  const chunkStates = proactiveSnap.chunk_states || [];
  const missRatios = computeDeadlineMissRatios(chunkStates, proactiveSnap.demanded_chunks);
  const deliveryMeta = buildDeliveryMetadata({
    requested_delivery_key: requestedDeliveryKey ?? desc.delivery_key,
    actual_delivery_key: delivery.delivery_key,
    delivery,
    asset_url: assetUrl,
    startup_mode: desc.startup_mode,
    warmup_mode: desc.warmup_mode,
  });

  const fetchDurations = (cdpRows || [])
    .filter((r) => r.completed && /\.rad(\?|#|$)/i.test(r.url || "") && String(r.status) === "206")
    .map((r) => Number(r.download_ms))
    .filter((v) => Number.isFinite(v) && v > 0);

  const throughput = summarizeTrialThroughput({
    cdpRows,
    totalReceivedBytes: proactiveSnap.total_received_bytes ?? row.total_fetch_bytes,
    measureDurationMs: desc.move_ms ?? 40_000,
    warmupDurationMs: 0,
    serverRequestLevel: serverSummary?.request_level ?? null,
  });

  const trialJson = {
    trial_id: tid,
    timestamp: new Date().toISOString(),
    phase: desc.phase,
    delivery_key: desc.delivery_key,
    ...deliveryMeta,
    baseline_id: desc.baseline_id,
    baseline_name: arm?.name ?? desc.baseline_id,
    sdl_k: arm?.sdl_k ?? 0,
    network_profile: desc.network_profile ?? null,
    trace: desc.trace ?? "orbit",
    scenario: desc.scenario,
    asset_url: assetUrl,
    run_id: runId,
    status: "completed",
    status_code: row.status_code ?? (cdp206 > 0 ? 206 : null),
    total_rad_requests: row.total_fetch_requests ?? cdp206,
    cdp_rad_206_count: cdp206,
    measure_fps: row.measure_fps_mean,
    frame_p95_ms: row.frame_p95_ms,
    gpu_renderer: row.webgl_renderer ?? cellResult.gpuBackend?.webgl_renderer,
    first_visible_splat_ms: row.first_visible_splat_ms,
    time_to_1M_visible_splats_ms: visMetrics.time_to_1M_visible_splats_ms ?? timeTo1MVisibleSplats(visTl),
    visible_splat_max: visibleMax,
    visible_splat_count_5s: visMetrics.visible_splat_count_5s ?? visibleAt(visTl, 5),
    blank_time_ms: visMetrics.blank_time_ms,
    blank_ratio: visMetrics.blank_ratio,
    miss100: missRatios.miss100,
    miss50: missRatios.miss50,
    fetch_p50_ms: percentile(fetchDurations, 50),
    fetch_p95_ms: percentile(fetchDurations, 95),
    cdp_net_p50_ms: throughput.net_p50_ms,
    cdp_net_p95_ms: throughput.net_p95_ms,
    total_received_bytes: proactiveSnap.total_received_bytes,
    chunk_state_count: chunkStates.length,
    run_dir: runDir,
  };

  const gate = evaluateTrialGate(trialJson);
  trialJson.hard_gate_passed = gate.passed;
  trialJson.gate_failures = gate.failures;

  await fs.writeFile(
    path.join(batchDir, "per_trial_json", `${tid}.json`),
    `${JSON.stringify(trialJson, null, 2)}\n`,
    "utf8",
  );

  return { trialJson, gate, serverSummary };
}
