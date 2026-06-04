/**
 * optimization_report.md generator
 */
import fs from "node:fs/promises";
import path from "node:path";

function fmt(n, d = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(d);
}

function arm(byArm, id) {
  return byArm.find((r) => r.arm_id === id);
}

export function evaluateOptimizationEffectiveness(baseline, optimized) {
  const reasons = [];
  let passed = 0;
  if (!baseline || !optimized) return { verdict: "NOT EFFECTIVE", passed: 0, reasons: ["missing baseline or O5"] };

  const bFps = baseline.measure_fps_mean;
  const oFps = optimized.measure_fps_mean;
  const bP95 = baseline.frame_p95_mean;
  const oP95 = optimized.frame_p95_mean;
  const b33 = baseline.frames_over_33ms_mean ?? 0;
  const o33 = optimized.frames_over_33ms_mean ?? 0;
  const b100 = baseline.frames_over_100ms_mean ?? 0;
  const o100 = optimized.frames_over_100ms_mean ?? 0;

  if (bFps > 0 && oFps >= bFps * 1.25) {
    passed += 1;
    reasons.push(`measure_fps +${fmt(((oFps / bFps) - 1) * 100)}%`);
  }
  if (bP95 > 0 && oP95 <= bP95 * 0.75) {
    passed += 1;
    reasons.push(`frame_p95 -${fmt((1 - oP95 / bP95) * 100)}%`);
  }
  if (b33 > 0 && o33 <= b33 * 0.5) {
    passed += 1;
    reasons.push(`>33ms frames -${fmt((1 - o33 / b33) * 100)}%`);
  } else if (b33 === 0 && o33 === 0) {
    /* no op */
  }
  if (b100 > 0 && o100 <= b100 * 0.2) {
    passed += 1;
    reasons.push(`>100ms frames reduced`);
  }

  const verdict =
    passed >= 2 ? "EFFECTIVE" : passed === 1 ? "PARTIALLY EFFECTIVE" : "NOT EFFECTIVE";
  return { verdict, passed, reasons, bFps, oFps, bP95, oP95, b33, o33 };
}

export function pickBestSingleOpt(byArm) {
  const singles = [
    { id: "O1_E3_adaptive_dpr_only", label: "adaptive DPR" },
    { id: "O2_E3_splat_budget_only", label: "splat budget" },
    { id: "O3_E3_lod_throttle_only", label: "LoD throttle" },
  ];
  const base = arm(byArm, "E3_normal_baseline");
  let best = null;
  for (const s of singles) {
    const r = arm(byArm, s.id);
    if (!r || !base) continue;
    const gain = (r.measure_fps_mean ?? 0) - (base.measure_fps_mean ?? 0);
    if (!best || gain > best.gain) best = { ...s, gain, row: r };
  }
  return best;
}

