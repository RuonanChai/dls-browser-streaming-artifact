/**
 * Generate diagnosis_decision.md from ablation_summary rows.
 */
import fs from "node:fs/promises";

function rowById(rows, id) {
  return rows.find((r) => r.experiment_id === id);
}

function fps(r) {
  return Number(r?.fps_mean) || 0;
}

function frameP95(r) {
  return Number(r?.render_frame_p95_ms) || Number(r?.fps_mean) ? 1000 / fps(r) : 0;
}

export function buildDiagnosisDecision(rows) {
  const E = (id) => rowById(rows, id);
  const lines = ["# Diagnosis decision (ablation)", ""];
  const decisions = [];

  const e5 = E("E5");
  const e6 = E("E6");
  const e7 = E("E7");
  const e8 = E("E8");
  const e9 = E("E9");
  const e10 = E("E10");
  const e1 = E("E1");
  const e2 = E("E2");
  const e3 = E("E3");
  const e4 = E("E4");

  const fetchP95 = (r) => Number(r?.fetch_total_p95_ms) || 0;
  const parseP95 = (r) => Number(r?.parse_total_p95_ms) || 0;
  const uploadP95 = (r) => Number(r?.gpu_upload_total_p95_ms) || 0;
  const renderP95 = (r) => Number(r?.render_frame_p95_ms) || 0;

  if (e5 && fps(e5) < 15) {
    decisions.push({
      rule: 1,
      text: "fetch_only 仍卡顿 → 检查 browser fetch / CDP / network callback / logging 开销",
      evidence: `E5 fps_mean=${fps(e5)} fetch_p95=${fetchP95(e5)}`,
    });
  } else if (e5 && e6 && fps(e5) > 20 && fps(e6) < 15) {
    decisions.push({
      rule: 2,
      text: "fetch_only 流畅但 parse_only 卡 → 归因为 .rad parse / JS main thread",
      evidence: `E5 fps=${fps(e5)} E6 fps=${fps(e6)} parse_p95=${parseP95(e6)}`,
    });
  } else if (e6 && e7 && fps(e6) > 20 && fps(e7) < 15) {
    decisions.push({
      rule: 3,
      text: "parse_only 流畅但 upload_only 卡 → 归因为 GPU buffer / texture upload",
      evidence: `E6 fps=${fps(e6)} E7 fps=${fps(e7)}`,
    });
  } else if (e7 && e8 && fps(e7) > 20 && fps(e8) < 15) {
    decisions.push({
      rule: 4,
      text: "upload_only 流畅但 render_only 卡 → 归因为 WebGL render / GPU / compositor",
      evidence: `E7 fps=${fps(e7)} E8 fps=${fps(e8)} render_p95=${renderP95(e8)}`,
    });
  } else if (e8 && e2 && fps(e8) > 25 && fps(e2) < 15) {
    decisions.push({
      rule: 5,
      text: "render_only 流畅但 normal 卡 → 归因为 dynamic LOD / scheduler / scene update",
      evidence: `E8 fps=${fps(e8)} E2 fps=${fps(e2)}`,
    });
  }

  if (e1 && e2 && fps(e2) < 12 && fps(e1) > fps(e2) * 1.3) {
    decisions.push({
      rule: 6,
      text: "headed 卡但 headless 更流畅 → display / compositor / GPU backend / 窗口环境",
      evidence: `E1 fps=${fps(e1)} E2 fps=${fps(e2)}`,
    });
  }

  if (e2 && e4 && fps(e4) > fps(e2) * 1.25) {
    decisions.push({
      rule: 7,
      text: "降低 pixelRatio 明显改善 → GPU fill-rate / raster 压力",
      evidence: `E2 fps=${fps(e2)} E4 fps=${fps(e4)} (pixelRatio=0.5)`,
    });
  }

  if (e9 && e10 && fps(e9) > fps(e10) * 1.25) {
    decisions.push({
      rule: 8,
      text: "固定 camera 流畅但 moving camera 卡 → camera-dependent LOD / sorting / view update",
      evidence: `E9 fps=${fps(e9)} E10 fps=${fps(e10)}`,
    });
  }

  const serverOk = e2 && Number(e2.server_total_p95_ms) < 50;
  if (serverOk && e2 && fps(e2) < 20) {
    decisions.push({
      rule: "server",
      text: "server-side file serving is unlikely to be the dominant bottleneck; dominant stalls are client-side processing/rendering.",
      evidence: `server_p95=${e2.server_total_p95_ms}ms client_net_p95=${e2.client_network_total_p95_ms}ms`,
    });
  }

  if (!decisions.length) {
    decisions.push({
      rule: 0,
      text: "无单一规则强匹配；见 ablation_summary.csv 对比各阶段 P95",
      evidence: "",
    });
  }

  lines.push("## 规则判定", "");
  for (const d of decisions) {
    lines.push(`### 规则 ${d.rule}`, "", d.text, "", `- 证据: ${d.evidence}`, "");
  }

  lines.push("## 实验矩阵摘要", "", "| id | mode | headed | pixelRatio | fps_mean | frame_p95 | server_p95 | net_p95 | main_ms | gpu_ms |", "|----|------|--------|------------|----------|-----------|------------|---------|---------|--------|");
  for (const r of rows) {
    lines.push(
      `| ${r.experiment_id} | ${r.ablation_mode} | ${r.headed} | ${r.pixel_ratio} | ${r.fps_mean} | ${r.render_frame_p95_ms} | ${r.server_total_p95_ms} | ${r.client_network_total_p95_ms} | ${r.main_thread_total_ms} | ${r.gpu_total_ms} |`,
    );
  }
  lines.push("");

  return { markdown: lines.join("\n"), decisions };
}

export async function writeDiagnosisDecision(rows, outPath) {
  const { markdown } = buildDiagnosisDecision(rows);
  await fs.writeFile(outPath, markdown, "utf8");
}
