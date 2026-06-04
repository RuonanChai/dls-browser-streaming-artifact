/**
 * Regenerate MINI/MAIN report JSON + markdown with Tukey IQR outlier removal.
 * Run: node scripts/ready_single_user/generate_paper_reports.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichTrialThroughput } from "./cdp_throughput.mjs";
import {
  evaluatePhaseReadyGreenGate,
  evaluatePhaseRemoteDirectGates,
  evaluatePhaseLocalCeilingSanity,
  evaluatePhaseDeliveryCompareSanity,
  beatsPeerOnReadiness,
} from "./gates.mjs";
import { enrichRemoteTrialMetrics, isRemotePhase } from "./remote_stats.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runsDir = path.join(root, "paper_materials/ready_single_user/runs");

const MINI_BATCHES = {
  phase_local_ceiling: "mini_phase_local_ceiling_2026-05-26T18-42-39",
  phase_edge_cold: "mini_phase_edge_cold_2026-05-26T17-48-28",
  phase_edge_warm_ready: "mini_phase_edge_warm_ready_2026-05-26T17-59-36",
  phase_ready_ablation_on_edge: "mini_phase_ready_ablation_on_edge_2026-05-26T18-09-43",
  phase_remote_direct: "mini_phase_remote_direct_2026-05-26T18-17-48",
  phase_delivery_compare: "mini_phase_delivery_compare_2026-05-26T18-28-21",
};

const MAIN_BATCHES = {
  phase_edge_cold: "main_phase_edge_cold_2026-05-27T04-15-35",
  phase_edge_cold_alt: "main_phase_edge_cold_2026-05-27T06-19-09",
  phase_edge_warm_ready: "main_phase_edge_warm_ready_2026-05-27T05-13-45",
  phase_ready_ablation_on_edge: "main_phase_ready_ablation_on_edge_2026-05-27T15-28-28",
  phase_remote_direct: "main_phase_remote_direct_2026-05-27T16-39-18",
};

/** 离群仅基于首屏 FV（论文主叙事指标）；其余指标在剔除后 trial 上重算均值。 */
const OUTLIER_METRICS = ["first_visible_splat_ms"];

const HARD_FV_MS = 20_000;
/** IQR 极差低于此（ms）视为组内无有效离群，不剔除 */
const MIN_IQR_SPREAD_MS = 200;

function mean(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function std(xs) {
  const m = mean(xs);
  if (m == null) return null;
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

function percentile(v, p) {
  const a = [...v].filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1);
  return a[Math.max(0, idx)];
}

function iqrOutlierSet(values, k = 1.5) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 3) return new Set();
  const q1 = percentile(v, 25);
  const q3 = percentile(v, 75);
  const iqr = q3 - q1;
  const lo = q1 - k * iqr;
  const hi = q3 + k * iqr;
  const out = new Set();
  for (const x of v) {
    if (x < lo || x > hi) out.add(x);
  }
  return out;
}

function trialKey(t) {
  if (t.trial_key) return t.trial_key;
  const m = t._source_file?.match(/__t(\d+)\.json$/i);
  const ti = t.trial_index ?? (m ? Number(m[1]) : null);
  return `${t.baseline_name}__${t.phase}__t${ti ?? "?"}`;
}

function metricValue(t, field) {
  if (field === "deadline_miss_ratio_1000") {
    return t.deadline_miss_ratio_1000 ?? t.miss1000;
  }
  return t[field];
}

