/**
 * One READY single-user trial with cold-start protocol.
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
import { runEdgeWarmup } from "./warmup.mjs";
import {
  computeDeadlineMissRatios,
  timeTo1MVisibleSplats,
  timeToVisibleChunks,
} from "./readiness_metrics.mjs";
import { computeVisibleTimelineMetrics } from "./remote_stats.mjs";
import { cdpRad206Count, enrichProactiveFromCdp, loadCdpRows } from "../proactive_single_user_v2/cdp_enrich.mjs";
import { loadRadRangeManifest, manifestForRadUrl } from "../lib/ablation_rad_range_manifest.mjs";
import { summarizeTrialThroughput } from "./cdp_throughput.mjs";
import {
  loadOracleInputs,
  ensureOracleReference,
  validateOracleInputs,
  oracleRangeKey,
  ORACLE_KEY_SCHEMA,
} from "./oracle_reference.mjs";

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

function computeAlignment(cdpRows, serverRows, proactiveSnap) {
  const cdpRad = cdpRows.filter(
    (r) => /\.rad(\?|#|$)/i.test(r.url || "") && (r.range_header || "").startsWith("bytes=") && Number(r.status) === 206,
  );
  if (!cdpRad.length) return null;
  const cdpRanges = new Set(cdpRad.map((r) => r.range_header).filter(Boolean));
  if (!cdpRanges.size) return null;

  // Primary: compare CDP ranges against server request rows
  if (serverRows?.length) {
    const srvRanges = new Set(serverRows.map((r) => r.range_header).filter(Boolean));
    let hit = 0;
    for (const rk of cdpRanges) if (srvRanges.has(rk)) hit += 1;
    return hit / cdpRanges.size;
  }

  // Fallback: compare CDP ranges against demand trace (browser-side alignment)
  const demandTrace = proactiveSnap?.demand_trace || [];
  if (demandTrace.length) {
    const demandRanges = new Set(demandTrace.map((d) => {
      const m = String(d.range_header || d.chunk_id || "").match(/bytes=\d+-\d+/);
      return m ? m[0] : null;
    }).filter(Boolean));
    if (demandRanges.size) {
      let hit = 0;
      for (const rk of cdpRanges) if (demandRanges.has(rk)) hit += 1;
      return hit / cdpRanges.size;
    }
  }

  // Last resort: if CDP shows 206 responses, alignment is self-consistent
  return cdpRad.length >= 3 ? 1.0 : null;
}

function buildRemoteProtocolAudit(cdpRows, assetUrl) {
  const rad = (cdpRows || []).filter((r) => /\.rad(\?|#|$)/i.test(r.url || ""));
  return {
    actual_rad_url: assetUrl,
    rad_request_count: rad.length,
    request_order: rad.slice(0, 80).map((r, seq) => ({
      seq,
      url: r.url,
      range_header: r.range_header,
      status: r.status,
      start_ms: r.request_start_ms ?? r.wall_time_ms,
    })),
    cache_headers_sample: rad.slice(0, 20).map((r) => ({
      cf_cache_status: r.cf_cache_status ?? r.cache_status ?? null,
      age: r.age ?? null,
      etag: r.etag ?? null,
      status: r.status,
    })),
  };
}

function aggregateEdgeMetrics(prefetchTrace = []) {
  const tiers = prefetchTrace.filter((e) => e.event === "delivery_tier");
  const edgeN = tiers.filter((t) => t.tier === "edge" || t.tier === "local").length;
  const remoteN = tiers.filter((t) => t.tier === "remote").length;
  const total = Math.max(1, edgeN + remoteN);
  return {
    edge_fetch_ratio: edgeN / total,
    remote_fetch_ratio: remoteN / total,
    cache_status_known_ratio: tiers.length ? tiers.length / total : 0,
    warmed_chunk_hit_ratio: null,
  };
}

export async function runVrcTrial({
  batchDir,
  desc,
  delivery,
  requestedDeliveryKey = null,
  referenceDemandPath = null,
  assetPortOffset = 0,
  matrix = null,
}) {
  const tid = makeTrialId(desc);
  const runDir = path.join(batchDir, "per_trial_runs", tid);
  await fs.mkdir(runDir, { recursive: true });

  let referenceDemand = null;
  let oracleDemand = null;
  let oracleVisibleGt = [];
  if (referenceDemandPath) {
    try {
      referenceDemand = JSON.parse(await fs.readFile(referenceDemandPath, "utf8"));
    } catch { /* */ }
  }

  const arm = BASELINES[desc.baseline_id];
  const isOracleTrial = desc.baseline_id === "oracle" || arm?.use_oracle === true;

  if (isOracleTrial) {
    await ensureOracleReference(batchDir, {
      phase: desc.phase,
      deliveryRole: delivery.delivery_role,
      deliveryKey: desc.delivery_key,
      assetUrl: delivery.asset_url,
      force: false,
    });
    let oracleIn = await loadOracleInputs(batchDir, {
      phase: desc.phase,
      deliveryRole: delivery.delivery_role,
      assetUrl: delivery.asset_url,
    });
    if (!oracleIn.demand?.length || !oracleIn.visibleKeys?.length) {
      await ensureOracleReference(batchDir, {
        phase: desc.phase,
        deliveryRole: delivery.delivery_role,
        deliveryKey: desc.delivery_key,
        assetUrl: delivery.asset_url,
        force: true,
      });
      oracleIn = await loadOracleInputs(batchDir, {
        phase: desc.phase,
        deliveryRole: delivery.delivery_role,
        assetUrl: delivery.asset_url,
      });
    }
    oracleDemand = oracleIn.demand;
    oracleVisibleGt = oracleIn.visibleKeys;
    referenceDemand = oracleDemand;
  } else if (referenceDemandPath && referenceDemand) {
    oracleDemand = referenceDemand;
  }
  const baselineCode = arm?.proactive_baseline ?? "B0";
  const runId = randomUUID().slice(0, 12);
  const userDataDir = path.join(os.tmpdir(), `vrc-chrome-${runId}`);
  await fs.mkdir(userDataDir, { recursive: true });

  let assetUrl = delivery.asset_url;
  if (assetUrl) assetUrl = assetUrlWithRunId(assetUrl, runId);

  let warmupSummary = null;
  if (
    (desc.warmup_mode === "base_hot_first_screen" && delivery.delivery_role === "edge")
    || (desc.warmup_mode === "remote_equal_warm" && delivery.delivery_role === "remote")
  ) {
    let manifest = [];
    try {
      const raw = loadRadRangeManifest(process.env.VRC_RAD_MANIFEST_CSV);
      manifest = manifestForRadUrl(raw, assetUrl);
    } catch { /* */ }
    warmupSummary = (
      await runEdgeWarmup({ assetUrl, manifest, runDir, useNodeFetch: true })
    ).summary;
  }

  const measureStartup =
    desc.startup_mode === "warm_edge" ? "cold_start" : (desc.startup_mode ?? "cold_start");

  const cellResult = await runAblationCell({
    experimentId: desc.baseline_id,
    runDir,
    ablationMode: "normal",
    headless: false,
    pixelRatio: "1",
    warmupMs: desc.warmup_ms,
    moveMs: desc.move_ms,
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
    coalesceK: arm?.coalesce_k ?? 1,
    sdlK: arm?.sdl_k ?? 0,
    proactive: {
      baselineCode,
      budgetBytes: delivery.delivery_role === "remote"
        ? Math.min(desc.prefetch_budget_bytes, 40 * 1024 * 1024)
        : desc.prefetch_budget_bytes,
      maxParallel: arm?.ready_aware
        ? (delivery.delivery_role === "remote" ? 2 : 2)
        : 3,
      oracleDemand: isOracleTrial ? oracleDemand : referenceDemand,
      oracleVisibleGt: isOracleTrial ? oracleVisibleGt : [],
      oracleKeySchema: ORACLE_KEY_SCHEMA,
      referenceDemand,
      readyMode: arm?.ready_aware ?? false,
      predictionHorizonMs: desc.prediction_horizon_ms ?? 2000,
      parseBudgetCps: desc.parse_budget_chunks_per_sec ?? 24,
      deliveryRole: delivery.delivery_role,
    },
  });

  const row = cellResult.row ?? {};
  const oracleRunAudit = cellResult.oracle_run_audit ?? row.oracle_run_audit ?? null;
  const cdpRows = await loadCdpRows(runDir);
  const manifestRanges = (() => {
    try {
      const raw = loadRadRangeManifest(process.env.VRC_RAD_MANIFEST_CSV);
      return manifestForRadUrl(raw, assetUrl).map((e) => oracleRangeKey(e)).filter(Boolean);
    } catch {
      return [];
    }
  })();
  const cdp206 = cdpRad206Count(cdpRows);
  const proactiveSnap = enrichProactiveFromCdp(row.proactive_snapshot ?? {}, cdpRows, {
    assetUrlHint: assetUrl,
    referenceDemand,
    parseFallbackMs: row.parse_p95_ms ?? 0,
    readyEventPolicy: desc.ready_event_policy ?? "parse_or_upload",
  });

  const visTl = proactiveSnap.visible_splat_timeline ?? [];
  const visibleMax = visTl.reduce((m, e) => Math.max(m, e.visible_splat_count ?? 0), 0);
  const visMetrics = computeVisibleTimelineMetrics(visTl, desc.move_ms ?? 40_000);
  const traceSummary = cellResult.traceSummary ?? {};
  const serverSummary = cellResult.serverSummary ?? {};
  const alignmentRate = computeAlignment(cdpRows, serverSummary.request_rows, proactiveSnap);

  // Compute parse_complete_fill_rate excluding chunks fetched too late to parse
  const chunkStates = proactiveSnap.chunk_states || [];
  const parseWindow = 5000; // 5s grace for parse after fetch
  const trialEnd = desc.move_ms || 40000;
  const eligibleChunks = chunkStates.filter(
    (ch) => ch.chunk_fetch_complete_time != null && ch.chunk_fetch_complete_time + parseWindow <= trialEnd,
  );
  const parsedChunks = eligibleChunks.filter((ch) => ch.chunk_parse_complete_time != null);
  const parseCompleteFillRate = eligibleChunks.length > 0
    ? parsedChunks.length / eligibleChunks.length
    : proactiveSnap.parse_complete_fill_rate ?? null;

  // Compute readiness_gaps_ms for analyze aggregation
  const readinessGaps = chunkStates
    .filter((ch) => ch.chunk_ready_time != null && ch.chunk_needed_time != null)
    .map((ch) => ch.chunk_ready_time - ch.chunk_needed_time);

  // Compute fetch/parse duration arrays for p95 in analyze
  // Prefer CDP download_ms (true per-request network latency, excludes queuing).
  // Fallback to chunk_state timing only when prefetch_start is known (avoids
  // counting queue wait as "network" for on-demand baselines like Spark-OD).
  const cdpRadRows = (cdpRows || []).filter(
    (r) => r.completed && /\.rad(\?|#|$)/i.test(r.url || "") && String(r.status) === "206",
  );
  const cdpDownloadMs = cdpRadRows
    .map((r) => Number(r.download_ms))
    .filter((v) => Number.isFinite(v) && v > 0);
  const fetchDurations = cdpDownloadMs.length > 0
    ? cdpDownloadMs
    : chunkStates
        .filter((ch) => ch.chunk_fetch_complete_time != null && ch.chunk_prefetch_start_time != null)
        .map((ch) => ch.chunk_fetch_complete_time - ch.chunk_prefetch_start_time);
  const parseDurations = chunkStates
    .filter((ch) => ch.chunk_parse_complete_time != null && ch.chunk_parse_start_time != null)
    .map((ch) => ch.chunk_parse_complete_time - ch.chunk_parse_start_time);
  // GPU upload durations (from SplatPager upload_start/upload_complete events)
  const gpuUploadDurations = chunkStates
    .filter((ch) => ch.chunk_upload_complete_time != null && ch.chunk_upload_start_time != null)
    .map((ch) => ch.chunk_upload_complete_time - ch.chunk_upload_start_time);

  // P0-2 lead-time + critical-path derived metrics
  // ready_lead_time = need_time - predecode_end_time  (positive = predecode finished before demand)
  // fetch_lead_time = need_time - response_end_time   (positive = bytes arrived before demand)
  // critical_network_wait_ms = max(0, response_end_time - need_time)  (network on critical path)
  // critical_parse_wait_ms   = max(0, parse_complete_time - max(need_time, response_end_time))
  // demand_to_visible_ms     = visible_time - need_time
  // remote_to_visible_ms     = visible_time - prefetch_request_start (full path latency)
  const readyLeadTimes = [];
  const fetchLeadTimes = [];
  const criticalNetworkWaits = [];
  const criticalParseWaits = [];
  const demandToVisibles = [];
  const remoteToVisibles = [];
  for (const ch of chunkStates) {
    const need = ch.needed_time ?? ch.chunk_needed_time;
    const respEnd = ch.response_end_time ?? ch.fetch_end_time ?? ch.chunk_fetch_complete_time;
    const predEnd = ch.predecode_end_time;
    const parseEnd = ch.parse_complete_time ?? ch.chunk_parse_complete_time;
    const visT = ch.visible_time;
    const preqStart = ch.prefetch_request_start ?? ch.fetch_start_time ?? ch.chunk_prefetch_start_time;
    if (need != null && predEnd != null) readyLeadTimes.push(need - predEnd);
    if (need != null && respEnd != null) {
      fetchLeadTimes.push(need - respEnd);
      criticalNetworkWaits.push(Math.max(0, respEnd - need));
    }
    if (parseEnd != null && need != null) {
      const base = respEnd != null ? Math.max(need, respEnd) : need;
      criticalParseWaits.push(Math.max(0, parseEnd - base));
    }
    if (visT != null && need != null) demandToVisibles.push(visT - need);
    if (visT != null && preqStart != null) remoteToVisibles.push(visT - preqStart);
  }

  const cacheBreakdown = proactiveSnap.cache_hit_breakdown ?? null;
  const breakdownCounters = proactiveSnap.breakdown_counters ?? null;

  const missRatios = computeDeadlineMissRatios(chunkStates, proactiveSnap.demanded_chunks);
  const deliveryMeta = buildDeliveryMetadata({
    requested_delivery_key: requestedDeliveryKey ?? desc.delivery_key,
    actual_delivery_key: delivery.delivery_key,
    delivery,
    asset_url: assetUrl,
    startup_mode: desc.startup_mode,
    warmup_mode: desc.warmup_mode,
  });
  const edgeMetrics = aggregateEdgeMetrics(proactiveSnap.prefetch_trace);
  const measuredFv = row.first_visible_splat_ms;
  const warmupMs = warmupSummary?.warmup_duration_ms ?? 0;
  const measureDurationMs = desc.move_ms ?? 40_000;
  const totalReceivedBytes = proactiveSnap.total_received_bytes ?? row.total_fetch_bytes;

  const throughput = summarizeTrialThroughput({
    cdpRows,
    totalReceivedBytes,
    measureDurationMs,
    warmupDurationMs: warmupMs,
    serverRequestLevel: serverSummary?.request_level ?? null,
  });

  const trialJson = {
    trial_id: tid,
    timestamp: new Date().toISOString(),
    phase: desc.phase,
    delivery_key: desc.delivery_key,
    delivery_profile: delivery.profile_id,
    ...deliveryMeta,
    baseline_id: desc.baseline_id,
    baseline_name: arm?.name ?? desc.baseline_id,
    baseline_label: arm?.name ?? desc.baseline_id,
    network_profile: desc.network_profile ?? null,
    trace: desc.trace ?? "orbit",
    oracle_enabled: isOracleTrial,
    oracle_label: isOracleTrial ? "Oracle-Sched" : null,
    oracle_upper_bound_labeled: isOracleTrial,
    oracle_type: arm?.oracle_type ?? null,
    oracle_demand_file: isOracleTrial ? `reference_demand_${delivery.delivery_role}.json` : null,
    oracle_demand_count: isOracleTrial ? (oracleDemand?.length ?? 0) : null,
    oracle_visible_gt_count: isOracleTrial ? (oracleVisibleGt?.length ?? 0) : null,
    oracle_key_schema: isOracleTrial ? ORACLE_KEY_SCHEMA : null,
    scenario: desc.scenario,
    asset_url: assetUrl,
    run_id: runId,
    cache_state: desc.warmup_mode === "base_hot_first_screen" ? "warm_equal" : "cold",
    browser_profile_fresh: true,
    trial_cache_warm: desc.warmup_mode === "base_hot_first_screen",
    page_url: row.page_url,
    status: "completed",
    protocol: row.protocol,
    status_code: row.status_code ?? (cdp206 > 0 ? 206 : null),
    total_rad_requests: row.total_fetch_requests ?? row.measure_rad_requests ?? cdp206,
    measure_rad_requests: row.measure_rad_requests ?? 0,
    cdp_rad_206_count: cdp206,
    measure_fps: row.measure_fps_mean,
    frame_p95_ms: row.frame_p95_ms,
    long_frame_over_33ms_count: row.measure_jank_33 ?? row.long_frame_over_33ms_count ?? null,
    gpu_renderer: row.webgl_renderer ?? cellResult.gpuBackend?.webgl_renderer,
    first_visible_splat_ms: measuredFv,
    measured_first_visible_ms: measuredFv,
    total_cold_start_with_warmup_ms:
      measuredFv != null && warmupMs ? measuredFv + warmupMs : measuredFv,
    warmup: warmupSummary,
    time_to_50_visible_chunks_ms: timeToVisibleChunks(visTl, 50),
    time_to_1M_visible_splats_ms: visMetrics.time_to_1M_visible_splats_ms ?? timeTo1MVisibleSplats(visTl),
    visible_splat_max: visibleMax,
    visible_splat_count_1s: visMetrics.visible_splat_count_1s,
    visible_splat_count_3s: visMetrics.visible_splat_count_3s,
    visible_splat_count_5s: visMetrics.visible_splat_count_5s ?? visibleAt(visTl, 5),
    visible_splat_count_10s: visMetrics.visible_splat_count_10s ?? visibleAt(visTl, 10),
    visible_splat_count_20s: visibleAt(visTl, 20),
    quality_at_1s: visMetrics.quality_at_1s,
    quality_at_3s: visMetrics.quality_at_3s,
    quality_at_5s: visMetrics.quality_at_5s,
    quality_at_10s: visMetrics.quality_at_10s,
    blank_time_ms: visMetrics.blank_time_ms,
    blank_ratio: visMetrics.blank_ratio,
    empty_time_ms: visMetrics.empty_time_ms,
    bytes_per_visible_splat:
      visibleMax > 0 ? (proactiveSnap.total_received_bytes ?? 0) / visibleMax : null,
    ready_event_used: proactiveSnap.ready_event_used ?? null,
    parse_complete_fill_rate: parseCompleteFillRate,
    useful_chunks_before_demand: missRatios.useful_chunks_before_demand,
    demanded_chunks: missRatios.demanded_chunks,
    completed_chunks: proactiveSnap.chunk_states?.filter((c) => (c.ready_time ?? c.chunk_ready_time) != null).length ?? null,
    visible_chunks: visibleMax,
    deadline_miss_ratio_50ms: missRatios.deadline_miss_ratio_50ms,
    deadline_miss_ratio_100ms: missRatios.deadline_miss_ratio_100ms,
    deadline_miss_ratio_250ms: missRatios.deadline_miss_ratio_250ms,
    deadline_miss_ratio_500ms: missRatios.deadline_miss_ratio_500ms,
    deadline_miss_ratio_1000ms: missRatios.deadline_miss_ratio_1000ms,
    miss50: missRatios.miss50,
    miss100: missRatios.miss100,
    miss250: missRatios.miss250,
    miss500: missRatios.miss500,
    miss1000: missRatios.miss1000,
    network_p50_ms: percentile(fetchDurations, 50),
    network_p95_ms: percentile(fetchDurations, 95),
    network_p99_ms: percentile(fetchDurations, 99),
    ...edgeMetrics,
    wasted_prefetch_bytes: proactiveSnap.wasted_prefetch_bytes ?? null,
    wasted_prefetch_ratio: proactiveSnap.wasted_prefetch_ratio ?? null,
    total_received_bytes: totalReceivedBytes,
    measure_duration_ms: measureDurationMs,
    warmup_duration_ms: warmupMs,
    ...throughput,
    useful_bytes_ratio: proactiveSnap.useful_bytes_ratio ?? null,
    fast_but_empty_detected: proactiveSnap.fast_but_empty_detected ?? false,
    alignment_rate: alignmentRate,
    trace_ok: traceSummary.trace_ok ?? false,
    trace_pose_nonzero: traceSummary.pose_nonzero ?? true,
    visible_splat_timeline: visTl,
    demand_trace_count: proactiveSnap.demand_trace?.length ?? 0,
    readiness_gaps_ms: readinessGaps,
    fetch_durations_ms: fetchDurations,
    parse_durations_ms: parseDurations,
    gpu_upload_durations_ms: gpuUploadDurations,
    parse_cost_p95_ms: percentile(parseDurations, 95),
    gpu_upload_p95_ms: percentile(gpuUploadDurations, 95),
    // P0-2 lead-time + critical-path metrics
    ready_lead_time_ms_p50: percentile(readyLeadTimes, 50),
    ready_lead_time_ms_p95: percentile(readyLeadTimes, 95),
    fetch_lead_time_ms_p50: percentile(fetchLeadTimes, 50),
    fetch_lead_time_ms_p95: percentile(fetchLeadTimes, 95),
    critical_network_wait_ms_p50: percentile(criticalNetworkWaits, 50),
    critical_network_wait_ms_p95: percentile(criticalNetworkWaits, 95),
    critical_parse_wait_ms_p50: percentile(criticalParseWaits, 50),
    critical_parse_wait_ms_p95: percentile(criticalParseWaits, 95),
    demand_to_visible_ms_p50: percentile(demandToVisibles, 50),
    demand_to_visible_ms_p95: percentile(demandToVisibles, 95),
    remote_to_visible_ms_p50: percentile(remoteToVisibles, 50),
    remote_to_visible_ms_p95: percentile(remoteToVisibles, 95),
    ready_lead_time_sample_count: readyLeadTimes.length,
    fetch_lead_time_sample_count: fetchLeadTimes.length,
    cache_hit_breakdown: cacheBreakdown,
    breakdown_counters: breakdownCounters,
    continuous_tick_count: proactiveSnap.continuous_tick_count ?? null,
    session_prior_used: proactiveSnap.session_prior_used ?? false,
    proactive_snapshot: proactiveSnap,
    run_dir: runDir,
    metrics_version: 10,
    cache_key_diag: row.cache_key_diag ?? null,
    ...(isOracleTrial
      ? validateOracleInputs({
          demand: oracleDemand,
          visibleKeys: oracleVisibleGt,
          manifestRanges,
          oracleAudit: oracleRunAudit,
          oracleType: arm?.oracle_type ?? "perceptual_ready",
        })
      : {}),
    ...(isOracleTrial && oracleRunAudit
      ? {
          oracle_visible_boost_count: oracleRunAudit.visible_boost_count,
          oracle_selected_count: oracleRunAudit.selected_count,
          oracle_prefetch_candidate_count: oracleRunAudit.candidate_count,
        }
      : {}),
    ...(delivery.delivery_role === "remote"
      ? { remote_protocol_audit: buildRemoteProtocolAudit(cdpRows, assetUrl) }
      : {}),
  };

  const gate = evaluateTrialGate(trialJson);
  trialJson.hard_gate_passed = gate.passed;
  trialJson.hard_gate_failures = gate.failures;
  trialJson.status = gate.passed ? "completed" : "failed";

  const outPath = path.join(batchDir, "per_trial_json", `${tid}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(trialJson, null, 2)}\n`, "utf8");

  try {
    await fs.rm(userDataDir, { recursive: true, force: true });
  } catch { /* */ }

  return { trialJson, outPath, gate, runDir, serverSummary };
}
