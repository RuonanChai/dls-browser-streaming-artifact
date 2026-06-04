#!/usr/bin/env node
/**
 * READY single-user analysis + paper artifacts.
 *
 *   node scripts/ready_single_user/analyze.mjs --batchDir=... --phase=all
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  evaluatePhaseASanity,
  evaluatePhaseBClaim,
  evaluatePhaseBMiniClaim,
  evaluatePhaseDeliveryCompareSanity,
  evaluatePhaseLocalCeilingSanity,
  evaluatePhaseReadyGreenGate,
  evaluatePhaseRemoteDirectGates,
  isRemotePhase,
  PHASE_READY_PEER_NAMES,
  suggestMiniFixCategory,
  getRemotePipelineDecision,
  suggestRemoteClaimFixCategories,
  remotePhaseIsFrozen,
  writeBlockerReport,
} from "./gates.mjs";
import { PAPER_MATERIALS_DIR } from "./constants.mjs";
import { writeDeliveryAnalysis } from "./analyze_delivery.mjs";
import { enrichTrialThroughput } from "./cdp_throughput.mjs";
import { aggregateBaselineRemoteStats, enrichRemoteTrialMetrics } from "./remote_stats.mjs";
import { writeOracleInputAudit } from "./oracle_input_audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, PAPER_MATERIALS_DIR);

function parseArgs(argv) {
  let batchDir = null;
  let phase = "all";
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) batchDir = path.resolve(a.slice(11));
    else if (a.startsWith("--phase=")) phase = a.slice(8);
  }
  return { batchDir, phase };
}

function csv(rows, keys) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function percentile(xs, p) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1);
  return v[Math.max(0, idx)];
}

function groupBy(trials, keyFn) {
  const m = {};
  for (const t of trials) {
    const k = keyFn(t);
    if (!m[k]) m[k] = [];
    m[k].push(t);
  }
  return m;
}

async function loadTrials(batchDir) {
  const dir = path.join(batchDir, "per_trial_json");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const trials = await Promise.all(
    files.map((f) => fs.readFile(path.join(dir, f), "utf8").then(JSON.parse)),
  );
  const enriched = await Promise.all(trials.map((t) => enrichTrialThroughput(t)));
  return enriched.map((t) => enrichRemoteTrialMetrics(t));
}

function aggregateRow(name, trials) {
  const pass = trials.filter((t) => t.hard_gate_passed);
  const allGaps = pass.flatMap((t) => t.readiness_gaps_ms || []);
  const earlyCount = allGaps.filter((g) => g <= 0).length;
  return {
    baseline_name: name,
    n: pass.length,
    miss50: mean(pass.map((t) => t.miss50)),
    miss100: mean(pass.map((t) => t.miss100)),
    miss250: mean(pass.map((t) => t.miss250)),
    miss500: mean(pass.map((t) => t.miss500)),
    miss1000: mean(pass.map((t) => t.miss1000)),
    first_visible_splat_ms: mean(pass.map((t) => t.first_visible_splat_ms)),
    network_p95_ms: mean(pass.map((t) => t.network_p95_ms)),
    useful_chunks_before_demand: mean(pass.map((t) => t.useful_chunks_before_demand)),
    useful_bytes_ratio: mean(pass.map((t) => t.useful_bytes_ratio)),
    wasted_prefetch_ratio: mean(pass.map((t) => t.wasted_prefetch_ratio)),
    measure_fps: mean(pass.map((t) => t.measure_fps)),
    long_frame_over_33ms_count: mean(pass.map((t) => t.long_frame_over_33ms_count)),
    demanded_chunks: mean(pass.map((t) => t.demanded_chunks)),
    completed_chunks: mean(pass.map((t) => t.completed_chunks)),
    measure_rad_requests: mean(pass.map((t) => t.measure_rad_requests)),
    visible_splat_count_5s: mean(pass.map((t) => t.visible_splat_count_5s)),
    visible_splat_count_10s: mean(pass.map((t) => t.visible_splat_count_10s)),
    visible_splat_count_20s: mean(pass.map((t) => t.visible_splat_count_20s)),
    bytes_per_visible_splat: mean(pass.map((t) => t.bytes_per_visible_splat)),
    fast_but_empty_rate: pass.filter((t) => t.fast_but_empty_detected).length / Math.max(1, pass.length),
    readiness_gap_p50_ms: percentile(allGaps, 50),
    readiness_gap_p95_ms: percentile(allGaps, 95),
    readiness_gap_mean_ms: mean(allGaps),
    early_ready_ratio: allGaps.length ? earlyCount / allGaps.length : null,
    fetch_p95_ms: percentile(pass.flatMap((t) => t.fetch_durations_ms || []), 95),
    parse_p95_ms: percentile(pass.flatMap((t) => t.parse_durations_ms || []), 95),
    parse_complete_fill_rate: mean(pass.map((t) => t.parse_complete_fill_rate)),
    total_received_bytes: mean(pass.map((t) => t.total_received_bytes)),
    throughput_Mbps: mean(pass.map((t) => t.throughput_Mbps)),
    throughput_cdp_session_mbps: mean(pass.map((t) => t.throughput_cdp_session_mbps)),
    throughput_server_session_mbps: mean(pass.map((t) => t.throughput_server_session_mbps)),
    throughput_bytes_over_measure_mbps: mean(pass.map((t) => t.throughput_bytes_over_measure_mbps)),
    throughput_per_request_mbps_p50: mean(pass.map((t) => t.throughput_per_request_mbps_p50)),
    cdp_rad_bytes: mean(pass.map((t) => t.cdp_rad_bytes)),
  };
}

async function writePhaseBMini(trials) {
  const phaseTrials = trials.filter((t) => t.phase === "phaseB_mini" && t.hard_gate_passed);
  if (!phaseTrials.length) {
    console.warn("[analyze] No phaseB_mini trials found");
    return null;
  }
  const byBase = groupBy(phaseTrials, (t) => t.baseline_name);
  const rows = Object.entries(byBase).map(([name, ts]) => aggregateRow(name, ts));
  const keys = Object.keys(rows[0] || { baseline_name: "" });
  await fs.writeFile(path.join(outDir, "phaseB_mini_results.csv"), csv(rows, keys), "utf8");

  const mini = evaluatePhaseBMiniClaim(rows);
  const { checks, color } = mini;
  const ready = rows.find((r) => r.baseline_name === "READY");
  const readyBytes = ready?.total_received_bytes ?? 0;
  const naivePf = rows.find((r) => r.baseline_name === "Naive-PF");
  const naiveBytes = naivePf?.total_received_bytes ?? 0;
  const readyUseful = ready?.useful_bytes_ratio ?? 0;
  const naiveUseful = naivePf?.useful_bytes_ratio ?? 0;

  const audit = `# Phase B Mini Audit (n=1 cold)

Trials: ${phaseTrials.length} passed

## Aggregates
${rows.map((r) => `- **${r.baseline_name}** (n=${r.n}): miss100=${((r.miss100 ?? 0) * 100).toFixed(1)}%, first_visible=${r.first_visible_splat_ms?.toFixed(0)}ms, useful_before=${r.useful_chunks_before_demand?.toFixed(1)}, gap_p50=${r.readiness_gap_p50_ms?.toFixed(0)}ms, gap_p95=${r.readiness_gap_p95_ms?.toFixed(0)}ms, early_ready=${((r.early_ready_ratio ?? 0) * 100).toFixed(1)}%`).join("\n")}

## Peer Comparison (READY must beat BOTH READY-P and SGSS for GREEN)
| Peer | READY miss100 | Peer miss100 | READY useful_before | Peer useful_before | READY beats peer |
|------|---------------|--------------|---------------------|--------------------|------------------|
| READY-P | ${((ready?.miss100 ?? 0) * 100).toFixed(1)}% | ${((rows.find((r) => r.baseline_name === "READY-P")?.miss100 ?? 0) * 100).toFixed(1)}% | ${ready?.useful_chunks_before_demand?.toFixed(1)} | ${rows.find((r) => r.baseline_name === "READY-P")?.useful_chunks_before_demand?.toFixed(1)} | ${checks.ready_beats_ready_p ? "YES" : "NO"} |
| SGSS | ${((ready?.miss100 ?? 0) * 100).toFixed(1)}% | ${((rows.find((r) => r.baseline_name === "SGSS")?.miss100 ?? 0) * 100).toFixed(1)}% | ${ready?.useful_chunks_before_demand?.toFixed(1)} | ${rows.find((r) => r.baseline_name === "SGSS")?.useful_chunks_before_demand?.toFixed(1)} | ${checks.ready_beats_sgss ? "YES" : "NO"} |

## Naive-PF Bytes Guard
- READY total_bytes: ${readyBytes?.toFixed(0)}
- Naive-PF total_bytes: ${naiveBytes?.toFixed(0)}
- READY useful_bytes_ratio: ${(readyUseful * 100).toFixed(1)}%
- Naive-PF useful_bytes_ratio: ${(naiveUseful * 100).toFixed(1)}%
- Guard: ${checks.naive_pf_bytes_guard ? "PASS" : "YELLOW — READY wins only by fetching more"}

## Readiness Gap
${rows.map((r) => `- ${r.baseline_name}: gap_p50=${r.readiness_gap_p50_ms?.toFixed(0)}ms, gap_p95=${r.readiness_gap_p95_ms?.toFixed(0)}ms, early_ready=${((r.early_ready_ratio ?? 0) * 100).toFixed(1)}%`).join("\n")}
`;
  await fs.writeFile(path.join(outDir, "phaseB_mini_audit.md"), audit, "utf8");

  const guard = `# Phase B Mini Claim Guard

**Status: ${color}**

| Check | Result |
|-------|--------|
| primary vs Spark-OD | ${checks.primary_vs_sparkod ? "GREEN" : "RED"} |
| READY beats READY-P (readiness) | ${checks.ready_beats_ready_p ? "GREEN" : "FAIL"} |
| READY beats SGSS (readiness) | ${checks.ready_beats_sgss ? "GREEN" : "FAIL"} |
| beats BOTH READY-P and SGSS | ${mini.beats_both_peers ? "GREEN" : "FAIL"} |
| Naive-PF bytes guard | ${checks.naive_pf_bytes_guard ? "GREEN" : "YELLOW"} |
| wasted_prefetch ≤30% | ${checks.wasted_prefetch_le_30pct ? "GREEN" : "RED"} |
| measure_fps ≥60 | ${checks.measure_fps_ge_60 ? "GREEN" : "RED"} |
| fast_but_empty false | ${checks.fast_but_empty_false ? "GREEN" : "RED"} |

Proceed to full Phase B: **${mini.proceed_full_phase_b ? "YES" : "NO"}**

> GREEN requires READY to beat **both** READY-P and SGSS on readiness-primary metrics (miss100 / useful_before+gap / early_ready). Beating Spark-OD alone is insufficient.
`;
  await fs.writeFile(path.join(outDir, "phaseB_mini_claim_guard.md"), guard, "utf8");

  if (color !== "GREEN") {
    await writeBlockerReport({
      failedGate: "Phase B mini claim guard",
      suspectedCause:
        color === "YELLOW"
          ? "READY beats Spark-OD but not both READY-P and SGSS — see blocker_report.md"
          : `Failed checks: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")}`,
      evidencePaths: [
        path.join(outDir, "phaseB_mini_results.csv"),
        path.join(outDir, "phaseB_mini_audit.md"),
        path.join(outDir, "phaseB_mini_claim_guard.md"),
      ],
      proposedFix:
        "Fix readiness-aware priority (first-visible, deadline, parse-cost in score, queue priority, SGSS code isolation). Re-run phaseB_mini only — do NOT run full Phase B until GREEN.",
      claimImpact: "Block full Phase B and strong READY-vs-SOTA claims until mini is GREEN",
    });
  }

  return mini;
}

async function writePhaseReadyGreenGate(trials, phaseName) {
  const phaseTrials = trials.filter((t) => t.phase === phaseName && t.hard_gate_passed);
  if (!phaseTrials.length) {
    console.warn(`[analyze] No ${phaseName} trials found`);
    return null;
  }
  const byBase = groupBy(phaseTrials, (t) => t.baseline_name);
  const rows = Object.entries(byBase).map(([name, ts]) => aggregateRow(name, ts));
  const slug = phaseName.replace(/^phase_/, "");
  const resultsPath = path.join(outDir, `${slug}_results.csv`);
  const keys = Object.keys(rows[0] || { baseline_name: "" });
  await fs.writeFile(resultsPath, csv(rows, keys), "utf8");

  const gate = evaluatePhaseReadyGreenGate(rows, phaseName);
  const peerNames = PHASE_READY_PEER_NAMES[phaseName] || [];
  const ready = rows.find((r) => r.baseline_name === "READY");

  const peerTable = peerNames
    .map((peer) => {
      const p = rows.find((r) => r.baseline_name === peer);
      const win = gate.peer_results?.[peer];
      return `| ${peer} | m500=${((p?.miss500 ?? p?.miss100 ?? 0) * 100).toFixed(1)}% | useful=${p?.useful_chunks_before_demand?.toFixed(1) ?? "—"} | ${win ? "YES" : "NO"} |`;
    })
    .join("\n");

  const audit = `# ${phaseName} Audit (n=${phaseTrials.length} passed)

## Aggregates
${rows.map((r) => `- **${r.baseline_name}** (n=${r.n}): miss100=${((r.miss100 ?? 0) * 100).toFixed(1)}%, first_visible=${r.first_visible_splat_ms?.toFixed(0)}ms, useful_before=${r.useful_chunks_before_demand?.toFixed(1)}, gap_p50=${r.readiness_gap_p50_ms?.toFixed(0)}ms, early_ready=${((r.early_ready_ratio ?? 0) * 100).toFixed(1)}%`).join("\n")}

## READY vs peers (miss500/miss1000 primary; Oracle not required)
| Peer | Peer miss500/miss100 | useful_before | READY wins |
|------|----------------------|---------------|------------|
${peerTable}

## Ablation distinct (READY-E ≠ READY-P, READY ≠ READY-E)
- READY-E ≠ READY-P: ${gate.ablation_distinct?.ready_e_ne_ready_p ?? "n/a"}
- READY ≠ READY-E: ${gate.ablation_distinct?.ready_ne_ready_e ?? "n/a"}
- READY-G ≠ READY-P: ${gate.ablation_distinct?.ready_g_ne_ready_p ?? "n/a"}

READY: miss100=${((ready?.miss100 ?? 0) * 100).toFixed(1)}%, useful_before=${ready?.useful_chunks_before_demand?.toFixed(1)}
`;
  const auditPath = path.join(outDir, `${slug}_audit.md`);
  await fs.writeFile(auditPath, audit, "utf8");

  const guardPath = path.join(outDir, `${slug}_claim_guard.md`);
  const guard = `# ${phaseName} Claim Guard

**Status: ${gate.color}**

| Check | Result |
|-------|--------|
| READY row present | ${gate.checks?.ready_row_present ? "PASS" : "FAIL"} |
| All peers present | ${gate.checks?.all_peers_present ? "PASS" : `FAIL missing: ${(gate.missing_peers || []).join(", ")}`} |
| primary vs Spark-OD | ${gate.checks?.primary_vs_sparkod ? "GREEN" : "RED"} |
| beats ALL peers (${peerNames.length}) | ${gate.beats_all_peers ? "GREEN" : `FAIL: ${(gate.failed_peers || []).join(", ")}`} |
| startup ≤1.2× Spark-OD | ${gate.checks?.startup_not_regressed ? "GREEN" : "RED"} |
| READY-E ≠ READY-P | ${gate.checks?.ready_e_ne_ready_p !== false ? "PASS" : "FAIL"} |
| READY ≠ READY-E | ${gate.checks?.ready_ne_ready_e !== false ? "PASS" : "FAIL"} |
| wasted_prefetch ≤30% | ${gate.checks?.wasted_prefetch_metrics_missing ? "SKIP (missing)" : gate.checks?.wasted_prefetch_le_30pct ? "GREEN" : "RED"} |
| measure_fps ≥60 | ${gate.checks?.measure_fps_metrics_missing ? "SKIP (missing)" : gate.checks?.measure_fps_ge_60 ? "GREEN" : "RED"} |
| fast_but_empty | ${gate.checks?.fast_but_empty_metrics_missing ? "SKIP (missing)" : gate.checks?.fast_but_empty_ok ? "GREEN" : "RED"} |
| Naive-PF bytes guard | ${gate.checks?.naive_pf_bytes_guard ? "GREEN" : "YELLOW"} |

Proceed mini chain: **${gate.proceed_mini_chain ? "YES" : "NO"}** | eligible main n=5: **${gate.eligible_main_n5 ? "YES" : "NO"}**

> Edge claim: READY beats peers on miss500/miss1000 (fallback miss100), useful+gap/early, without >20% first_visible regression.
`;
  await fs.writeFile(guardPath, guard, "utf8");

  if (gate.color !== "GREEN") {
    await writeBlockerReport({
      failedGate: `${phaseName} claim guard (${gate.color})`,
      suspectedCause:
        gate.failed_peers?.length
          ? `READY did not beat: ${gate.failed_peers.join(", ")}`
          : `Missing peers or hygiene: ${Object.entries(gate.checks || {})
              .filter(([, v]) => !v)
              .map(([k]) => k)
              .join(", ")}`,
      evidencePaths: [resultsPath, auditPath, guardPath],
      proposedFix: `See ${slug}_fix_categories.json — apply category-specific fix per Runbook §9.7.`,
      claimImpact: `Block n=5 main for ${phaseName} until GREEN`,
    });
  }

  const fixCategories = suggestMiniFixCategory({ phase: phaseName, gate, trials: phaseTrials });
  await fs.writeFile(
    path.join(outDir, `${slug}_fix_categories.json`),
    `${JSON.stringify({ phase: phaseName, fix_categories: fixCategories }, null, 2)}\n`,
    "utf8",
  );

  return { ...gate, guardPath, auditPath, resultsPath, fix_categories: fixCategories };
}

function formatMiniMetricsRow(t) {
  return {
    baseline: t.baseline_name,
    delivery_role: t.delivery_role,
    requested_delivery: t.requested_delivery,
    actual_delivery: t.actual_delivery,
    server_url: t.server_url,
    asset_url: t.asset_url ?? t.rad_url,
    completed_chunks: t.completed_chunks,
    visible_chunks: t.visible_chunks ?? t.visible_splat_max,
    first_visible_ms: t.first_visible_splat_ms,
    measured_first_visible_ms: t.measured_first_visible_ms,
    time_to_50_visible_chunks_ms: t.time_to_50_visible_chunks_ms,
    miss100: t.miss100,
    miss250: t.miss250,
    miss500: t.miss500,
    miss1000: t.miss1000,
    useful_before_demand: t.useful_chunks_before_demand,
    early_ready_ratio:
      t.readiness_gaps_ms?.length
        ? t.readiness_gaps_ms.filter((g) => g <= 0).length / t.readiness_gaps_ms.length
        : null,
    network_p95_ms: t.network_p95_ms,
    parse_wait_p95_ms: t.parse_wait_p95_ms,
    parse_cost_p95_ms: t.parse_cost_p95_ms,
    gpu_wait_p95_ms: t.gpu_wait_p95_ms,
    gpu_upload_p95_ms: t.gpu_upload_p95_ms,
    warmed_chunk_hit_ratio: t.warmed_chunk_hit_ratio,
    edge_fetch_ratio: t.edge_fetch_ratio,
    remote_fetch_ratio: t.remote_fetch_ratio,
    wasted_bytes_after_deadline: t.wasted_bytes_after_deadline,
    measure_fps: t.measure_fps,
    frame_p95_ms: t.frame_p95_ms,
    throughput_Mbps: t.throughput_Mbps,
    throughput_cdp_session_mbps: t.throughput_cdp_session_mbps,
    throughput_server_session_mbps: t.throughput_server_session_mbps,
    throughput_bytes_over_measure_mbps: t.throughput_bytes_over_measure_mbps,
    throughput_per_request_mbps_p50: t.throughput_per_request_mbps_p50,
    cdp_rad_bytes: t.cdp_rad_bytes,
    total_received_bytes: t.total_received_bytes,
  };
}

async function writeMiniPhaseMetrics(trials, phaseName) {
  const phaseTrials = trials.filter((t) => t.phase === phaseName && t.hard_gate_passed);
  if (!phaseTrials.length) return;
  const slug = phaseName.replace(/^phase_/, "");
  const rows = phaseTrials.map(formatMiniMetricsRow);
  const keys = Object.keys(rows[0]);
  const md = `# ${phaseName} mini metrics

${rows.map((r) => `## ${r.baseline}\n${keys.map((k) => `- ${k}: ${r[k]}`).join("\n")}`).join("\n\n")}
`;
  await fs.writeFile(path.join(outDir, `mini_metrics_${slug}.md`), md, "utf8");
  await fs.writeFile(
    path.join(outDir, `mini_metrics_${slug}.json`),
    `${JSON.stringify(rows, null, 2)}\n`,
    "utf8",
  );
}

async function writePhaseLocalCeilingSanity(trials) {
  const phaseName = "phase_local_ceiling";
  const phaseTrials = trials.filter((t) => t.phase === phaseName && t.hard_gate_passed);
  if (!phaseTrials.length) {
    console.warn(`[analyze] No ${phaseName} trials`);
    return null;
  }
  await writeMiniPhaseMetrics(trials, phaseName);
  const gate = evaluatePhaseLocalCeilingSanity(phaseTrials);
  const slug = "local_ceiling";
  const guardPath = path.join(outDir, `${slug}_claim_guard.md`);
  const guard = `# phase_local_ceiling Sanity Guard

**Status: ${gate.color}** (control/ceiling — **no** beat-all peers)

| Check | Result |
|-------|--------|
| delivery_role=local | ${gate.checks.all_delivery_role_local ? "PASS" : "FAIL"} |
| rad all trials | ${gate.checks.rad_activity_all_trials ? "PASS" : `WARN ratio=${((gate.checks.rad_activity_ratio ?? 0) * 100).toFixed(0)}%`} |
| visible splat | ${gate.checks.visible_splat_observed ? "PASS" : "FAIL"} |
| network_p95 | ${gate.checks.network_p95_present ? "PASS" : "FAIL"} |
| parse metrics | ${gate.checks.parse_metrics_present ? "PASS" : "WARN"} |
| gpu metrics | ${gate.checks.gpu_metrics_present ? "PASS" : "WARN"} |
| no high-FPS-zero-rad | ${gate.checks.no_high_fps_zero_rad ? "PASS" : "FAIL"} |

Proceed mini chain: **${gate.proceed_mini_chain ? "YES" : "NO"}**
`;
  await fs.writeFile(guardPath, guard, "utf8");
  const fixCategories = suggestMiniFixCategory({ phase: phaseName, gate, trials: phaseTrials });
  await fs.writeFile(
    path.join(outDir, `${slug}_fix_categories.json`),
    `${JSON.stringify({ phase: phaseName, fix_categories: fixCategories }, null, 2)}\n`,
    "utf8",
  );
  return { ...gate, guardPath, fix_categories: fixCategories };
}

function remotePhaseSlug(phaseName) {
  return phaseName.replace(/^phase_/, "").replace(/_/g, "_");
}

async function writeRemoteBaselineSummary(phaseTrials, phaseName) {
  const baselines = [...new Set(phaseTrials.map((t) => t.baseline_name))].sort();
  const rows = baselines.map((b) => aggregateBaselineRemoteStats(phaseTrials, b));
  const keys = Object.keys(rows[0] || { baseline_name: "" });
  const csv = [
    keys.join(","),
    ...rows.map((r) => keys.map((k) => r[k] ?? "").join(",")),
  ].join("\n");
  const slug = remotePhaseSlug(phaseName);
  await fs.writeFile(path.join(outDir, `REMOTE_BASELINE_SUMMARY_${slug}.csv`), `${csv}\n`, "utf8");
  return rows;
}

async function writePhaseRemoteDirectGatesReport(trials, phaseNameFilter = null) {
  const phaseTrials = trials.filter(
    (t) => isRemotePhase(t.phase) && t.hard_gate_passed && (!phaseNameFilter || t.phase === phaseNameFilter),
  );
  if (!phaseTrials.length) {
    console.warn("[analyze] No remote phase trials");
    return null;
  }
  const phaseName = phaseTrials[0].phase;
  await writeMiniPhaseMetrics(trials, phaseName);
  const summaryRows = await writeRemoteBaselineSummary(phaseTrials, phaseName);
  const gates = evaluatePhaseRemoteDirectGates(phaseTrials);
  const infra = gates.remote_infra_gate;
  const claim = gates.remote_claim_gate;
  const slug = remotePhaseSlug(phaseName);

  const infraGuard = `# ${phaseName} — remote_infra_gate

**Status: ${infra.color}** (infrastructure only — **not** performance claim)

| Check | Result |
|-------|--------|
| delivery_role=remote | ${infra.checks.all_delivery_role_remote ? "PASS" : "FAIL"} |
| no fallback edge/local | ${infra.checks.no_fallback_to_edge_or_local ? "PASS" : "FAIL"} |
| .rad URL recorded | ${infra.checks.remote_asset_url_recorded ? "PASS" : "FAIL"} |
| R2 URL canonical | ${infra.checks.remote_asset_url_canonical ? "PASS" : "FAIL"} |
| protocol audit present | ${infra.checks.remote_protocol_audit_present ? "PASS" : "FAIL"} |
| RAD 206 all trials | ${infra.checks.rad_activity_all_trials ? "PASS" : "FAIL"} |
| alignment ≥99% | ${infra.checks.alignment_ok ? "PASS" : "FAIL"} |
| visible_splat_max present | ${infra.checks.visible_splat_max_present ? "PASS" : "FAIL"} |
| metrics complete (FV, t1M/visible, throughput) | ${infra.checks.metrics_complete ? "PASS" : "FAIL"} |

Proceed mini (infra): **${infra.proceed_mini_chain ? "YES" : "NO"}** | eligible main (infra): **${infra.eligible_main_n5 ? "YES" : "NO"}**

> ${infra.note} Mini→main 仅看 **infra**；n<5 时 **claim** 不阻塞管线。
`;
  await fs.writeFile(path.join(outDir, `${slug}_infra_guard.md`), infraGuard, "utf8");

  const c = claim.checks ?? {};
  const pm = claim.primary_metrics;
  const rs = claim.ready_stats;
  const ss = claim.spark_stats;
  const primaryRows = (pm?.wins ?? [])
    .map(
      (w) =>
        `| ${w.id} | ${w.rule} | ${w.win ? "PASS" : "FAIL"} | ${w.ready ?? "—"} | ${w.spark ?? "—"} |`,
    )
    .join("\n");

  const claimGuard = `# ${phaseName} — remote_claim_gate

**Status: ${claim.color}** (${claim.reason || "—"})${gates.claim_is_statistical ? "" : " _(advisory: n<5)_"}

> Pre-registered **10% effect-size** on **primary user-visible** metrics only. RAD 206 / network_p95 are **not** primary wins.

| Requirement | Result |
|-------------|--------|
| infra GREEN | ${c.infra_green ? "PASS" : "FAIL"} |
| primary **≥2/4** at 10% | ${c.primary_two_of_four ? `PASS (${c.primary_win_count}/4)` : `FAIL (${c.primary_win_count ?? 0}/4)`} |
| FPS ≥60 | ${c.fps_ge_60 ? "PASS" : "FAIL"} |
| frame_p95 ≤1.2× Spark | ${c.frame_p95_safe ? "PASS" : "FAIL"} |
| outlier rate ≤0.2 | ${c.outlier_rate_ok ? "PASS" : "FAIL"} |
| bytes/visible ≤1.5× (or q5≥1.2×) | ${c.bytes_per_visible_ok ? "PASS" : "FAIL"} |
| no opposite raw/filtered FV | ${c.robust_no_opposite_stories ? "PASS" : "FAIL"} |
| not lose median+filtered FV | ${c.ready_not_loses_median_and_filtered_fv ? "PASS" : "FAIL"} |
| not outlier-only win | ${c.wins_only_after_outlier_removal ? "FAIL" : "PASS"} |

## Primary metrics (READY vs Spark-OD)

| Metric | Rule | Win | READY | Spark |
|--------|------|-----|-------|-------|
${primaryRows || "| — | — | — | — | — |"}

## Aggregates

| Metric | READY | Spark-OD |
|--------|-------|----------|
| FV median | ${rs?.first_visible_ms_median?.toFixed(0) ?? "—"} | ${ss?.first_visible_ms_median?.toFixed(0) ?? "—"} |
| time_to_1M median | ${rs?.time_to_1M_visible_ms_median?.toFixed(0) ?? "—"} | ${ss?.time_to_1M_visible_ms_median?.toFixed(0) ?? "—"} |
| blank_ratio_0_10s | ${rs?.blank_ratio_0_10s_median?.toFixed(3) ?? rs?.blank_ratio_0_10s_mean?.toFixed(3) ?? "—"} | ${ss?.blank_ratio_0_10s_median?.toFixed(3) ?? ss?.blank_ratio_0_10s_mean?.toFixed(3) ?? "—"} |
| quality@5s | ${rs?.quality_at_5s_mean?.toFixed(0) ?? "—"} | ${ss?.quality_at_5s_mean?.toFixed(0) ?? "—"} |
| outlier rate | ${((claim.ready_outlier_rate ?? 0) * 100).toFixed(0)}% | ${((claim.spark_outlier_rate ?? 0) * 100).toFixed(0)}% |

**May write "READY solves remote direct"?** ${claim.may_claim_ready_solves_remote ? "**YES**" : "**NO**"}  
**Auto-fix allowed?** ${claim.auto_fix_allowed ? "YES" : "**NO (frozen test_main or infra-only)**"}

## Oracle-Sched (this batch)

| Trial | oracle_input_valid | demand | visible GT | boost | note |
|-------|-------------------|--------|------------|-------|------|
${phaseTrials
  .filter((t) => t.baseline_id === "oracle")
  .map(
    (t) =>
      `| ${t.trial_id ?? t.baseline_name} | ${t.oracle_input_valid ? "YES" : "**NO**"} | ${t.oracle_demand_count ?? "—"} | ${t.oracle_visible_gt_count ?? "—"} | ${t.oracle_visible_boost_count ?? "—"} | ${t.oracle_invalid_reason ?? "ok"} |`,
  )
  .join("\n") || "| — | — | — | — | — | — |"}

> Oracle invalid input → **not** an upper bound. See \`ORACLE_INPUT_AUDIT.md\`.

> ${claim.note}
`;
  await fs.writeFile(path.join(outDir, `${slug}_claim_guard.md`), claimGuard, "utf8");

  const fixCategories = [
    ...suggestRemoteClaimFixCategories({ gate: gates, claim, phase: phaseName }),
    ...suggestMiniFixCategory({ phase: phaseName, gate: gates, trials: phaseTrials }),
  ].filter((x, i, a) => a.indexOf(x) === i);

  const decision = getRemotePipelineDecision({
    phase: phaseName,
    infra,
    claim,
    iteration: 0,
  });

  const subAgentMd = `# Sub-agent analysis — ${phaseName}

**Batch**: (see caller batchDir)  
**remote_infra_gate**: ${infra.color}  
**remote_claim_gate**: ${claim.color} (${claim.reason})  
**n (READY/Spark)**: ${rs?.n_raw ?? 0} / ${ss?.n_raw ?? 0}  
**Decision**: \`${decision}\`

## Primary wins (${pm?.win_count ?? 0}/4 need ≥2)
${(pm?.wins ?? []).map((w) => `- ${w.id}: ${w.win ? "WIN" : "loss"} (${w.ready ?? "—"} vs ${w.spark ?? "—"})`).join("\n") || "_none_"}

## Fix categories
${fixCategories.map((x) => `- ${x}`).join("\n") || "_none_"}

## Prohibited as GREEN basis
- network_p95 alone
- RAD 206 count alone
- mini n=1 Spark 22.7s anecdote as formal claim
- tuning after \`phase_remote_test_main\`
`;
  await fs.writeFile(path.join(outDir, `${slug}_sub_agent_analysis.md`), subAgentMd, "utf8");

  await fs.writeFile(
    path.join(outDir, `${slug}_fix_categories.json`),
    `${JSON.stringify(
      {
        phase: phaseName,
        remote_infra_gate: infra.color,
        remote_claim_gate: claim.color,
        claim_reason: claim.reason,
        decision,
        auto_fix_allowed: claim.auto_fix_allowed,
        code_frozen: remotePhaseIsFrozen(phaseName),
        fix_categories: fixCategories,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (!infra.proceed_mini_chain) {
    await writeBlockerReport({
      failedGate: `${phaseName} remote_infra_gate`,
      suspectedCause: Object.entries(infra.checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(", "),
      evidencePaths: [
        path.join(outDir, `${slug}_infra_guard.md`),
        path.join(outDir, `REMOTE_BASELINE_SUMMARY_${slug}.csv`),
      ],
      proposedFix: fixCategories.join("; ") || "Fix remote URL, alignment, metrics.",
      claimImpact: "Block until remote_infra_gate passes",
    });
  }
  if (claim.color === "RED" && gates.claim_is_statistical) {
    await writeBlockerReport({
      failedGate: `${phaseName} remote_claim_gate`,
      suspectedCause: "READY does not beat Spark-OD on remote startup + visible content (see claim guard).",
      evidencePaths: [path.join(outDir, `${slug}_claim_guard.md`)],
      proposedFix: "Re-run with fair remote protocol (n≥10, interleave, fresh profile). Do NOT tune controller to force gate.",
      claimImpact: "Do NOT write 'READY solves remote direct' in paper",
    });
  }

  return { ...gates, summaryRows, fix_categories: fixCategories };
}

async function writePhaseDeliveryCompareSanity(trials) {
  const phaseName = "phase_delivery_compare";
  const phaseTrials = trials.filter((t) => t.phase === phaseName && t.hard_gate_passed);
  if (!phaseTrials.length) {
    console.warn(`[analyze] No ${phaseName} trials`);
    return null;
  }
  await writeMiniPhaseMetrics(trials, phaseName);
  const gate = evaluatePhaseDeliveryCompareSanity(phaseTrials);
  const slug = "delivery_compare";
  const guardPath = path.join(outDir, `${slug}_claim_guard.md`);
  const p = gate.network_p95 || {};
  const guard = `# phase_delivery_compare Guard

**Status: ${gate.color}**

| Check | Result |
|-------|--------|
| local + edge + remote present | ${gate.checks.has_local && gate.checks.has_edge && gate.checks.has_remote ? "PASS" : "FAIL"} |
| local network_p95 lowest | ${gate.checks.local_p95_lowest ? "PASS" : "FAIL"} |
| remote worst path | ${gate.checks.remote_worst_path ? "PASS" : "FAIL"} |
| edge ≤ remote or more chunks | ${gate.checks.edge_between_or_beats_remote ? "PASS" : "WARN"} |

network_p95: local=${p.local?.toFixed(0)} edge=${p.edge?.toFixed(0)} remote=${p.remote?.toFixed(0)} ms

Proceed mini chain (Step 6): **${gate.proceed_mini_chain ? "YES" : "NO"}**
`;
  await fs.writeFile(guardPath, guard, "utf8");
  const fixCategories = suggestMiniFixCategory({ phase: phaseName, gate, trials: phaseTrials });
  await fs.writeFile(
    path.join(outDir, `${slug}_fix_categories.json`),
    `${JSON.stringify({ phase: phaseName, fix_categories: fixCategories }, null, 2)}\n`,
    "utf8",
  );
  return { ...gate, guardPath, fix_categories: fixCategories };
}

async function writePhaseB(trials) {
  const phaseTrials = trials.filter((t) => t.phase === "phaseB_main" && t.hard_gate_passed);
  const byBase = groupBy(phaseTrials, (t) => t.baseline_name);
  const rows = Object.entries(byBase).map(([name, ts]) => aggregateRow(name, ts));
  const keys = Object.keys(rows[0] || { baseline_name: "" });
  await fs.writeFile(path.join(outDir, "phaseB_main_results.csv"), csv(rows, keys), "utf8");

  const claim = evaluatePhaseBClaim(phaseTrials);
  const audit = `# Phase B Main Cold-Start Audit

Trials: ${phaseTrials.length} passed

## Aggregates
${rows.map((r) => `- **${r.baseline_name}** (n=${r.n}): miss100=${((r.miss100 ?? 0) * 100).toFixed(1)}%, first_visible=${r.first_visible_splat_ms?.toFixed(0)}ms, useful_before=${r.useful_chunks_before_demand?.toFixed(1)}`).join("\n")}

## Claim Gates
${Object.entries(claim.gates).map(([k, v]) => `- ${k}: ${v ? "PASS" : "FAIL"}`).join("\n")}

Strong claim OK: **${claim.strong_claim_ok}**
Beats ablation OK: **${claim.beats_ablation_ok}**
`;
  await fs.writeFile(path.join(outDir, "phaseB_main_audit.md"), audit, "utf8");

  const guard = `# Phase B Claim Guard

| Claim | Status |
|-------|--------|
| READY improves miss100 ≥30% vs Spark-OD | ${claim.gates.miss100_drop_30pct ? "GREEN" : "RED"} |
| READY improves first_visible ≥30% | ${claim.gates.first_visible_drop_30pct ? "GREEN" : "RED"} |
| useful_before threshold | ${claim.gates.useful_before ? "GREEN" : "RED"} |
| wasted_prefetch ≤30% | ${claim.gates.wasted_prefetch_le_30pct ? "GREEN" : "RED"} |
| measure_fps ≥60 | ${claim.gates.measure_fps_ge_60 ? "GREEN" : "RED"} |
| fast_but_empty false | ${claim.gates.fast_but_empty_false ? "GREEN" : "RED"} |
| READY beats READY-P | ${claim.gates.ready_beats_ready_p ? "GREEN" : "YELLOW"} |
| READY beats SGSS | ${claim.gates.ready_beats_sgss ? "GREEN" : "YELLOW"} |
`;
  await fs.writeFile(path.join(outDir, "phaseB_claim_guard.md"), guard, "utf8");

  if (!claim.strong_claim_ok) {
    await writeBlockerReport({
      failedGate: "Phase B main claim",
      suspectedCause: "READY vs Spark-OD thresholds not met",
      evidencePaths: [path.join(outDir, "phaseB_main_results.csv"), path.join(outDir, "phaseB_claim_guard.md")],
      proposedFix: "Tune priority/deadline/parse budget or fix readiness instrumentation",
      claimImpact: claim.beats_ablation_ok ? "Weaken to YELLOW" : "RED — block strong READY claim",
    });
  }
  return claim;
}

async function writePhaseC(trials) {
  const phaseTrials = trials.filter((t) => t.phase === "phaseC_ablation" && t.hard_gate_passed);
  const byBase = groupBy(phaseTrials, (t) => t.baseline_name);
  const rows = Object.entries(byBase).map(([name, ts]) => aggregateRow(name, ts));
  const keys = Object.keys(rows[0] || { baseline_name: "" });
  await fs.writeFile(path.join(outDir, "phaseC_ablation_results.csv"), csv(rows, keys), "utf8");

  const ready = rows.find((r) => r.baseline_name === "READY");
  const readyP = rows.find((r) => r.baseline_name === "READY-P");
  const readyE = rows.find((r) => r.baseline_name === "READY-E");
  const readyG = rows.find((r) => r.baseline_name === "READY-G");
  const beatsP = ready && readyP && (ready.miss100 ?? 1) < (readyP.miss100 ?? 1);
  const beatsE = ready && readyE && (ready.miss100 ?? 1) <= (readyE.miss100 ?? 1);
  const beatsG = ready && readyG && (ready.miss100 ?? 1) <= (readyG.miss100 ?? 1);
  const ok = beatsP && beatsE && beatsG;

  const audit = `# Phase C Ablation Audit

READY beats READY-P on miss100: **${beatsP ? "YES" : "NO"}**
READY ≤ READY-E / READY-G (full system should match or improve): **${beatsE && beatsG ? "YES" : "NO"}**

${rows.map((r) => `- ${r.baseline_name}: miss100=${((r.miss100 ?? 0) * 100).toFixed(1)}%, waste=${((r.wasted_prefetch_ratio ?? 0) * 100).toFixed(1)}%, fps=${r.measure_fps?.toFixed(0)}`).join("\n")}
`;
  await fs.writeFile(path.join(outDir, "phaseC_ablation_audit.md"), audit, "utf8");

  if (!ok && phaseTrials.length >= 6) {
    await writeBlockerReport({
      failedGate: "Phase C ablation",
      suspectedCause: "READY not significantly better than READY-P / READY-E / READY-G ablations",
      evidencePaths: [path.join(outDir, "phaseC_ablation_results.csv")],
      proposedFix: "Check prediction accuracy, first-visible priority, parse cost, cache contamination, readiness events",
      claimImpact: "Weaken readiness-aware priority claim; analyze ablation axes",
    });
  }
}

async function writePhaseD(trials) {
  const phaseTrials = trials.filter((t) => t.phase === "phaseD_network" && t.hard_gate_passed);
  const rows = phaseTrials.map((t) => ({
    network_profile: t.network_profile,
    baseline_name: t.baseline_name,
    miss100: t.miss100,
    first_visible_splat_ms: t.first_visible_splat_ms,
    fast_but_empty_detected: t.fast_but_empty_detected,
    visible_splat_count_5s: t.visible_splat_count_5s,
    useful_chunks_before_demand: t.useful_chunks_before_demand,
    bytes_per_visible_splat: t.bytes_per_visible_splat,
  }));
  const keys = Object.keys(rows[0] || { baseline_name: "" });
  await fs.writeFile(path.join(outDir, "phaseD_network_stress.csv"), csv(rows, keys), "utf8");
  await fs.writeFile(
    path.join(outDir, "phaseD_network_stress_audit.md"),
    `# Phase D Network Stress\n\nTrials: ${phaseTrials.length}\n`,
    "utf8",
  );
}

async function writePhaseE(trials) {
  const phaseTrials = trials.filter((t) => t.phase === "phaseE_trace" && t.hard_gate_passed);
  const rows = phaseTrials.map((t) => ({
    trace: t.trace,
    baseline_name: t.baseline_name,
    miss100: t.miss100,
    first_visible_splat_ms: t.first_visible_splat_ms,
    useful_chunks_before_demand: t.useful_chunks_before_demand,
    measure_fps: t.measure_fps,
  }));
  const keys = Object.keys(rows[0] || { baseline_name: "" });
  await fs.writeFile(path.join(outDir, "phaseE_trace_robustness.csv"), csv(rows, keys), "utf8");
  await fs.writeFile(
    path.join(outDir, "phaseE_trace_robustness_audit.md"),
    `# Phase E Trace Robustness\n\nTrials: ${phaseTrials.length}\n`,
    "utf8",
  );
}

async function writeFinalReport(trials, claim) {
  const md = `# READY Single-User Final Report

## RQ1: Readiness mismatch exists?
Spark-OD exhibits deadline misses and low useful-before-demand under cold-start streaming.
Evidence: Phase B Spark-OD aggregates in \`phaseB_main_results.csv\`.

## RQ2: READY vs baselines
${claim?.strong_claim_ok ? "READY meets Phase B gates vs Spark-OD." : "Phase B gates NOT met — see phaseB_claim_guard.md."}
Methods compared: Spark-OD, Naive-PF, PRoGS, SGSS, READY-P, READY, Oracle.

## RQ3: Ablation
See \`phaseC_ablation_results.csv\`. Full **READY** vs READY-P / READY-V / READY-I / READY-D / READY-B.

## RQ4: Network stress
WAN-M/S/H profiles in \`phaseD_network_stress.csv\`.

## RQ5: Trace robustness
orbit / stop-go / burst-turn / random-walk in \`phaseE_trace_robustness.csv\`.

---
*Single-user only. No multi-user delivery claims.*
`;
  await fs.writeFile(path.join(outDir, "FINAL_REPORT.md"), md, "utf8");
}

async function writeClaimEvidence(trials) {
  const md = `# Claim Evidence Table

| Claim | Metric | Figure | CSV | Caveat |
|-------|--------|--------|-----|--------|
| Readiness mismatch | miss100 on Spark-OD | fig_main_deadline_miss.pdf | phaseB_main_results.csv | Not network-only |
| Fast-but-empty | fast_but_empty_detected | fig_fast_but_empty.pdf | phaseD_network_stress.csv | Report visible_splat@5/10/20s |
| READY improves readiness | useful_before, miss100 | fig_main_useful_before.pdf | phaseB_main_results.csv | Phase B gate required |
| READY beats prediction-only | READY vs READY-P miss100 | fig_ablation_deadline.pdf | phaseC_ablation_results.csv | If ≈, weaken claim |
`;
  await fs.writeFile(path.join(outDir, "CLAIM_EVIDENCE_TABLE.md"), md, "utf8");
}

async function writeConclusionGuard(claim) {
  const md = `# Conclusion Guard

## GREEN (may write strongly)
${claim?.strong_claim_ok ? "- READY improves cold-start single-user readiness vs Spark-OD" : "- (none until Phase B passes)"}
${claim?.beats_ablation_ok ? "- READY outperforms READY-P and SGSS on deadline miss" : ""}

## YELLOW (weak claim only)
${!claim?.beats_ablation_ok ? "- READY vs READY-P/SGSS — ablation signal weak" : ""}
- PRoGS/SGSS are SOTA-style, not exact reproduction

## RED (forbidden)
- READY solves multi-user delivery
- Prediction alone solves the bottleneck
- Downloaded bytes equal render-ready chunks
- Demand-Time Oracle as upper bound
`;
  await fs.writeFile(path.join(outDir, "CONCLUSION_GUARD.md"), md, "utf8");
}

async function writePaperDraft() {
  const md = `# Paper Text Draft (English)

## Measurement Motivation
Interactive 3DGS streaming can achieve high frame rates while viewport-critical chunks are not yet render-ready. We define **content readiness** as fetch completion plus parse (and optionally GPU upload/visibility). High FPS alone does not imply high QoE when **fast-but-empty** frames occur.

## Design
**READY (Readiness-Aware Delivery)** coordinates viewport prediction, readiness-aware priority, first-visible weighting, deadline urgency, proactive fetch/parse, and budget control on a shared Spark/WebGL/HTTP Range substrate.

| Method | Prediction | Readiness priority | First-visible | Deadline | Budget |
|--------|------------|-------------------|---------------|----------|--------|
| Spark-OD | — | — | — | — | — |
| Naive-PF | — | — | — | — | partial |
| PRoGS | — | — | ✓ (static) | — | — |
| SGSS | — | view | — | partial | — |
| READY-P | ✓ | — | — | — | — |
| READY | ✓ | ✓ | ✓ | ✓ | ✓ |

## Evaluation
- **RQ1**: Readiness mismatch is measurable via deadline miss and useful-before-demand.
- **RQ2**: READY vs Spark-OD and SOTA-style baselines (Phase B).
- **RQ3**: Ablations isolate prediction, view-only, initial priority, deadline, budget (Phase C).
- **RQ4**: WAN-shaped stress (Phase D).
- **RQ5**: Trace robustness (Phase E).

*Single-user cold-start only. Multi-user coordination is out of scope.*
`;
  await fs.writeFile(path.join(outDir, "PAPER_TEXT_DRAFT.md"), md, "utf8");
}

async function genFigures() {
  const py = path.join(root, "scripts", "ready_single_user", "gen_figures.py");
  try {
    await fs.access(py);
    spawnSync("python", [py, outDir], { cwd: root, stdio: "inherit" });
  } catch {
    console.warn("[analyze] gen_figures.py not run (optional)");
  }
}

async function main() {
  const { batchDir, phase } = parseArgs(process.argv.slice(2));
  if (!batchDir) throw new Error("--batchDir required");
  await fs.mkdir(outDir, { recursive: true });

  const trials = await loadTrials(batchDir);
  let claim = null;

  if (phase === "all" || phase === "phaseA") {
    const aTrials = trials.filter((t) => t.phase === "phaseA_sanity");
    if (aTrials.length) {
      const gate = evaluatePhaseASanity(aTrials);
      await fs.writeFile(
        path.join(outDir, "phaseA_sanity.json"),
        `${JSON.stringify(gate, null, 2)}\n`,
        "utf8",
      );
    }
  }
  if (phase === "all" || phase === "phaseB_mini") await writePhaseBMini(trials);
  if (phase === "all" || phase === "phase_local_ceiling") {
    await writePhaseLocalCeilingSanity(trials);
  }
  const readyGatePhases = [
    "phase_edge_cold",
    "phase_edge_warm_ready",
    "phase_ready_ablation_on_edge",
  ];
  if (readyGatePhases.includes(phase) || phase === "all") {
    for (const p of readyGatePhases) {
      if (phase === "all" || phase === p) {
        await writeMiniPhaseMetrics(trials, p);
        await writePhaseReadyGreenGate(trials, p);
      }
    }
  }
  const remotePhases = [
    "phase_remote_direct",
    "phase_remote_direct_cold",
    "phase_remote_warm_equal",
    "phase_remote_dev",
    "phase_remote_validation",
    "phase_remote_test_main",
  ];
  if (remotePhases.includes(phase) || phase === "all") {
    const seen = new Set();
    for (const t of trials.filter((x) => isRemotePhase(x.phase))) {
      if (seen.has(t.phase)) continue;
      seen.add(t.phase);
      if (phase === "all" || phase === t.phase) {
        await writePhaseRemoteDirectGatesReport(trials, t.phase);
      }
    }
  }
  if (phase === "all" || phase === "phase_delivery_compare") {
    await writePhaseDeliveryCompareSanity(trials);
  }
  if (phase === "all" || phase === "phaseB" || phase === "phaseB_main") claim = await writePhaseB(trials);
  if (phase === "all" || phase === "phaseC") await writePhaseC(trials);
  if (phase === "all" || phase === "phaseD") await writePhaseD(trials);
  if (phase === "all" || phase === "phaseE") await writePhaseE(trials);

  const deliveryPhases = [
    "phase_delivery_compare",
    "phase_local_ceiling",
    "phase_edge_cold",
    "phase_edge_warm_ready",
    "phase_ready_ablation_on_edge",
    "phase_remote_direct",
    "phase_remote_direct_cold",
    "phase_remote_warm_equal",
    "all",
  ];
  if (deliveryPhases.includes(phase)) {
    const filtered = phase === "all" ? trials : trials.filter((t) => t.phase === phase);
    await writeDeliveryAnalysis(outDir, filtered.length ? filtered : trials);
  }

  await writeOracleInputAudit({ trials, batchDir });

  if (phase === "all") {
    await writeFinalReport(trials, claim);
    await writeClaimEvidence(trials);
    await writeConclusionGuard(claim);
    await writePaperDraft();
    await genFigures();
  }
  console.log(`[analyze] Artifacts in ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