export async function writeOptimizationReport({ batchDir, trials, byArm, startedAt, finishedAt }) {
  const e3 = arm(byArm, "E3_normal_baseline");
  const e8 = arm(byArm, "E8_pure_baseline");
  const o5 = arm(byArm, "O5_E3_all_optimizations");
  const ev = evaluateOptimizationEffectiveness(e3, o5);
  const bestSingle = pickBestSingleOpt(byArm);

  const lines = [
    "# RTX 4070 headed normal 优化实验报告",
    "",
    `- **批次**: \`${batchDir}\``,
    `- **开始**: ${startedAt}`,
    `- **结束**: ${finishedAt}`,
    `- **优化判定**: **${ev.verdict}** (${ev.passed}/4 条件)`,
    "",
    "## 1. E3 baseline 瓶颈是否复现？",
    "",
    e3
      ? `- E3_normal_baseline measure_fps ≈ **${fmt(e3.measure_fps_mean)}** · frame_p95 ≈ **${fmt(e3.frame_p95_mean)}** ms`
      : "- E3 baseline 数据缺失",
    e8
      ? `- E8_pure_baseline measure_fps ≈ **${fmt(e8.measure_fps_mean)}**`
      : "- E8 baseline 缺失",
    e3 && e8
      ? `- E3 相对 E8 pure: **${fmt((e3.measure_fps_mean / e8.measure_fps_mean) * 100, 0)}%** FPS — ${
          e3.measure_fps_mean < e8.measure_fps_mean * 0.85
            ? "差距明显，瓶颈复现"
            : "差距不大，本轮 baseline 与历史正式批可能口径不同"
        }`
      : "",
    "",
    "## 2. 按 arm 汇总",
    "",
    "| arm | group | measure_fps | frame_p95 | >33ms | >100ms | render_scale | budget_scale |",
    "|-----|-------|-------------|-----------|-------|--------|--------------|--------------|",
  ];

  for (const r of byArm) {
    lines.push(
      `| ${r.arm_id} | ${r.arm_group} | ${fmt(r.measure_fps_mean)} | ${fmt(r.frame_p95_mean)} | ${fmt(r.frames_over_33ms_mean, 0)} | ${fmt(r.frames_over_100ms_mean, 0)} | ${fmt(r.render_scale_mean, 2)} | ${fmt(r.budget_scale_mean, 2)} |`,
    );
  }

  const o1 = arm(byArm, "O1_E3_adaptive_dpr_only");
  const o2 = arm(byArm, "O2_E3_splat_budget_only");
  const o3 = arm(byArm, "O3_E3_lod_throttle_only");
  const o4 = arm(byArm, "O4_E3_adaptive_dpr_plus_splat_budget");

  lines.push(
    "",
    "## 3. 必须回答的问题",
    "",
    `1. **adaptive DPR 是否提升 FPS？** ${
      o1 && e3 && o1.measure_fps_mean > e3.measure_fps_mean * 1.05 ? "是" : "否/边缘"
    } (O1 ${fmt(o1?.measure_fps_mean)} vs E3 ${fmt(e3?.measure_fps_mean)})`,
    `2. **adaptive DPR 是否降低 frame_p95 / long frames？** ${
      o1 && e3 && o1.frame_p95_mean < e3.frame_p95_mean ? "是" : "否/边缘"
    }`,
    `3. **splat budget 是否提升 FPS？** ${
      o2 && e3 && o2.measure_fps_mean > e3.measure_fps_mean * 1.05 ? "是" : "否/边缘"
    }`,
    `4. **LoD throttle 是否减少 long frames？** ${
      o3 && e3 && (o3.frames_over_33ms_mean ?? 0) < (e3.frames_over_33ms_mean ?? 0) ? "是" : "否/边缘"
    }`,
    `5. **叠加是否优于单独？** ${
      o5 && bestSingle && o5.measure_fps_mean > (arm(byArm, bestSingle.id)?.measure_fps_mean ?? 0)
        ? "是"
        : "否/边缘"
    } (O5 ${fmt(o5?.measure_fps_mean)} FPS)`,
    `6. **O5 是否接近 E8？** ${
      o5 && e8
        ? `${fmt((o5.measure_fps_mean / e8.measure_fps_mean) * 100, 0)}% of E8 — ${
            o5.measure_fps_mean >= e8.measure_fps_mean * 0.9 ? "接近" : "仍低于 pure render"
          }`
        : "—"}`,
    `7. **若 O5 仍低于 E8，剩余瓶颈**：LoD/visibility 仍部分运行、相机/controls、compositor、无法通过 DPR/budget 消除的 raster 路径。`,
    `8. **画质 proxy**：见 quality_proxy_mean 列；budget/DPR 降低时 splat 数或 render scale 会下降。`,
    "",
    "## 4. 单项优化归因",
    "",
  );

  if (bestSingle) {
    let hint = "";
    if (bestSingle.id.includes("O1")) hint = "瓶颈主要偏向 **fill-rate / compositor**（分辨率）。";
    else if (bestSingle.id.includes("O3")) hint = "瓶颈主要偏向 **runtime update / scheduling**（LoD）。";
    else if (bestSingle.id.includes("O2")) hint = "瓶颈主要偏向 **rendered splat load**。";
    lines.push(`- 单项收益最大：**${bestSingle.label}** (+${fmt(bestSingle.gain)} FPS vs E3 baseline)。${hint}`);
  }

  lines.push(
    "",
    "## 5. 诊断 arms（D1–D4）",
    "",
  );
  for (const id of [
    "D1_render_plus_camera_only",
    "D2_render_plus_visibility_only",
    "D3_render_plus_lod_update_only",
    "D4_normal_fixed_lod",
  ]) {
    const r = arm(byArm, id);
    lines.push(
      r
        ? `- **${id}**: ${fmt(r.measure_fps_mean)} FPS · p95 ${fmt(r.frame_p95_mean)} ms`
        : `- **${id}**: 未运行或无效`,
    );
  }
  lines.push(
    "",
    "说明：D2 为近似实现（固定 splat scale + driveLod，无独立 visibility-only API）。",
    "",
    "## 6. 论文推荐",
    "",
  );

  if (ev.verdict === "EFFECTIVE") {
    lines.push("- 推荐组合：**O5（adaptive DPR + splat budget + LoD throttle）** 作为系统设计候选。");
  } else if (bestSingle) {
    lines.push(`- 推荐优先验证：**${bestSingle.label}**；全量叠加需更多 trial 确认稳定性。`);
  } else {
    lines.push("- 本轮优化未达通过标准；建议先对齐 E3 baseline 与正式批口径后再评估。");
  }

  if (ev.reasons.length) {
    lines.push("", "### 通过项", "", ...ev.reasons.map((r) => `- ${r}`));
  }

  await fs.writeFile(path.join(batchDir, "optimization_report.md"), lines.join("\n"), "utf8");
  return { ...ev, bestSingle };
}