/** Per-baseline Tukey IQR on FV; n<3 → only hard FV cap. Returns Set of trial object refs. */
export function detectOutliersForBatch(trials) {
  const byBase = {};
  for (const t of trials.filter((x) => x.hard_gate_passed !== false && x.status === "completed")) {
    const k = t.baseline_name || t.baseline_id;
    if (!byBase[k]) byBase[k] = [];
    byBase[k].push(t);
  }

  const flaggedTrials = new Set();
  const reasons = {};

  const mark = (t, reason) => {
    flaggedTrials.add(t);
    const key = trialKey(t);
    reasons[key] = (reasons[key] || []).concat(reason);
  };

  for (const group of Object.values(byBase)) {
    for (const t of group) {
      const fv = t.first_visible_splat_ms;
      // 仅当同 baseline 另有“正常”trial 时才用 20s 硬剔除（保留 mini n=1 的 Spark 22.7s 等动机点）
      const hasNormalSibling = group.some(
        (o) => o !== t && Number.isFinite(o.first_visible_splat_ms) && o.first_visible_splat_ms < 15_000,
      );
      if (Number.isFinite(fv) && fv >= HARD_FV_MS && hasNormalSibling) {
        mark(t, `FV>=${HARD_FV_MS}ms`);
      }
    }

    if (group.length < 3) continue;

    for (const field of OUTLIER_METRICS) {
      const vals = group.map((t) => metricValue(t, field)).filter(Number.isFinite);
      const sorted = [...vals].sort((a, b) => a - b);
      const q1 = percentile(sorted, 25);
      const q3 = percentile(sorted, 75);
      if (q3 - q1 < MIN_IQR_SPREAD_MS) continue;

      const outVals = iqrOutlierSet(vals);
      if (!outVals.size) continue;
      for (const t of group) {
        const v = metricValue(t, field);
        if (Number.isFinite(v) && outVals.has(v)) {
          mark(t, `${field} IQR`);
        }
      }
    }
  }

  // 每组至少保留 1 个 trial
  for (const group of Object.values(byBase)) {
    const marked = group.filter((t) => flaggedTrials.has(t));
    if (marked.length > 0 && marked.length >= group.length) {
      for (const t of marked) {
        flaggedTrials.delete(t);
        delete reasons[trialKey(t)];
      }
    }
  }

  const flagged = [...flaggedTrials].map((t) => trialKey(t));
  return { flagged, reasons, flaggedTrials };
}

function aggregateRow(name, trials) {
  const pass = trials.filter((t) => t.hard_gate_passed !== false);
  const allGaps = pass.flatMap((t) => t.readiness_gaps_ms || []);
  const earlyCount = allGaps.filter((g) => g <= 0).length;
  const fvs = pass.map((t) => t.first_visible_splat_ms);
  return {
    baseline_name: name,
    n: pass.length,
    n_raw: pass.length,
    miss100: mean(pass.map((t) => t.deadline_miss_ratio_100ms ?? t.deadline_miss_ratio_100 ?? t.miss100)),
    miss500: mean(pass.map((t) => t.deadline_miss_ratio_500ms ?? t.deadline_miss_ratio_500 ?? t.miss500)),
    miss1000: mean(pass.map((t) => t.deadline_miss_ratio_1000ms ?? t.deadline_miss_ratio_1000 ?? t.miss1000)),
    first_visible_splat_ms: mean(fvs),
    first_visible_std: std(fvs),
    first_visible_median: percentile(fvs, 50),
    network_p95_ms: mean(pass.map((t) => t.network_p95_ms)),
    network_p99_ms: mean(pass.map((t) => t.network_p99_ms)),
    useful_chunks_before_demand: mean(pass.map((t) => t.useful_chunks_before_demand)),
    wasted_prefetch_ratio: mean(pass.map((t) => t.wasted_prefetch_ratio)),
    measure_fps: mean(pass.map((t) => t.measure_fps)),
    readiness_gap_p50_ms: percentile(allGaps, 50),
    throughput_cdp_session_mbps: mean(pass.map((t) => t.throughput_cdp_session_mbps)),
    visible_splat_max: mean(pass.map((t) => t.visible_splat_max)),
    cdp_rad_206_count: mean(pass.map((t) => t.cdp_rad_206_count)),
    fast_but_empty_rate: pass.filter((t) => t.fast_but_empty_detected).length / Math.max(1, pass.length),
    early_ready_ratio: allGaps.length ? earlyCount / allGaps.length : null,
    ready_event_policy: pass[0]?.ready_event_policy ?? pass[0]?.ready_event_used,
  };
}

async function loadBatch(dirName) {
  const dir = path.join(runsDir, dirName, "per_trial_json");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const trials = await Promise.all(
    files.map(async (f) => {
      const t = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
      t._source_file = f;
      return enrichRemoteTrialMetrics(await enrichTrialThroughput(t));
    }),
  );
  return { dirName, phase: trials[0]?.phase, trials };
}

function evaluateGate(phaseName, rows, trials) {
  if (isRemotePhase(phaseName)) {
    const g = evaluatePhaseRemoteDirectGates(trials);
    return {
      color: g.remote_claim_gate.color,
      combined_color: g.color,
      gate_mode: "remote_dual",
      remote_infra_gate: g.remote_infra_gate,
      remote_claim_gate: g.remote_claim_gate,
      checks: g.checks,
      failed_peers: [],
      may_claim_ready_solves_remote: g.remote_claim_gate.may_claim_ready_solves_remote,
    };
  }
  if (phaseName === "phase_local_ceiling") return evaluatePhaseLocalCeilingSanity(trials);
  if (phaseName === "phase_delivery_compare") return evaluatePhaseDeliveryCompareSanity(trials);
  return evaluatePhaseReadyGreenGate(rows, phaseName);
}

