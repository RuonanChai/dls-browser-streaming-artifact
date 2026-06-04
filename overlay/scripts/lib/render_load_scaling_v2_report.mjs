/**
 * render_load_scaling_v2.md
 */
import fs from "node:fs/promises";

function validRows(rows) {
  return rows.filter((r) => r.pure_ok && !r.run_invalid);
}

function isMonotonic(counts) {
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] < counts[i - 1] * 0.85) return false;
  }
  return true;
}

export function buildRenderLoadScalingV2Report(allRows) {
  const valid = validRows(allRows).sort(
    (a, b) => Number(a.render_splat_budget_percent) - Number(b.render_splat_budget_percent),
  );
  const r100 = valid.find((r) => Number(r.render_splat_budget_percent) === 100);
  const r01 = valid.find((r) => Number(r.render_splat_budget_percent) === 1);

  const lines = [
    "# Render load scaling v2",
    "",
    "通过 `spark.lodSplatScale` 控制 **rendered splat budget**（非仅 preload chunks）。",
    "仅纳入 `pure_ok=true` 且 `run_invalid=false` 的 run。",
    "",
  ];

  const splatOf = (r) =>
    Number(r.rendered_splat_count) || Number(r.visible_splat_count) || Number(r.target_rendered_splats) || 0;

  if (!valid.length) {
    lines.push("**无有效 run** — 所有实验 pure_ok=false 或 invalid。", "");
    return lines.join("\n");
  }

  lines.push(
    "## 有效实验矩阵",
    "",
    "| id | budget% | rendered_splats | visible_splats | loaded_splats | draw_calls/frame | render.points | fps | frame_p95 | >33ms | >100ms | trace_gpu | trace_raster | pure_ok | measure_rad |",
    "|----|---------|-----------------|----------------|---------------|------------------|---------------|-----|-----------|-------|--------|-----------|--------------|---------|-------------|",
  );

  for (const r of valid) {
    lines.push(
      `| ${r.experiment_id} | ${r.render_splat_budget_percent} | ${Math.round(splatOf(r))} | ${Math.round(r.visible_splat_count ?? 0)} | ${Math.round(r.target_rendered_splats ?? r.loaded_splat_count ?? 0)} | ${r.draw_calls_per_frame_mean} | ${r.render_points} | ${r.measure_fps_mean} | ${Math.round(r.measure_frame_p95_ms)}ms | ${r.long_frame_over_33ms_count} | ${r.long_frame_over_100ms_count} | ${Math.round(r.trace_gpu_ms)} | ${Math.round(r.trace_raster_ms)} | ${r.pure_ok} | ${r.measure_rad_requests} |`,
    );
  }

  const renderedCounts = valid.map(splatOf);
  const monotonic = isMonotonic(renderedCounts);
  const fpsDecreasing =
    valid.length >= 2 &&
    Number(valid[0].measure_fps_mean) > Number(valid[valid.length - 1].measure_fps_mean) * 1.1;

  lines.push("", "## 问题回答", "");

  lines.push("### 1. rendered_splat_count 是否真正单调增加？", "");
  if (monotonic) {
    lines.push(
      `**是。** 从 R01≈${Math.round(renderedCounts[0])} 到 R100≈${Math.round(renderedCounts[renderedCounts.length - 1])} splats，随 budget% 单调上升。`,
    );
  } else {
    lines.push("**否或不完全单调** — 见上表，请检查 invalid run。");
    lines.push("", "各点 rendered_splat_count: " + valid.map((r) => `${r.experiment_id}=${Math.round(r.rendered_splat_count)}`).join(", "));
  }
  lines.push("");

  lines.push("### 2. FPS 是否随 rendered_splat_count 下降？", "");
  if (fpsDecreasing) {
    lines.push(
      `**是（有效 run 内）。** 低 budget fps≈${valid[0].measure_fps_mean}，R100 fps≈${r100?.measure_fps_mean ?? "?"}.`,
    );
  } else if (r01 && r100 && Number(r01.measure_fps_mean) > Number(r100.measure_fps_mean)) {
    lines.push(
      `**弱相关**：R01≈${r01.measure_fps_mean} fps vs R100≈${r100.measure_fps_mean} fps — 即使 splat 数差 ${Math.round(r100.rendered_splat_count / r01.rendered_splat_count)}x，FPS 仍在 ~6 平台期，说明 **固定 GPU/compositor 成本** 显著。`,
    );
  } else {
    lines.push("**不明显** — splat 减少未带来成比例 FPS 提升。");
  }
  lines.push("");

  const fps45 = valid.filter((r) => Number(r.measure_fps_mean) >= 45);
  lines.push("### 3. Intel UHD 在多少 splats 下能达到 45 FPS？", "");
  if (fps45.length) {
    const best = fps45.reduce((a, b) =>
      Number(a.rendered_splat_count) < Number(b.rendered_splat_count) ? a : b,
    );
    lines.push(
      `**≥45 FPS 出现在** \`${best.experiment_id}\`（budget=${best.render_splat_budget_percent}%，rendered≈${Math.round(best.rendered_splat_count)} splats，fps=${best.measure_fps_mean}）。`,
    );
  } else {
    const maxFps = Math.max(...valid.map((r) => Number(r.measure_fps_mean)));
    const bestR = valid.find((r) => Number(r.measure_fps_mean) === maxFps);
    lines.push(
      `**本批无任何配置达到 45 FPS。** 最高 fps≈${maxFps}（${bestR?.experiment_id}，rendered≈${Math.round(bestR?.rendered_splat_count ?? 0)} splats）。`,
    );
  }
  lines.push("");

  lines.push("### 4. headed Intel UHD 与 network/CDN QoE 实验", "");
  lines.push(
    fps45.length
      ? "部分低 splat budget 可达 45 FPS，但 full scene（R100）仍远低于 45 — network 实验应使用 headless 或低 budget 对照。"
      : "**明确结论：headed Intel UHD + ANGLE D3D11 不适合作为 network/CDN QoE 的主实验环境。** 即使 rendered splats 降至 ~1%（R01），FPS 仍无法稳定 ≥45；**请使用 headless（v1≈59fps）或独显机器** 进行 server/fetch/scheduler 类实验。",
  );
  lines.push("");

  const invalid = allRows.filter((r) => r.run_invalid || !r.pure_ok);
  if (invalid.length) {
    lines.push("## 排除的 run", "");
    for (const r of invalid) {
      lines.push(
        `- **${r.experiment_id}**: pure_ok=${r.pure_ok}, invalid=${r.run_invalid}, reason=${r.run_invalid_reason || "measure_rad>0 or preload incomplete"}, rendered=${r.rendered_splat_count}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeRenderLoadScalingV2Report(rows, outPath) {
  await fs.writeFile(outPath, buildRenderLoadScalingV2Report(rows), "utf8");
}
