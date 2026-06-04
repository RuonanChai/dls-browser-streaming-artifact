/**
 * diagnosis_decision_e0_e10.md — full matrix rules (NVIDIA batch).
 */
import fs from "node:fs/promises";
import { buildDiagnosisDecision } from "./local_stutter_ablation_decision.mjs";
import { buildDiagnosisDecisionV2 } from "./local_stutter_ablation_decision_v2.mjs";

export async function writeDiagnosisDecisionE0E10(rows, outPath) {
  const v2part = buildDiagnosisDecisionV2(rows.filter((r) => r.experiment_id !== "E0"));
  const { markdown: v1part } = buildDiagnosisDecision(
    rows.filter((r) => ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"].includes(r.experiment_id)),
  );
  const e0 = rows.find((r) => r.experiment_id === "E0");
  const header = [
    "# Diagnosis decision — E0–E10（RTX 4070 正式批）",
    "",
    e0
      ? `**E0 GPU**: ${e0.webgl_renderer}`
      : "**E0**: 缺失",
    "",
    "---",
    "",
    "## V2 分项判定（E2/E4–E10）",
    "",
    v2part.replace(/^# Diagnosis decision v2[\s\S]*?基于修复[\s\S]*?\n\n/, ""),
    "",
    "---",
    "",
    "## V1 规则判定（E1–E10）",
    "",
    v1part.replace(/^# Diagnosis decision \(ablation\)\n\n/, ""),
  ].join("\n");
  await fs.writeFile(outPath, header, "utf8");
}