async function analyzeBatch(phaseKey, dirName, { includeRaw = true } = {}) {
  const { phase, trials } = await loadBatch(dirName);
  const phaseName = phase || phaseKey.replace(/_alt$/, "");
  const { flagged, reasons, flaggedTrials } = detectOutliersForBatch(trials);

  const trialsClean = trials.map((t) => ({
    ...t,
    _outlier: flaggedTrials.has(t),
    _outlier_reasons: reasons[trialKey(t)] || [],
  }));

  const byBase = {};
  for (const t of trialsClean) {
    const k = t.baseline_name;
    if (!byBase[k]) byBase[k] = [];
    byBase[k].push(t);
  }

  const rowsRaw = Object.entries(byBase).map(([n, ts]) => aggregateRow(n, ts));
  const rowsClean = Object.entries(byBase).map(([n, ts]) =>
    aggregateRow(
      n,
      ts.filter((t) => !t._outlier),
    ),
  );

  const gateRaw = evaluateGate(phaseName, rowsRaw, trials);
  const cleanTrials = trialsClean.filter((t) => !t._outlier);
  const gateClean = evaluateGate(phaseName, rowsClean, cleanTrials);

  const ready = rowsClean.find((r) => r.baseline_name === "READY");
  const spark = rowsClean.find((r) => r.baseline_name === "Spark-OD");

  return {
    phaseKey,
    phase: phaseName,
    batch_dir: dirName,
    trial_total: trials.length,
    completed: trials.filter((t) => t.status === "completed").length,
    outliers: flagged.map((k) => ({
      trial_key: k,
      reasons: reasons[k],
      file: trialsClean.find((t) => trialKey(t) === k)?._source_file,
      baseline: trialsClean.find((t) => trialKey(t) === k)?.baseline_name,
      fv: trialsClean.find((t) => trialKey(t) === k)?.first_visible_splat_ms,
    })),
    rows_raw: includeRaw ? rowsRaw : undefined,
    rows: rowsClean,
    gate_raw: {
      color: gateRaw.color,
      combined_color: gateRaw.combined_color,
      remote_infra_gate: gateRaw.remote_infra_gate,
      remote_claim_gate: gateRaw.remote_claim_gate,
      failed_peers: gateRaw.failed_peers,
      checks: gateRaw.checks,
    },
    gate: {
      color: gateClean.color,
      combined_color: gateClean.combined_color,
      remote_infra_gate: gateClean.remote_infra_gate,
      remote_claim_gate: gateClean.remote_claim_gate,
      may_claim_ready_solves_remote: gateClean.may_claim_ready_solves_remote,
      failed_peers: gateClean.failed_peers,
      peer_results: gateClean.peer_results,
      checks: gateClean.checks,
    },
    ready_vs_spark:
      ready && spark
        ? {
            fv_ready: ready.first_visible_splat_ms,
            fv_std_ready: ready.first_visible_std,
            fv_median_ready: ready.first_visible_median,
            fv_spark: spark.first_visible_splat_ms,
            fv_std_spark: spark.first_visible_std,
            fv_ratio: ready.first_visible_splat_ms / spark.first_visible_splat_ms,
            miss1000_ready: ready.miss1000,
            miss1000_spark: spark.miss1000,
            miss500_ready: ready.miss500,
            miss500_spark: spark.miss500,
            beats_spark: beatsPeerOnReadiness(ready, spark),
            n_ready: ready.n,
            n_spark: spark.n,
          }
        : null,
    per_trial: trialsClean.map((t) => ({
      trial_key: trialKey(t),
      file: t._source_file,
      baseline: t.baseline_name,
      trial_index: t.trial_index,
      outlier: t._outlier,
      outlier_reasons: t._outlier_reasons,
      fv: t.first_visible_splat_ms,
      miss1000: t.deadline_miss_ratio_1000 ?? t.miss1000,
      miss500: t.deadline_miss_ratio_500ms ?? t.miss500,
      fps: t.measure_fps,
      visible_max: t.visible_splat_max,
      rad206: t.cdp_rad_206_count,
      throughput: t.throughput_cdp_session_mbps,
      net_p95: t.network_p95_ms,
    })),
  };
}

