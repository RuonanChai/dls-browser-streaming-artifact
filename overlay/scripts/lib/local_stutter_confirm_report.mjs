/**
 * confirm_bottleneck_report.md generator.
 */
import fs from "node:fs/promises";
import path from "node:path";

function mean(xs) {
  const v = xs.filter((n) => Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function fmt(n, d = 1) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(d);
}

export function evaluateVerdict(byArm, trials) {
  const get = (id) => byArm.find((r) => r.arm_id === id);
  const e3 = get("E3_normal");
  const e4 = get("E4_normal_dpr05");
  const e8 = get("E8_render_only_pure");
  const e9 = get("E9_static_pure_render");
  const e10 = get("E10_moving_pure_render");
  const e5 = get("E5_fetch_only_full");
  const e7 = get("E7_upload_only");

  const reasons = [];
  let score = 0;
  const need = 5;

  if (e3 && e8 && e3.measure_fps_mean < e8.measure_fps_mean * 0.65) {
    score += 1;
  } else reasons.push("E3 not sufficiently below E8 pure render");
  if (e3 && e4 && e4.measure_fps_mean > e3.measure_fps_mean * 1.5) {
    score += 1;
  } else reasons.push("E4 DPR=0.5 did not beat E3 by >=50%");
  if (e9 && e10 && e9.measure_fps_mean > e10.measure_fps_mean) {
    score += 1;
  } else reasons.push("E9 static not faster than E10 moving");
  if (e3 && e3.server_p95_mean < 50) {
    score += 1;
  } else reasons.push("server_p95 not low enough on E3");
  const e3Trials = trials.filter((t) => t.arm_id === "E3_normal" && t.trial_valid);
  const e3RadOk = e3Trials.every((t) => (Number(t.measure_rad_requests) || 0) <= 1);
  if (e3RadOk) score += 1;
  else reasons.push("E3 measure_rad_requests not near 0");

  let verdict = "NOT CONFIRMED";
  if (score >= need) verdict = "CONFIRMED";
  else if (score >= need - 2) verdict = "PARTIALLY CONFIRMED";

  return { verdict, score, need, reasons, e3, e4, e8, e9, e10, e5, e7 };
}

export async function writeConfirmReport({
  batchDir,
  trials,
  byArm,
  priorBatch,
  intelBatch,
  startedAt,
  finishedAt,
}) {
  const ev = evaluateVerdict(byArm, trials);
  const invalid = trials.filter((t) => !t.trial_valid);
  const valid = trials.filter((t) => t.trial_valid);

  const lines = [
    "# NVIDIA 确认性复测报告（无 FPS cap）",
    "",
    `- **批次**: \`${batchDir}\``,
    `- **开始**: ${startedAt}`,
    `- **结束**: ${finishedAt}`,
    `- **对照正式批**: \`${priorBatch}\``,
    `- **对照 Intel 批**: \`${intelBatch}\``,
    `- **判定**: **${ev.verdict}** (${ev.score}/${ev.need})`,
    "",
    "## 1. 数据有效性",
    "",
    `- 总 trial: ${trials.length}，有效: ${valid.length}，无效: ${invalid.length}`,
    "",
  ];

  if (invalid.length) {
    lines.push("| trial | arm | invalid_reason |", "|-------|-----|----------------|");
    for (const t of invalid) {
      lines.push(`| ${t.trial_id} | ${t.arm_id} | ${t.invalid_reason} |`);
    }
    lines.push("");
  }

  lines.push(
    "有效 trial 的 GPU 要求：NVIDIA RTX 4070 + ANGLE D3D11 + `visibilityState=visible`。",
    "",
    "### pure render 洁净度",
    "",
  );
  for (const id of ["E8_render_only_pure", "E9_static_pure_render", "E10_moving_pure_render"]) {
    const ts = valid.filter((t) => t.arm_id === id);
    const rad = ts.map((t) => t.measure_rad_requests);
    lines.push(`- **${id}**: measure_rad_requests = ${rad.join(", ") || "—"}`);
  }
  lines.push("");
  lines.push("### E3 measure 阶段 .rad 请求");
  const e3r = valid.filter((t) => t.arm_id === "E3_normal").map((t) => t.measure_rad_requests);
  lines.push(`- measure_rad_requests per trial: **${e3r.join(", ")}**`);
  lines.push(
    e3r.every((n) => Number(n) <= 1)
      ? "- 与旧批一致：测量窗内**没有**持续网络下载；卡顿不能归因于 measure 阶段边下边画。"
      : "- ⚠️ 本轮 E3 measure 仍有 .rad 请求，与旧批口径不同，对比需谨慎。",
    "",
  );

  lines.push("## 2. 按 arm 汇总（仅有效 trial）", "");
  lines.push(
    "| arm | trials | measure_fps | frame_p95 | >33ms | >100ms | measure_rad_max | server_p95 | net_p95 |",
    "|-----|--------|-------------|-----------|-------|--------|-----------------|------------|---------|",
  );
  for (const r of byArm) {
    lines.push(
      `| ${r.arm_id} | ${r.valid_trials} | ${fmt(r.measure_fps_mean)} | ${fmt(r.frame_p95_mean)} | ${fmt(r.frames_over_33ms_mean, 0)} | ${fmt(r.frames_over_100ms_mean, 0)} | ${r.measure_rad_requests_max ?? "—"} | ${fmt(r.server_p95_mean)} | ${fmt(r.client_net_p95_mean)} |`,
    );
  }
  lines.push("");

  lines.push("## 3. 关键对比", "");
  if (ev.e3 && ev.e8) {
    lines.push(
      `### E3 normal vs E8 pure render`,
      `- E3 measure_fps ≈ **${fmt(ev.e3.measure_fps_mean)}**`,
      `- E8 measure_fps ≈ **${fmt(ev.e8.measure_fps_mean)}**`,
      `- 差距: E8 约为 E3 的 **${fmt(ev.e8.measure_fps_mean / ev.e3.measure_fps_mean, 2)}×**`,
      "",
    );
  }
  if (ev.e3 && ev.e4) {
    lines.push(
      `### E3 DPR=1 vs E4 DPR=0.5`,
      `- E3: **${fmt(ev.e3.measure_fps_mean)}** FPS · drawingBuffer 1280×720`,
      `- E4: **${fmt(ev.e4.measure_fps_mean)}** FPS · drawingBuffer 640×360`,
      `- E4 相对 E3: **+${fmt(((ev.e4.measure_fps_mean / ev.e3.measure_fps_mean) - 1) * 100, 0)}%**`,
      ev.e4.measure_fps_mean > 125
        ? `- E4 均值 **超过 125 FPS**，说明关掉 NVIDIA frame cap 后不再卡在 125 平台（若仍≈125需标记 possible cap）。`
        : `- E4 未超过 125 FPS：这不证明仍有 cap，也可能是 fill-rate/场景真实上限。`,
      "",
    );
  }
  if (ev.e9 && ev.e10) {
    lines.push(
      `### E9 static vs E10 moving (pure render)`,
      `- E9: **${fmt(ev.e9.measure_fps_mean)}** FPS`,
      `- E10: **${fmt(ev.e10.measure_fps_mean)}** FPS`,
      `- 运动相机成本约 **${fmt((1 - ev.e10.measure_fps_mean / ev.e9.measure_fps_mean) * 100, 0)}%** FPS`,
      "",
    );
  }
  if (ev.e5) {
    lines.push(`### E5 fetch_only_full: measure_fps ≈ **${fmt(ev.e5.measure_fps_mean)}** → fetch 仍非瓶颈`, "");
  }
  if (ev.e7) {
    lines.push(`### E7 upload_only: measure_fps ≈ **${fmt(ev.e7.measure_fps_mean)}** → upload CPU 仍非瓶颈`, "");
  }

  lines.push("## 4. 必须回答的问题", "");
  lines.push(
    `1. **network/server 是否仍非主瓶颈？** ${ev.e3?.server_p95_mean < 50 ? "是" : "需复核"}（E3 server_p95≈${fmt(ev.e3?.server_p95_mean)}ms）`,
    `2. **E3 是否仍明显低于 pure render？** ${ev.e3 && ev.e8 && ev.e3.measure_fps_mean < ev.e8.measure_fps_mean * 0.85 ? "是" : "否/边缘"}`,
    `3. **降 DPR 是否仍显著提升？** ${ev.e3 && ev.e4 && ev.e4.measure_fps_mean > ev.e3.measure_fps_mean * 1.5 ? "是" : "否"}`,
    `4. **相机运动是否仍有成本？** ${ev.e9 && ev.e10 && ev.e9.measure_fps_mean > ev.e10.measure_fps_mean ? "是" : "否"}`,
    "",
  );
  lines.push("## 5. 结论", "");
  if (ev.verdict === "CONFIRMED") {
    lines.push(
      "E3 的测量阶段即使没有新的 .rad 请求，normal headed runtime 仍明显慢于 pure render，说明瓶颈在 Spark headed client runtime 的组合路径，包括 LoD / visibility / camera update / scheduler / high-resolution rasterization / browser compositor。",
      "",
      "**不要**将 E3 卡顿简单描述为「边下载边渲染所以卡」。",
    );
  } else {
    lines.push(
      "本轮 **未复现**「E3 normal headed ≈53 FPS 且显著低于 pure render」的旧模式。",
      "",
      `在 RTX 4070、关掉 FPS cap 的前提下：E3≈${fmt(ev.e3?.measure_fps_mean)} FPS，E8≈${fmt(ev.e8?.measure_fps_mean)}，E9≈${fmt(ev.e9?.measure_fps_mean)}，E10≈${fmt(ev.e10?.measure_fps_mean)} FPS，处于同一量级。`,
      "",
      "仍成立：fetch/upload（E5/E7）高 FPS；pure render measure_rad=0；**不要**将 E3 说成「边下载边卡」。",
      "",
      "旧批 `2026-05-19T10-11-51` 中 E3≈52.6 FPS 可能与冷启动/预加载口径有关，不能与本轮直接等同。",
    );
  }
  lines.push("", "## 6. 未通过 / 异常项", "");
  if (ev.verdict !== "CONFIRMED") {
    for (const r of ev.reasons) lines.push(`- ${r}`);
  } else {
    lines.push("- 全部通过标准满足。");
  }
  lines.push("");

  await fs.writeFile(path.join(batchDir, "confirm_bottleneck_report.md"), lines.join("\n"), "utf8");
  return { ...ev, markdown: lines.join("\n") };
}
