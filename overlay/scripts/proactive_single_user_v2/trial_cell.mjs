/**
 * One v2 proactive single-user trial (ready-aware baselines B3_ready/B4_ready_oracle).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runAblationCell } from "../lib/local_stutter_ablation_cell.mjs";
import { NVIDIA_CHROME_ARGS, NVIDIA_CHROMIUM_LAUNCH } from "../lib/local_stutter_nvidia_chrome.mjs";
import { evaluateProactiveTrialGate } from "./gates.mjs";
import { trialId as makeTrialId } from "./matrix.mjs";
import { BASELINES } from "./constants.mjs";
import { cdpRad206Count, enrichProactiveFromCdp, loadCdpRows } from "./cdp_enrich.mjs";
import { rebuildReferenceFromB0 } from "./reference_demand.mjs";

const BASELINE_CODE = {
  B0_on_demand: "B0",
  B3_ready: "B3R",
  B4_ready_oracle: "B4R",
};

export async function runProactiveTrial({
  batchDir,
  desc,
  delivery,
  referenceDemandPath = null,
  assetPortOffset = 0,
}) {
  const tid = makeTrialId(desc);
  const runDir = path.join(batchDir, "per_trial_runs", tid);
  await fs.mkdir(runDir, { recursive: true });

  let referenceDemand = null;
  let oracleDemand = null;
  if (referenceDemandPath) {
    try {
      referenceDemand = JSON.parse(await fs.readFile(referenceDemandPath, "utf8"));
      oracleDemand = referenceDemand;
    } catch { /* */ }
  }

  const baselineCode = BASELINE_CODE[desc.baseline_id] || "B0";
  const readyAware = baselineCode === "B3R" || baselineCode === "B4R";

  const cellResult = await runAblationCell({
    experimentId: desc.baseline_id,
    runDir,
    ablationMode: "normal",
    headless: false,
    pixelRatio: "1",
    warmupMs: desc.warmup_ms,
    moveMs: desc.move_ms,
    traceChrome: process.env.VRC_TRACE_CHROME !== "0",
    assetPort: 19200 + assetPortOffset,
    phasedMeasure: true,
    assetBaseOverride: delivery.asset_base,
    assetUrlOverride: delivery.asset_url,
    startupMode: "steady_state",
    blockNetworkOnMeasure: false,
    chromeArgs: NVIDIA_CHROME_ARGS,
    chromiumLaunchOptions: NVIDIA_CHROMIUM_LAUNCH,
    proactive: {
      baselineCode,
      budgetBytes: desc.prefetch_budget_bytes,
      maxParallel: readyAware ? 2 : 3,
      oracleDemand,
      readyMode: readyAware,
      predictionHorizonMs: desc.prediction_horizon_ms ?? 2000,
      parseBudgetCps: desc.parse_budget_chunks_per_sec ?? 24,
    },
  });

  const row = cellResult.row ?? {};
  const cdpRows = await loadCdpRows(runDir);
  const cdp206 = cdpRad206Count(cdpRows);
  const proactiveSnap = enrichProactiveFromCdp(row.proactive_snapshot ?? {}, cdpRows, {
    assetUrlHint: delivery.asset_url,
    referenceDemand,
    parseFallbackMs: row.parse_p95_ms ?? 0,
    readyEventPolicy: desc.ready_event_policy ?? "parse_or_upload",
  });

  const visTl = proactiveSnap.visible_splat_timeline ?? row.proactive_snapshot?.visible_splat_timeline ?? [];
  const visibleMax = visTl.reduce((m, e) => Math.max(m, e.visible_splat_count ?? 0), 0);

  const trialJson = {
    trial_id: tid,
    timestamp: new Date().toISOString(),
    phase: desc.phase,
    delivery_key: desc.delivery_key,
    delivery_profile: delivery.profile_id,
    baseline_id: desc.baseline_id,
    baseline_label: BASELINES[desc.baseline_id]?.label ?? desc.baseline_id,
    oracle_upper_bound_labeled: desc.baseline_id === "B4_ready_oracle",
    scenario: desc.scenario,
    asset_url: delivery.asset_url,
    page_url: row.page_url,
    status: "completed",
    protocol: row.protocol,
    status_code: row.status_code ?? (cdp206 > 0 ? 206 : row.total_fetch_requests > 0 ? 206 : null),
    range_request_header: row.range_request_header ?? "bytes=0-65535",
    total_rad_requests: row.total_fetch_requests ?? row.measure_rad_requests ?? cdp206,
    measure_rad_requests: row.measure_rad_requests ?? 0,
    cdp_rad_206_count: cdp206,
    ttfb_p95_ms: row.ttfb_p95_ms ?? row.client_network_total_p95_ms,
    request_total_p95_ms: row.client_network_total_p95_ms ?? row.request_total_p95_ms,
    parse_p95_ms: row.parse_p95_ms,
    parse_total_ms: row.parse_total_ms,
    measure_fps: row.measure_fps_mean,
    frame_p95_ms: row.frame_p95_ms,
    gpu_renderer: row.webgl_renderer ?? cellResult.gpuBackend?.webgl_renderer,
    first_visible_splat_ms: row.first_visible_splat_ms,
    visible_splat_max: visibleMax,
    configured_preload_duration_ms: desc.warmup_ms,
    prediction_horizon_ms: desc.prediction_horizon_ms ?? null,
    parse_budget_chunks_per_sec: desc.parse_budget_chunks_per_sec ?? null,
    ready_event_used: proactiveSnap.ready_event_used ?? null,
    ready_event_counts: proactiveSnap.ready_event_counts ?? null,
    useful_chunks_before_demand: proactiveSnap.useful_chunks_before_demand ?? null,
    demanded_chunks: proactiveSnap.demanded_chunks ?? null,
    deadline_miss_ratio_50ms: proactiveSnap.deadline_miss_ratio_50ms ?? null,
    deadline_miss_ratio_100ms: proactiveSnap.deadline_miss_ratio_100ms ?? null,
    wasted_prefetch_bytes: proactiveSnap.wasted_prefetch_bytes ?? null,
    wasted_prefetch_ratio: proactiveSnap.wasted_prefetch_ratio ?? null,
    total_prefetch_bytes: proactiveSnap.total_prefetch_bytes ?? null,
    total_received_bytes: proactiveSnap.total_received_bytes ?? row.total_fetch_bytes,
    useful_bytes_ratio: proactiveSnap.useful_bytes_ratio ?? null,
    normalized_useful_content_score: proactiveSnap.normalized_useful_content_score ?? null,
    fast_but_empty_detected: proactiveSnap.fast_but_empty_detected ?? false,
    visible_splat_timeline: visTl,
    demand_trace_count: proactiveSnap.demand_trace?.length ?? 0,
    prefetch_trace_count: proactiveSnap.prefetch_trace?.length ?? 0,
    proactive_metrics_complete:
      proactiveSnap.demanded_chunks != null
      && proactiveSnap.deadline_miss_ratio_50ms != null
      && (proactiveSnap.demanded_chunks >= 5 || cdp206 >= 5),
    metrics_version: proactiveSnap.metrics_version ?? 3,
    used_b0_reference_demand: proactiveSnap.used_b0_reference_demand ?? false,
    proactive_snapshot: proactiveSnap,
    run_dir: runDir,
  };

  const gate = evaluateProactiveTrialGate(trialJson);
  trialJson.hard_gate_passed = gate.passed;
  trialJson.hard_gate_failures = gate.failures;
  trialJson.status = gate.passed ? "completed" : "failed";

  const outPath = path.join(batchDir, "per_trial_json", `${tid}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(trialJson, null, 2)}\n`, "utf8");

  if (desc.baseline_id === "B0_on_demand" && gate.passed) {
    await rebuildReferenceFromB0(batchDir, desc.delivery_key);
  }

  return { trialJson, outPath, gate, runDir };
}
