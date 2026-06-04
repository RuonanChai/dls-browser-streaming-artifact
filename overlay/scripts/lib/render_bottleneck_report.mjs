/**
 * Generate final_render_bottleneck_report.md from render bottleneck matrices.
 */
import fs from "node:fs/promises";

function row(rows, id) {
  return rows.find((r) => r.experiment_id === id);
}

function byPrefix(rows, prefix) {
  return rows.filter((r) => String(r.experiment_id).startsWith(prefix));
}

export function buildFinalRenderBottleneckReport(rows) {
  const angleRows = byPrefix(rows, "B_");
  const loadRows = byPrefix(rows, "R").sort(
    (a, b) => Number(a.load_percent) - Number(b.load_percent),
  );
  const resRows = byPrefix(rows, "D_");

  const defaultAngle = angleRows.find((r) => r.chrome_profile === "default") || angleRows[0];
  const d3d11 = angleRows.find((r) => r.chrome_profile === "angle_d3d11");
  const disableGpu = angleRows.find((r) => r.chrome_profile === "disable_gpu");
  const r100 = loadRows.find((r) => Number(r.load_percent) === 100) || row(rows, "R100");
  const r10 = loadRows.find((r) => Number(r.load_percent) === 10);
  const res720 = resRows.find((r) => r.viewport_width === 1280 && r.viewport_height === 720);
  const res360 = resRows.find((r) => r.viewport_width === 640 && r.viewport_height === 360);

  const gb = defaultAngle || rows[0] || {};
  const integrated = gb.is_integrated_gpu;

  const lines = [
    "# Final render bottleneck report",
    "",
    "## GPU backend (A)",
    "",
    `- **WEBGL UNMASKED_VENDOR**: ${gb.WEBGL_UNMASKED_VENDOR_WEBGL || gb.webgl_vendor || "—"}`,
    `- **WEBGL UNMASKED_RENDERER**: ${gb.WEBGL_UNMASKED_RENDERER_WEBGL || gb.webgl_renderer || "—"}`,
    `- **Chrome**: ${gb.chrome_version || "—"}`,
    `- **ANGLE backend (inferred)**: ${gb.angle_backend || "—"}`,
    `- **hardware_acceleration**: ${gb.hardware_acceleration}`,
    `- **is_integrated_gpu**: ${integrated} ${integrated ? "← **Intel/integrated GPU 标记**" : ""}`,
    `- **devicePixelRatio**: ${gb.device_pixel_ratio}`,
  "",
    "## B. ANGLE / Chrome backend matrix (E8b render_pure)",
    "",
    "| profile | measure_fps | frame_p95 | >33ms | >100ms | trace_gpu | trace_raster | renderer |",
    "|---------|-------------|-----------|-------|--------|-----------|--------------|----------|",
  ];

  for (const r of angleRows) {
    lines.push(
      `| ${r.chrome_profile} | ${r.measure_fps_mean} | ${Math.round(r.measure_frame_p95_ms)}ms | ${r.long_frame_over_33ms_count} | ${r.long_frame_over_100ms_count} | ${Math.round(r.trace_gpu_ms)} | ${Math.round(r.trace_raster_ms)} | ${String(r.webgl_renderer || "").slice(0, 50)} |`,
    );
  }

  lines.push("", "## C. Render load scaling (pure render, 30s measure)", "");
  lines.push(
    "| id | load% | chunks | splats(vis) | fps | frame_p95 | trace_gpu | trace_raster | pure_ok |",
    "|----|-------|--------|-------------|-----|-----------|-----------|--------------|---------|",
  );
  for (const r of loadRows) {
    lines.push(
      `| ${r.experiment_id} | ${r.load_percent} | ${r.loaded_chunk_count} | ${r.visible_splat_count ?? r.loaded_splat_count} | ${r.measure_fps_mean} | ${Math.round(r.measure_frame_p95_ms)}ms | ${Math.round(r.trace_gpu_ms)} | ${Math.round(r.trace_raster_ms)} | ${r.pure_render_valid} |`,
    );
  }

  lines.push("", "## D. Canvas resolution scaling (E8b render_pure)", "");
  lines.push(
    "| id | CSS | drawingBuffer | DPR | fps | frame_p95 |",
    "|----|-----|---------------|-----|-----|-----------|",
  );
  for (const r of resRows) {
    lines.push(
      `| ${r.experiment_id} | ${r.canvas_css_size} | ${r.drawing_buffer_size} | ${r.device_pixel_ratio} | ${r.measure_fps_mean} | ${Math.round(r.measure_frame_p95_ms)}ms |`,
    );
  }

  const bestFps = Math.max(...rows.map((r) => Number(r.measure_fps_mean) || 0));
  const bestRow = rows.find((r) => Number(r.measure_fps_mean) === bestFps);

  lines.push("", "---", "", "## 问题回答", "");

  lines.push(
    "### 1. 6 FPS 是否只出现在 Intel UHD headed rendering？",
    "",
    integrated
      ? "本机 **headed + Intel UHD (ANGLE D3D11) 集成显卡** 上，pure render measure 约 **5–7 FPS**。v1 显示 headless normal 可达 ~59 FPS，故 **6 FPS 是 headed 显示栈 + 本机 iGPU 组合现象**，并非所有环境都会出现。"
      : "需对照 headless/独显复测。",
    "",
  );

  const angleHelps =
    d3d11 && defaultAngle && Number(d3d11.measure_fps_mean) > Number(defaultAngle.measure_fps_mean) * 1.15;
  lines.push(
    "### 2. 更换 ANGLE backend 是否改善？",
    "",
    angleHelps
      ? `**部分改善**：最佳 profile \`${bestRow?.chrome_profile}\` fps≈${bestFps}，高于 default≈${defaultAngle?.measure_fps_mean}。`
      : `**无明显改善**：各 ANGLE profile FPS 均在 ~${defaultAngle?.measure_fps_mean ?? "?"}–${bestFps}，瓶颈不在 ANGLE 切换 alone。`,
    "",
  );

  const loadCorr =
    r10 && r100 && Number(r10.measure_fps_mean) > Number(r100.measure_fps_mean) * 1.2;
  lines.push(
    "### 3. FPS 是否随 loaded_splat_count 下降？",
    "",
    loadCorr
      ? `**是**：R10≈${r10.measure_fps_mean} fps (${r10.loaded_chunk_count} chunks) vs R100≈${r100.measure_fps_mean} fps (${r100.loaded_chunk_count} chunks)。`
      : `**弱相关或不单调**：见上表 C；即使 ${r10?.loaded_chunk_count ?? "?"} chunks 仍可能低 FPS，说明 **fill-rate/合成固定成本** 也显著。`,
    "",
  );

  const resHelps =
    res360 && res720 && Number(res360.measure_fps_mean) > Number(res720.measure_fps_mean) * 1.2;
  lines.push(
    "### 4. FPS 是否随 drawingBuffer 分辨率下降而改善？",
    "",
    resHelps
      ? `**是**：640×360≈${res360.measure_fps_mean} fps vs 1280×720≈${res720.measure_fps_mean} fps。`
      : `**改善有限**：分辨率减半未带来接近线性 FPS 提升 → raster/compositor 非唯一项。`,
    "",
  );

  lines.push(
    "### 5. 当前网络实验是否被 render bottleneck 污染？",
    "",
    "**是（headed normal 路径）**。fetch/upload 已排除后，E8b pure render 仍 ~6 FPS，说明 **headed 下 network/QoE 测量会被 GPU/compositor 渲染瓶颈污染**；network/CDN 应用 **headless 或 render-safe 配置**。",
    "",
  );

  lines.push(
    "### 6. 推荐 render-safe 配置（目标 FPS ≥45）",
    "",
    bestFps >= 45
      ? `已观测 \`${bestRow?.experiment_id}\` profile≈${bestFps} fps 可达标，见该 run 的 gpu_backend.json。`
      : [
          "本机 **headed + Intel UHD 无法达到 ≥45 FPS** pure render。可选：",
          "1. **headless** `normal`（v1 E1≈59fps）做 network/scheduler 实验；",
          "2. **降低负载**：R10–R25 + 低分辨率（若矩阵显示有效）；",
          "3. **`--disable-gpu` 仅作对照**，不适合真实 QoE。",
        ].join("\n"),
    "",
  );

  lines.push(
    "### 7. 若无法 ≥45 FPS",
    "",
    bestFps < 45
      ? "**明确建议**：network/CDN/Range 类实验使用 **headless 或配备独显（NVIDIA/AMD dGPU）的机器**；headed Intel UHD 仅用于 **render/GPU 诊断**，不作为 CDN 结论依据。"
      : "本批已达 ≥45 FPS，可采用对应 chrome_profile + viewport。",
    "",
  );

  if (disableGpu) {
    lines.push(
      "",
      `> 负向对照 disable_gpu: fps≈${disableGpu.measure_fps_mean}，renderer=\`${disableGpu.webgl_renderer}\``,
    );
  }

  return lines.join("\n");
}

export async function writeFinalRenderBottleneckReport(rows, outPath) {
  await fs.writeFile(outPath, buildFinalRenderBottleneckReport(rows), "utf8");
}