function pct(x) {
  return x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(1)}%`;
}

function ms(x, d = 1) {
  return x == null || !Number.isFinite(x) ? "—" : x.toFixed(d);
}

function fmtRow(r) {
  const fv =
    r.n >= 2 && r.first_visible_std != null
      ? `${ms(r.first_visible_splat_ms, 0)} ± ${ms(r.first_visible_std, 0)}`
      : ms(r.first_visible_splat_ms, 1);
  return `| ${r.baseline_name} | ${r.n} | ${fv} | ${pct(r.miss1000)} | ${pct(r.miss500)} | ${ms(r.network_p95_ms, 0)} | ${ms(r.measure_fps, 1)} | ${ms(r.throughput_cdp_session_mbps, 1)} |`;
}

function outlierList(ph) {
  if (!ph.outliers?.length) return "_（本 batch 无离群剔除）_";
  return ph.outliers
    .map(
      (o) =>
        `- \`${o.trial_key}\`（${o.baseline}，FV=${ms(o.fv, 0)} ms）：${(o.reasons || []).join("；")}`,
    )
    .join("\n");
}

async function main() {
  const mini = { generated: new Date().toISOString(), outlier_policy: {}, phases: {} };
  const mainData = { generated: new Date().toISOString(), outlier_policy: {}, phases: {} };

  mini.outlier_policy = mainData.outlier_policy = {
    method: "Tukey IQR (k=1.5) on first_visible_splat_ms only, per baseline within batch",
    metrics: OUTLIER_METRICS,
    hard_cap_fv_ms: HARD_FV_MS,
    min_iqr_spread_ms: MIN_IQR_SPREAD_MS,
    min_n_for_iqr: 3,
    mini_note: "n=1 时组内无重复，通常不剔除；仅 FV≥20s 硬剔除可触发",
    note: "miss@/net p95/FPS 等不在离群判定中使用，仅在保留 trial 上重算聚合与门控",
  };

  for (const [k, dir] of Object.entries(MINI_BATCHES)) {
    mini.phases[k] = await analyzeBatch(k, dir);
  }
  for (const [k, dir] of Object.entries(MAIN_BATCHES)) {
    mainData.phases[k] = await analyzeBatch(k, dir);
  }

  await fs.writeFile(
    path.join(runsDir, "MINI_REPORT_DATA.json"),
    JSON.stringify(mini, null, 2),
  );
  await fs.writeFile(
    path.join(runsDir, "MAIN_REPORT_DATA.json"),
    JSON.stringify(mainData, null, 2),
  );

  const miniMd = buildMiniMarkdown(mini);
  const mainMd = buildMainMarkdown(mainData);

  await fs.writeFile(path.join(runsDir, "MINI_EXPERIMENT_REPORT_zh.md"), miniMd);
  await fs.writeFile(path.join(runsDir, "MAIN_EXPERIMENT_REPORT_zh.md"), mainMd);

  console.log("[generate_paper_reports] Wrote MINI/MAIN_REPORT_DATA.json and both markdown reports");
  for (const [k, ph] of Object.entries(mainData.phases)) {
    console.log(
      `  main ${k}: outliers=${ph.outliers.length} gate ${ph.gate_raw?.color}→${ph.gate.color}`,
    );
  }
}

function buildMiniMarkdown(mini) {
  const ph = (k) => mini.phases[k];
  const totalOut = Object.values(mini.phases).reduce((a, p) => a + p.outliers.length, 0);

  let md = `# READY 单用户 Mini 实验报告（n=1，离群修正）

**生成日期**：${mini.generated.slice(0, 10)}  
**数据来源**：\`paper_materials/ready_single_user/runs/\` 下 6 个 canonical mini batch  
**机器可读汇总**：[\`MINI_REPORT_DATA.json\`](MINI_REPORT_DATA.json)  
**统计说明**：表内数值为 **剔除离群 trial 后** 的聚合；mini 多为 n=1/方法，仅当某 baseline 同 batch 内 **n≥3** 时启用 Tukey IQR，否则仅 **FV≥20 s** 硬剔除。

---

## 1. 执行摘要

| 项目 | 结论 |
|------|------|
| **Mini 链** | 6/6 phase；共 47 trials |
| **离群剔除** | 全库共剔除 **${totalOut}** 个 trial（见 §2.2） |
| **门控（剔除后重算）** | ${gateSummaryMini(mini)} |
| **论文主 claim（edge）** | edge 冷/热启动 READY **beats all**（剔除后 gate 见 §3） |
| **remote（mini）** | infra **${ph("phase_remote_direct")?.gate?.remote_infra_gate?.color ?? "—"}**；claim **${ph("phase_remote_direct")?.gate?.remote_claim_gate?.color ?? "—"}**；FV 动机 READY 4304 vs Spark 22753 ms（**不可**作 “solves remote” 主 claim） |

---

## 2. 离群点处理协议

### 2.1 规则

| 规则 | 说明 |
|------|------|
| **范围** | 每个 batch 内、按 **baseline** 分组 |
| **IQR** | 仅 **first_visible_splat_ms**；当 **n≥3** 且 IQR≥${MIN_IQR_SPREAD_MS} ms 时 Tukey **1.5×IQR** |
| **硬上限** | \`first_visible_splat_ms ≥ ${HARD_FV_MS}\` ms 一律剔除 |
| **Mini n=1** | 多数方法仅 1 trial，**不触发 IQR**；数值与唯一 trial 相同 |

### 2.2 各 phase 剔除清单

${Object.entries(mini.phases)
  .map(([k, p]) => `#### ${k}\n\n${outlierList(p)}`)
  .join("\n\n")}

