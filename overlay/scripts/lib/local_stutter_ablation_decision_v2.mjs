/**
 * diagnosis_decision_v2.md — ablation v2 conclusions.
 */
import fs from "node:fs/promises";

function E(rows, id) {
  return rows.find((r) => r.experiment_id === id);
}

function yn(v) {
  if (v === true || v === "true") return "是";
  if (v === false || v === "false") return "否";
  return String(v ?? "—");
}

export function buildDiagnosisDecisionV2(rows) {
  const e2 = E(rows, "E2");
  const e4b = E(rows, "E4b");
  const e5b = E(rows, "E5b");
  const e6b = E(rows, "E6b");
  const e7b = E(rows, "E7b");
  const e8b = E(rows, "E8b");
  const e9b = E(rows, "E9b");
  const e10b = E(rows, "E10b");

  const lines = [
    "# Diagnosis decision v2",
    "",
    "基于修复 instrumentation 后的小规模验证矩阵。",
    "",
  ];

  const serverExcluded =
    e2 && Number(e2.server_total_p95_ms) < 50 && Number(e2.client_network_total_p95_ms) < 50;
  lines.push("## 1. server/network 是否排除？", "");
  lines.push(
    serverExcluded
      ? `**是**。E2 server_p95=${e2?.server_total_p95_ms}ms，client_net_p95=${e2?.client_network_total_p95_ms}ms。`
      : "**不确定**，请查看 server_monitor。",
    "",
  );

  const fetchReqOk = e5b && Number(e5b.total_fetch_requests) >= 200;
  const fetchStutter =
    e5b &&
    (Number(e5b.measure_fps_mean || e5b.fps_mean) < 20 ||
      Number(e5b.long_frame_over_100ms_count) > 10);
  lines.push("## 2. full fetch 是否排除？", "");
  lines.push(
    `- E5b total_fetch_requests=${e5b?.total_fetch_requests ?? "—"}，total_fetch_bytes=${e5b?.total_fetch_bytes ?? "—"}`,
  );
  lines.push(
    fetchReqOk && !fetchStutter
      ? "**是（已排除）**。完整 Range replay 下 fetch/arrayBuffer 未造成 headed 级卡顿。"
      : fetchReqOk && fetchStutter
        ? "**否**。full fetch 阶段仍有明显长帧。"
        : `**未充分验证**（请求数 ${e5b?.total_fetch_requests ?? 0}，目标 ≥200 / ~342）。`,
    "",
  );

  const parseOk = e6b && Number(e6b.parse_call_count) >= 50;
  const parseStutter =
    e6b &&
    (Number(e6b.measure_fps_mean || e6b.fps_mean) < 20 ||
      Number(e6b.long_frame_over_100ms_count) > 10);
  lines.push("## 3. full parse 是否排除？", "");
  lines.push(
    `- E6b parse_call_count=${e6b?.parse_call_count ?? "—"}，parse_p95_ms=${e6b?.parse_p95_ms ?? "—"}`,
  );
  lines.push(
    parseOk && !parseStutter
      ? "**是（已排除）**。完整 parse 路径未单独造成 headed 级卡顿。"
      : parseOk && parseStutter
        ? "**否**。parse_only_full 仍有明显卡顿。"
        : "**未充分验证**。",
    "",
  );

  const uploadOk = e7b && Number(e7b.upload_call_count) > 0;
  const uploadStutter =
    e7b &&
    Number(e7b.upload_cpu_time_p95_ms) > 16 &&
    Number(e7b.measure_fps_mean || e7b.fps_mean) < 30;
  lines.push("## 4. GPU upload 是否排除？", "");
  lines.push(
    `- E7b upload_call_count=${e7b?.upload_call_count ?? "—"}，upload_cpu_p95=${e7b?.upload_cpu_time_p95_ms ?? "—"}ms，bytes≈${e7b?.upload_bytes_estimated ?? "—"}`,
  );
  lines.push(
    uploadOk && !uploadStutter
      ? "**是（已排除）**。WebGL upload 调用未构成主瓶颈。"
      : uploadOk && uploadStutter
        ? "**否**。upload CPU 时间或 FPS 表明 upload 仍有压力。"
        : "**未命中/未验证**（upload_call_count=0 表示 instrumentation 可能仍未命中）。",
    "",
  );

  const pureValid = e8b?.pure_render_valid === true || e8b?.pure_render_valid === "true";
  const renderLowFps = e8b && Number(e8b.measure_fps_mean || e8b.fps_mean) < 15;
  lines.push("## 5. pure render 是否仍然低 FPS？", "");
  lines.push(
    `- E8b measure_fps_mean=${e8b?.measure_fps_mean ?? e8b?.fps_mean}，measure_frame_p95=${e8b?.measure_frame_p95_ms}ms`,
  );
  lines.push(`- measure_rad_requests=${e8b?.measure_rad_requests ?? "—"}，pure_render_valid=${yn(e8b?.pure_render_valid)}`);
  lines.push(
    pureValid && renderLowFps
      ? "**是**。预加载后纯渲染窗口 FPS 仍低 → WebGL/GPU/compositor/present 为主因。"
      : pureValid && !renderLowFps
        ? "**否**，纯渲染窗口可接受。"
        : "**测量无效**（measure 阶段仍有 .rad 请求，非 pure render）。",
    "",
  );

  lines.push("## 6. headed/headless 差异（引用 E1 历史）", "");
  lines.push(
    "先前 E1 headless ~59 fps vs E2 headed ~9 fps：**headed 显示栈差异仍成立**（本批未重跑 E1）。",
    "",
  );

  lines.push("## 7. WebGL renderer / vendor", "");
  const gb = e2 || e8b || rows[0];
  lines.push(`- **vendor**: ${gb?.webgl_vendor || "—"}`);
  lines.push(`- **renderer**: ${gb?.webgl_renderer || "—"}`);
  lines.push(`- **ANGLE**: ${yn(gb?.is_angle)} · **SwiftShader**: ${yn(gb?.is_swiftshader)}`);
  lines.push(`- **canvas / DPR**: ${gb?.canvas_css_width}×${gb?.canvas_css_height} @ DPR ${gb?.device_pixel_ratio}`);
  lines.push(`- **drawingBuffer**: ${gb?.drawing_buffer_width}×${gb?.drawing_buffer_height}`);
  lines.push("");

  lines.push("## 指标说明", "");
  lines.push("- `renderer_render_call_p95_ms` 仅反映 `renderer.render()` JS 调用耗时，**不代表** GPU/compositor 总成本。");
  lines.push("- 渲染卡顿主看：`measure_fps_mean`、`measure_frame_p95_ms`、>33ms/>100ms 帧数、trace `gpu/raster/composite`。");
  lines.push("");

  lines.push(
    "## 实验矩阵",
    "",
    "| id | mode | measure_fps | frame_p95 | rad_req(measure) | fetch_req | parse_calls | upload_calls | server_p95 | renderer |",
    "|----|------|-------------|-----------|------------------|-----------|-------------|--------------|------------|----------|",
  );
  for (const r of rows) {
    const ren = String(r.webgl_renderer || "").slice(0, 40);
    lines.push(
      `| ${r.experiment_id} | ${r.ablation_mode} | ${r.measure_fps_mean ?? r.fps_mean} | ${r.measure_frame_p95_ms} | ${r.measure_rad_requests} | ${r.total_fetch_requests} | ${r.parse_call_count} | ${r.upload_call_count} | ${r.server_total_p95_ms} | ${ren} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

export async function writeDiagnosisDecisionV2(rows, outPath) {
  await fs.writeFile(outPath, buildDiagnosisDecisionV2(rows), "utf8");
}
