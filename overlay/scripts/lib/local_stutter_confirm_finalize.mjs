/**
 * Regenerate report + figures from existing confirm_summary.csv
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfirmReport } from "./local_stutter_confirm_report.mjs";
import { writeConfirmFigures } from "./local_stutter_confirm_figures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === "," && !inQ) {
        cols.push(cur);
        cur = "";
      } else cur += c;
    }
    cols.push(cur);
    const o = {};
    header.forEach((h, i) => {
      const v = cols[i] ?? "";
      const n = Number(v);
      o[h] = v !== "" && Number.isFinite(n) ? n : v;
    });
    return o;
  });
}

export async function finalizeConfirmBatch(batchDir) {
  const trials = parseCsv(await fs.readFile(path.join(batchDir, "confirm_summary.csv"), "utf8"));
  const byArm = parseCsv(await fs.readFile(path.join(batchDir, "confirm_summary_by_arm.csv"), "utf8"));
  const ev = await writeConfirmReport({
    batchDir,
    trials,
    byArm,
    priorBatch: path.join(projectRoot, "260506_local_diag/single_user_ablation_nvidia_e0_e10/2026-05-19T10-11-51"),
    intelBatch: path.join(projectRoot, "260506_local_diag/single_user_ablation/2026-05-19T05-40-58"),
    startedAt: "2026-05-19T10:43:36.000Z",
    finishedAt: "2026-05-19T11:15:34.000Z",
  });
  try {
    await writeConfirmFigures(batchDir);
  } catch (e) {
    console.warn("figures:", e?.message);
  }
  return { trials, byArm, ev };
}