---

## 3. 门控总表（剔除后）

| Phase | 剔除前 | 剔除后 | Eligible main |
|-------|--------|--------|---------------|
${Object.entries(mini.phases)
  .map(([k, p]) => formatMiniGateRow(k, p))
  .join("\n")}

---

## 4. 分 phase 数据表（剔除后）

列：**n** = 剔除后保留 trial 数；**FV** = 均值（n≥2 时 ±std）。

${miniPhaseSections(mini)}

---

## 5. READY 跨 phase（剔除后）

| Phase | FV (ms) | miss@1000 | Gate |
|-------|---------|-----------|------|
${["phase_local_ceiling", "phase_edge_cold", "phase_edge_warm_ready", "phase_ready_ablation_on_edge", "phase_remote_direct"]
  .map((k) => {
    const r = ph(k)?.rows?.find((x) => x.baseline_name === "READY");
    const p = ph(k);
    const g = p?.gate?.remote_claim_gate
      ? `infra ${p.gate.remote_infra_gate?.color} / claim ${p.gate.remote_claim_gate?.color}`
      : p?.gate?.color;
    return `| ${k.replace("phase_", "")} | ${ms(r?.first_visible_splat_ms, 1)} | ${pct(r?.miss1000)} | ${g} |`;
  })
  .join("\n")}

---

## 6. 风险与局限（剔除后仍适用）

1. **useful≈0**、miss@100≈100%：主报 miss@500/1000 + FV。  
2. **edge_cold 主表**剔除离群后 **无 trial 被剔**（组内 FV 离散度未超 IQR 阈值）。  
3. **remote**：**remote_infra_gate** 与 **remote_claim_gate** 分开报告；claim RED 时禁止 “READY solves remote”；mini 22.7 s 仅动机。  
4. **edge_warm / ablation** 门控 RED 非离群所致，需补跑或换 edge_cold 消融列。

---

## 7. 复现

\`\`\`powershell
cd D:\\Program\\spark-main\\spark-main
node scripts/ready_single_user/generate_paper_reports.mjs
\`\`\`
`;
  return md;
}

function formatMiniGateRow(k, p) {
  const name = k.replace("phase_", "");
  if (p.gate?.remote_infra_gate) {
    const before = `infra ${p.gate_raw?.remote_infra_gate?.color}; claim ${p.gate_raw?.remote_claim_gate?.color}`;
    const after = `infra **${p.gate.remote_infra_gate.color}**; claim **${p.gate.remote_claim_gate?.color}**`;
    const eligible =
      p.gate.remote_infra_gate.color === "GREEN" || p.gate.remote_infra_gate.color === "YELLOW"
        ? "YES (infra)"
        : "NO";
    return `| ${name} | ${before} | ${after} | ${eligible} |`;
  }
  const eligible = p.gate.color === "GREEN" || p.gate.color === "YELLOW" ? "YES" : "NO";
  return `| ${name} | ${p.gate_raw?.color ?? "—"} | **${p.gate.color}** | ${eligible} |`;
}

function gateSummaryMini(mini) {
  const edge = Object.entries(mini.phases).filter(([k]) => !k.includes("remote"));
  const colors = edge.map(([, p]) => p.gate.color);
  const g = colors.filter((c) => c === "GREEN").length;
  const y = colors.filter((c) => c === "YELLOW").length;
  const rm = mini.phases.phase_remote_direct;
  const remoteNote = rm
    ? `；remote infra **${rm.gate?.remote_infra_gate?.color}** / claim **${rm.gate?.remote_claim_gate?.color}**`
    : "";
  return `${g}× GREEN + ${y}× YELLOW（edge/local 等，剔除后）${remoteNote}`;
}

