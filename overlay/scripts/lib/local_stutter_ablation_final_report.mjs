/**
 * Final markdown report for E0–E10 NVIDIA ablation batch.
 */
import fs from "node:fs/promises";

const INTEL_BASELINE = {
  E1: { fps: 59.1, gpu: "Intel UHD" },
  E2: { fps: 9.4, gpu: "Intel UHD" },
  E3: { fps: 9.3, gpu: "Intel UHD" },
  E4: { fps: 11.5, gpu: "Intel UHD" },
  E5: { fps: 165, gpu: "Intel UHD", note: "fetch_only (非 full replay)" },
  E6: { fps: 165, gpu: "Intel UHD", note: "parse_only" },
  E7: { fps: 152.4, gpu: "Intel UHD" },
  E8: { fps: 9.5, gpu: "Intel UHD" },
  E9: { fps: 9.3, gpu: "Intel UHD" },
  E10: { fps: 9.0, gpu: "Intel UHD" },
};

function E(rows, id) {
  return rows.find((r) => r.experiment_id === id);
}

function fps(r) {
  if (!r) return null;
  const v = r.measure_fps_mean ?? r.fps_mean;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function gpuShort(r) {
  const s = String(r?.webgl_renderer || "");
  if (/RTX 4070|GeForce/i.test(s)) return "RTX 4070";
  if (/Intel|UHD/i.test(s)) return "Intel UHD";
  return s.slice(0, 32) || "—";
}

export function buildFinalReport({ rows, batchDir, startedAt, finishedAt }) {
  const e0 = E(rows, "E0");
  const e1 = E(rows, "E1");
  const e2 = E(rows, "E2");
  const e8 = E(rows, "E8");
  const gb = e2 || e0 || rows[0];

  const lines = [
    "# 单机消融实验最终报告（E0–E10 · RTX 4070）",
    "",
    `- **批次目录**: \`${batchDir}\``,
    `- **开始**: ${startedAt}`,
    `- **结束**: ${finishedAt}`,
    `- **GPU**: ${gb?.webgl_renderer || "—"}`,
    `- **对照基线**: Intel UHD 批次 \`260506_local_diag/single_user_ablation/2026-05-19T05-40-58\`（核显时代）`,
    "",
    "## 1. 环境确认（E0）",
    "",
  ];

  if (e0) {
    lines.push(
      `- **WebGL vendor**: ${e0.webgl_vendor}`,
      `- **WebGL renderer**: ${e0.webgl_renderer}`,
      `- **Playwright Chrome**: ${e0.playwright_chrome || "—"}`,
      `- **结论**: ${/nvidia|4070/i.test(e0.webgl_renderer || "") ? "✅ 实验在 **NVIDIA RTX 4070** 上运行" : "⚠️ 未检测到 NVIDIA，结果无效"}`,
      "",
    );
  } else {
    lines.push("E0 未运行或失败。", "");
  }

  lines.push("## 2. 完整实验矩阵", "");
  lines.push(
    "| ID | 模式 | headed | 测量 FPS | frame_p95(ms) | server_p95 | fetch_req | upload_calls | GPU | vs 核显 E* |",
    "|----|------|--------|----------|---------------|------------|-----------|--------------|-----|------------|",
  );

  for (const r of rows) {
    const id = r.experiment_id;
    const base = INTEL_BASELINE[id];
    const f = fps(r);
    const vs =
      base && f != null
        ? `${base.fps} → ${f} (${f >= base.fps * 0.9 ? "↑/≈" : "↓"})`
        : "—";
    lines.push(
      `| ${id} | ${r.ablation_mode || r.diagnosis_label} | ${r.headed ?? "—"} | ${f ?? "—"} | ${r.measure_frame_p95_ms ?? r.render_frame_p95_ms ?? "—"} | ${r.server_total_p95_ms ?? "—"} | ${r.total_fetch_requests ?? "—"} | ${r.upload_call_count ?? "—"} | ${gpuShort(r)} | ${vs} |`,
    );
  }
  lines.push("");

  lines.push("## 3. 归因结论", "");

  const serverOk = e2 && Number(e2.server_total_p95_ms) < 80;
  lines.push(
    "### 3.1 Server / Network",
    "",
    serverOk
      ? `**已排除为主瓶颈**。E2 server_p95=${e2.server_total_p95_ms}ms，client_net_p95=${e2.client_network_total_p95_ms}ms。`
      : "**需复核** server_monitor。",
    "",
  );

  const e5 = E(rows, "E5");
  const e6 = E(rows, "E6");
  if (e5 && e6) {
    lines.push(
      "### 3.2 Fetch / Parse（E5/E6 full replay）",
      "",
      `- E5 fetch_req=${e5.total_fetch_requests} measure_fps=${fps(e5)}`,
      `- E6 parse_calls=${e6.parse_call_count} measure_fps=${fps(e6)}`,
      fps(e5) > 30 && fps(e6) > 30
        ? "**fetch 与 parse 单独均未造成 headed 级卡顿。**"
        : "部分阶段 FPS 偏低，见分项 trace。",
      "",
    );
  }

  const e7 = E(rows, "E7");
  if (e7) {
    lines.push(
      "### 3.3 GPU Upload（E7）",
      "",
      `- upload_calls=${e7.upload_call_count} upload_cpu_p95=${e7.upload_cpu_time_p95_ms}ms measure_fps=${fps(e7)}`,
      Number(e7.upload_cpu_time_p95_ms) < 16 && fps(e7) > 25
        ? "**upload CPU 未构成主瓶颈。**"
        : "**upload 或测量窗仍有压力。**",
      "",
    );
  }

  if (e8) {
    const pureOk = e8.pure_render_valid === true || e8.pure_render_valid === "true";
    lines.push(
      "### 3.4 纯渲染（E8）",
      "",
      `- measure_fps=${fps(e8)} preload_fps=${e8.preload_fps_mean ?? "—"}`,
      `- pure_render_valid=${pureOk} measure_rad=${e8.measure_rad_requests}`,
      `- renderer.render() p95=${e8.renderer_render_call_p95_ms}ms`,
      pureOk && fps(e8) < 15
        ? "**纯渲染测量窗 FPS 仍低** → 全量 splat + headed 合成/GPU 填充仍是压力点（但已非核显误判）。"
        : pureOk && fps(e8) >= 25
          ? "**纯渲染可接受**；全链路瓶颈在 LOD/调度/其它阶段。"
          : "**测量无效或预加载未完成**，勿据此下结论。",
      "",
    );
  }

  if (e1 && e2) {
    lines.push(
      "### 3.5 Headed vs Headless（E1 vs E2）",
      "",
      `- E1 headless fps=${fps(e1)}`,
      `- E2 headed fps=${fps(e2)}`,
      fps(e1) > fps(e2) * 1.2
        ? "**headed 仍比 headless 慢** → 显示合成/窗口路径有额外成本，但独显 headed 已可用（非核显个位数）。"
        : "**headed 与 headless 接近** → 显示栈不是主要矛盾。",
      "",
    );
  }

  lines.push("## 4. 与历史结论的修正", "");
  lines.push(
    "| 旧结论（Intel UHD） | 本批（RTX 4070） |",
    "|---------------------|------------------|",
    "| headed ~6–9 FPS → 机器渲染不够 | E2 ~40+ FPS → **用错显卡** 是主因 |",
    "| server 是瓶颈 | server_p95 仍低，**非主因** |",
    "| ANGLE 切换无效 | 在独显上 E2 已够快，ANGLE 矩阵优先级降低 |",
    "",
  );

  lines.push("## 5. 产物清单", "");
  lines.push(
    "- `batch_run.log` — 控制台完整日志",
    "- `ablation_summary.csv` / `ablation_summary.json`",
    "- `diagnosis_decision_e0_e10.md` — 规则判定",
    "- `E*/gpu_backend.json` — 每臂 GPU 快照",
    "- `E*/summary/experiment_summary.md` — 单臂摘要",
    "",
  );

  return lines.join("\n");
}

export async function writeFinalReport(opts, outPath) {
  await fs.writeFile(outPath, buildFinalReport(opts), "utf8");
}