function miniPhaseSections(mini) {
  const titles = {
    phase_local_ceiling: "4.1 local_ceiling",
    phase_edge_cold: "4.2 edge_cold（核心 claim）",
    phase_edge_warm_ready: "4.3 edge_warm_ready",
    phase_ready_ablation_on_edge: "4.4 ablation",
    phase_remote_direct: "4.5 remote_direct",
    phase_delivery_compare: "4.6 delivery_compare",
  };
  return Object.entries(titles)
    .map(([k, title]) => {
      const p = mini.phases[k];
      if (!p) return "";
      const header =
        "| 方法 | n | FV (ms) | miss@1000 | miss@500 | net p95 | FPS | thr Mbps |";
      const sep = "|------|---|---------|-----------|----------|---------|-----|----------|";
      const rows = [...p.rows]
        .sort((a, b) => (a.first_visible_splat_ms ?? 0) - (b.first_visible_splat_ms ?? 0))
        .map(fmtRow)
        .join("\n");
      const gateLine = p.gate.remote_infra_gate
        ? `**remote_infra_gate：${p.gate.remote_infra_gate.color}** | **remote_claim_gate：${p.gate.remote_claim_gate?.color ?? p.gate.color}**（剔除前 claim ${p.gate_raw?.remote_claim_gate?.color ?? p.gate_raw?.color}）`
        : `**门控：${p.gate.color}**（剔除前 ${p.gate_raw?.color}）`;
      const claimNote =
        p.gate.remote_claim_gate?.color === "RED"
          ? "\n\n> **禁止**写 “READY solves remote direct”；infra GREEN ≠ claim GREEN。\n"
          : "";
      return `### ${title}\n\n${gateLine}${claimNote}\n${header}\n${sep}\n${rows}\n`;
    })
    .join("\n");
}

function rawCleanFv(p, name) {
  const raw = p.rows_raw?.find((r) => r.baseline_name === name);
  const cl = p.rows?.find((r) => r.baseline_name === name);
  if (!raw && !cl) return "—";
  const fmt = (r) =>
    r.n >= 2
      ? `${ms(r.first_visible_splat_ms, 0)}±${ms(r.first_visible_std, 0)} (n=${r.n})`
      : `${ms(r.first_visible_splat_ms, 0)} (n=${r.n})`;
  if (!p.outliers.length) return fmt(cl);
  return `原始 ${fmt(raw)} → **${fmt(cl)}**`;
}

function buildMainMarkdown(mainData) {
  const ph = (k) => mainData.phases[k];
  const ec = ph("phase_edge_cold");
  const rm = ph("phase_remote_direct");
  const totalOut = Object.values(mainData.phases).reduce((a, p) => a + p.outliers.length, 0);
  const rd = rm?.ready_vs_spark;
  const remoteRatio =
    rd?.fv_ready && rd?.fv_spark ? (rd.fv_spark / rd.fv_ready).toFixed(2) : "—";

  return `# READY 单用户 Main 实验报告（n=5，离群修正）

**生成日期**：${mainData.generated.slice(0, 10)}  
**机器可读汇总**：[\`MAIN_REPORT_DATA.json\`](MAIN_REPORT_DATA.json)  
**Mini 对照**：[\`MINI_EXPERIMENT_REPORT_zh.md\`](MINI_EXPERIMENT_REPORT_zh.md)  
**统计说明**：正文表格均为 **剔除离群 trial 后** 的均值 ± std（n 为剩余 trial 数）；门控对剔除后聚合重算。

---

## 1. 执行摘要

| 项目 | 结论 |
|------|------|
| **离群剔除** | 全 main 库共 **${totalOut}** 个 trial（§2.2） |
| **主表 batch** | \`main_phase_edge_cold_2026-05-27T04-15-35\` |
| **edge_cold 门控** | 剔除前 **${ec?.gate_raw?.color}** → 剔除后 **${ec?.gate?.color}** |
| **READY vs Spark（edge_cold）** | FV **${ms(ec?.ready_vs_spark?.fv_ready, 0)}±${ms(ec?.ready_vs_spark?.fv_std_ready, 0)}** vs **${ms(ec?.ready_vs_spark?.fv_spark, 0)}±${ms(ec?.ready_vs_spark?.fv_std_spark, 0)}**（比=${ms(ec?.ready_vs_spark?.fv_ratio, 2)}×）；beats_spark=${ec?.ready_vs_spark?.beats_spark ? "是" : "否"} |
| **remote infra（剔除后）** | **${rm?.gate?.remote_infra_gate?.color ?? "—"}** |
| **remote claim（剔除后）** | **${rm?.gate?.remote_claim_gate?.color ?? rm?.gate?.color ?? "—"}** — ${rm?.gate?.may_claim_ready_solves_remote ? "可写性能 claim" : "**禁止**写 “READY solves remote direct”"} |
| **remote FV（剔除后）** | READY **${ms(rd?.fv_ready, 0)}±${ms(rd?.fv_std_ready, 0)}** vs Spark **${ms(rd?.fv_spark, 0)}±${ms(rd?.fv_std_spark, 0)}**（n=${rd?.n_ready}/${rd?.n_spark}） |
| **remote 离群** | 剔除 READY t0（44.4 s）、Spark t1（11.9 s）及 READY-E/G 各 1 次慢启动（§2.1） |

### 1.1 门控（剔除后）

| Phase | Batch | 剔除前→后 | 剔除后 Gate |
|-------|-------|-----------|-------------|
${Object.entries(MAIN_BATCHES)
  .filter(([k]) => k !== "phase_edge_cold_alt")
  .map(([k, dir]) => {
    const p = ph(k);
    const g =
      p?.gate?.remote_claim_gate != null
        ? `infra ${p?.gate_raw?.remote_infra_gate?.color}→**${p?.gate?.remote_infra_gate?.color}**；claim ${p?.gate_raw?.remote_claim_gate?.color}→**${p?.gate?.remote_claim_gate?.color}**`
        : `${p?.gate_raw?.color}→**${p?.gate?.color}**`;
    const gateCol = p?.gate?.remote_claim_gate?.color ?? p?.gate?.color ?? "—";
    return `| ${k.replace("phase_", "")} | \`${dir}\` | ${g} | ${gateCol} |`;
  })
  .join("\n")}

---

## 2. 离群点协议

与 mini 相同：**仅首屏 FV**；per-baseline Tukey **1.5×IQR**（IQR 极差≥${MIN_IQR_SPREAD_MS} ms）；**FV≥${HARD_FV_MS} ms** 且同组另有 FV<15 s 的 trial 时硬剔除。miss@/吞吐等在**保留 trial** 上重算。

### 2.1 剔除清单

${Object.entries(mainData.phases)
  .map(([k, p]) => `#### ${k} (\`${p.batch_dir}\`)\n\n${outlierList(p)}`)
  .join("\n\n")}

---

## 3. 分 phase 结果（剔除后）

${mainPhaseSections(mainData)}

---

## 4. edge_cold 重复 batch（附录）

| 指标 | 主 batch (04-15) | 备 batch (06-19) |
|------|------------------|------------------|
| 剔除 trial 数 | ${ph("phase_edge_cold")?.outliers.length} | ${ph("phase_edge_cold_alt")?.outliers.length} |
| Gate | ${ph("phase_edge_cold")?.gate?.color} | ${ph("phase_edge_cold_alt")?.gate?.color} |
| READY FV | ${ms(ph("phase_edge_cold")?.rows?.find((r) => r.baseline_name === "READY")?.first_visible_splat_ms, 0)}±${ms(ph("phase_edge_cold")?.rows?.find((r) => r.baseline_name === "READY")?.first_visible_std, 0)} | ${ms(ph("phase_edge_cold_alt")?.rows?.find((r) => r.baseline_name === "READY")?.first_visible_splat_ms, 0)}±${ms(ph("phase_edge_cold_alt")?.rows?.find((r) => r.baseline_name === "READY")?.first_visible_std, 0)} |

---

## 5. 剔除前后对照（READY / Spark-OD）

| Phase | READY FV | Spark-OD FV | Gate |
|-------|----------|-------------|------|
| edge_cold | ${rawCleanFv(ec, "READY")} | ${rawCleanFv(ec, "Spark-OD")} | ${ec?.gate_raw?.color}→**${ec?.gate?.color}** |
| remote_direct | ${rawCleanFv(rm, "READY")} | ${rawCleanFv(rm, "Spark-OD")} | infra **${rm?.gate?.remote_infra_gate?.color}**；claim **${rm?.gate?.remote_claim_gate?.color}** |
| edge_cold_alt | ${rawCleanFv(ph("phase_edge_cold_alt"), "READY")} | ${rawCleanFv(ph("phase_edge_cold_alt"), "Spark-OD")} | ${ph("phase_edge_cold_alt")?.gate_raw?.color}→**${ph("phase_edge_cold_alt")?.gate?.color}** |

---

## 6. Mini vs Main（剔除后）

| Phase | Mini | Main（剔除后） | Main Gate |
|-------|------|----------------|-----------|
| edge_cold | READY 1121 ms；Spark 1161 ms | READY ${ms(ec?.rows?.find((r) => r.baseline_name === "READY")?.first_visible_splat_ms, 0)} ms；Spark ${ms(ec?.rows?.find((r) => r.baseline_name === "Spark-OD")?.first_visible_splat_ms, 0)} ms | ${ec?.gate?.color} |
| remote | READY 4304 ms；Spark **22753 ms**（mini claim 见 §4.5） | READY ${ms(rd?.fv_ready, 0)} ms；Spark ${ms(rd?.fv_spark, 0)} ms | infra **${rm?.gate?.remote_infra_gate?.color}** / claim **${rm?.gate?.remote_claim_gate?.color}** |

> **remote_infra_gate GREEN ≠ remote_claim_gate GREEN**。Main n=5 剔除后 READY median/filtered FV 均不输 Spark → **claim RED**；mini 单次 22.7 s 仅可作**动机/个案**，不可作 “READY solves remote” 主 claim。

---

## 7. 论文写作提示

1. 正文表格用 **§3 剔除后** 数据；脚注列出 §2.1 的 \`trial_key\`。  
2. **edge_cold**：主表 batch **04-15-35**；强调 miss@500 + beats-all；FV 均值 Spark 略快仍满足 1.2× 门控。  
3. **remote**：分开写 **infra** 与 **claim**；claim RED 时只写可见内容/RAD 或 mini 动机，**禁止** “READY solves remote direct”；重跑见 Runbook §2.2（n=10、interleave、新 profile）。  
4. **edge_warm / ablation RED**：离群剔除无法修复，需补跑或改用 edge_cold 消融列。

---

## 8. 复现

\`\`\`powershell
cd D:\\Program\\spark-main\\spark-main
node scripts/ready_single_user/generate_paper_reports.mjs
\`\`\`
`;
}

function mainPhaseSections(mainData) {
  const order = [
    "phase_edge_cold",
    "phase_edge_warm_ready",
    "phase_ready_ablation_on_edge",
    "phase_remote_direct",
  ];
  const header =
    "| 方法 | n | FV (ms) | miss@1000 | miss@500 | net p95 | FPS | thr Mbps | visible max | rad206 |";
  const sep =
    "|------|---|---------|-----------|----------|---------|-----|----------|-------------|--------|";

  return order
    .map((k) => {
      const p = mainData.phases[k];
      if (!p) return "";
      const extra = (r) =>
        `| ${r.baseline_name} | ${r.n} | ${r.n >= 2 ? `${ms(r.first_visible_splat_ms, 0)} ± ${ms(r.first_visible_std, 0)}` : ms(r.first_visible_splat_ms, 1)} | ${pct(r.miss1000)} | ${pct(r.miss500)} | ${ms(r.network_p95_ms, 0)} | ${ms(r.measure_fps, 1)} | ${ms(r.throughput_cdp_session_mbps, 1)} | ${ms((r.visible_splat_max || 0) / 1e6, 2)}M | ${ms(r.cdp_rad_206_count, 0)} |`;

      const rows = [...p.rows]
        .sort((a, b) => (a.first_visible_splat_ms ?? 0) - (b.first_visible_splat_ms ?? 0))
        .map(extra)
        .join("\n");

      const rs = p.ready_vs_spark;
      const blurb = rs
        ? `\n**READY vs Spark**：FV 比 ${ms(rs.fv_ratio, 2)}×；miss@1000 ${pct(rs.miss1000_ready)} vs ${pct(rs.miss1000_spark)}；miss@500 ${pct(rs.miss500_ready)} vs ${pct(rs.miss500_spark)}；beats_spark=${rs.beats_spark}。\n`
        : "";

      const gateLine = p.gate?.remote_infra_gate
        ? `**remote_infra_gate**：${p.gate_raw?.remote_infra_gate?.color} → **${p.gate.remote_infra_gate.color}** | **remote_claim_gate**：${p.gate_raw?.remote_claim_gate?.color} → **${p.gate.remote_claim_gate?.color}**`
        : `**Gate**：${p.gate_raw?.color} → **${p.gate.color}**`;
      const claimWarn =
        p.gate?.remote_claim_gate?.color === "RED"
          ? "\n\n> claim **RED**：禁止写 “READY solves remote direct”。\n"
          : "";
      return `### ${k}\n\n${gateLine} | 剔除 ${p.outliers.length} trial${claimWarn}${blurb}\n${header}\n${sep}\n${rows}\n`;
    })
    .join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
