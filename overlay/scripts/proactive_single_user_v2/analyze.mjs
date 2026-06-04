#!/usr/bin/env node
/**
 *   node scripts/proactive_single_user_v2/analyze.mjs --batchDir=... [--writeChapter]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeChapter3 } from "./write_chapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  let batchDir = null;
  let writeChapter = false;
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) batchDir = path.resolve(a.slice(11));
    else if (a === "--writeChapter") writeChapter = true;
  }
  if (!batchDir) throw new Error("--batchDir required");
  return { batchDir, writeChapter };
}

function csv(rows, keys) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function countByBaseline(trials) {
  const m = {};
  for (const t of trials) {
    const k = t.baseline_id;
    if (!m[k]) m[k] = { pass: 0, fail: 0 };
    if (t.hard_gate_passed) m[k].pass += 1;
    else m[k].fail += 1;
  }
  return m;
}

async function main() {
  const { batchDir, writeChapter } = parseArgs(process.argv.slice(2));
  const matDir = path.join(batchDir, "per_trial_json");
  const files = (await fs.readdir(matDir)).filter((f) => f.endsWith(".json"));
  const trials = [];
  for (const f of files) {
    trials.push(JSON.parse(await fs.readFile(path.join(matDir, f), "utf8")));
  }

  const outMat = path.join(root, "paper_materials", "proactive_single_user_v2");
  const figDir = path.join(root, "vrc-paper", "paper", "figures", "proactive_single_user_v2");
  await fs.mkdir(outMat, { recursive: true });
  await fs.mkdir(figDir, { recursive: true });

  const keys = [
    "trial_id",
    "phase",
    "delivery_key",
    "baseline_id",
    "status",
    "hard_gate_passed",
    "measure_fps",
    "frame_p95_ms",
    "request_total_p95_ms",
    "ttfb_p95_ms",
    "parse_p95_ms",
    "parse_total_ms",
    "first_visible_splat_ms",
    "visible_splat_max",
    "useful_chunks_before_demand",
    "demanded_chunks",
    "deadline_miss_ratio_50ms",
    "deadline_miss_ratio_100ms",
    "wasted_prefetch_bytes",
    "wasted_prefetch_ratio",
    "total_prefetch_bytes",
    "total_received_bytes",
    "useful_bytes_ratio",
    "normalized_useful_content_score",
    "fast_but_empty_detected",
    "measure_rad_requests",
    "cdp_rad_206_count",
    "ready_event_used",
    "prediction_horizon_ms",
    "parse_budget_chunks_per_sec",
  ];
  await fs.writeFile(path.join(outMat, "proactive_single_user_v2_summary.csv"), csv(trials, keys), "utf8");

  const byBase = {};
  for (const t of trials.filter((x) => x.hard_gate_passed)) {
    const k = `${t.delivery_key}|${t.baseline_id}`;
    if (!byBase[k]) byBase[k] = [];
    byBase[k].push(t);
  }

  const phaseStatus = {};
  for (const ph of ["phase0_canary", "phase1_origin", "phase2_remote"]) {
    const sub = trials.filter((t) => t.phase === ph);
    phaseStatus[ph] = {
      total: sub.length,
      passed: sub.filter((t) => t.hard_gate_passed).length,
    };
  }

  const lines = [
    "# Proactive single-user v2 audit (ready-aware)",
    "",
    `- batch: \`${batchDir}\``,
    `- trials: ${trials.length}`,
    `- passed gates: ${trials.filter((t) => t.hard_gate_passed).length}`,
    "",
    "## Phase completion",
    "",
    "| phase | trials | passed |",
    "|-------|--------|--------|",
  ];
  for (const [ph, st] of Object.entries(phaseStatus)) {
    lines.push(`| ${ph} | ${st.total} | ${st.passed} |`);
  }

  lines.push("", "## Per-baseline pass/fail", "", "| baseline | pass | fail |", "|----------|------|------|");
  for (const [bid, c] of Object.entries(countByBaseline(trials)).sort()) {
    lines.push(`| ${bid} | ${c.pass} | ${c.fail} |`);
  }

  lines.push(
    "",
    "## Aggregates (gate-passed means)",
    "",
    "| delivery | baseline | n | miss50% | miss100% | useful_before | useful_bytes_ratio | first-vis ms | FPS | wasted_MB | wasted_ratio% | ready_event |",
    "|----------|----------|---|---------|----------|---------------|-------------------|--------------|-----|-----------|---------------|-------------|",
  );

  for (const [k, rows] of Object.entries(byBase).sort()) {
    const [delivery, baseline] = k.split("|");
    lines.push(
      `| ${delivery} | ${baseline} | ${rows.length} | ${(mean(rows.map((r) => r.deadline_miss_ratio_50ms)) * 100)?.toFixed(1) ?? "—"} | ${(mean(rows.map((r) => r.deadline_miss_ratio_100ms)) * 100)?.toFixed(1) ?? "—"} | ${mean(rows.map((r) => r.useful_chunks_before_demand))?.toFixed(1) ?? "—"} | ${mean(rows.map((r) => r.useful_bytes_ratio))?.toFixed(2) ?? "—"} | ${mean(rows.map((r) => r.first_visible_splat_ms))?.toFixed(0) ?? "—"} | ${mean(rows.map((r) => r.measure_fps))?.toFixed(1) ?? "—"} | ${((mean(rows.map((r) => r.wasted_prefetch_bytes)) ?? 0) / 1e6).toFixed(2)} | ${((mean(rows.map((r) => r.wasted_prefetch_ratio)) ?? 0) * 100).toFixed(1)} | ${rows[0]?.ready_event_used ?? "—"} |`,
    );
  }

  // §7 checklist
  let chapter = null;
  if (writeChapter) {
    chapter = await writeChapter3({ root, batchDir, trials });
    lines.push("", "## §7 success-gate checklist (origin, B3-ready vs B0)", "");
    lines.push("| # | condition | pass | value |");
    lines.push("|---|-----------|------|-------|");
    for (const c of chapter.checks) {
      lines.push(`| ${c.id} | ${c.label} | ${c.pass ? "✅" : "❌"} | ${c.value} |`);
    }
    lines.push("", `**Passed: ${chapter.passed}/6** — ${chapter.passed >= 2 ? "GATE OK (≥2 required)" : "GATE NOT MET"}`);

    const decision = [
      "# Final decision (v2)",
      "",
      `- batch: \`${batchDir}\``,
      `- phases: ${JSON.stringify(phaseStatus)}`,
      `- §7 conditions passed: ${chapter.passed}/6`,
      "",
      "## Improvement summary",
      chapter.improves ? "**Single-user gate cleared (≥2 conditions).**" : "**Single-user gate NOT cleared.**",
      "",
      "## Multi-user overlap/dedup?",
      chapter.multiUserOk ? "**Yes — Phase C eligible (VRC dual hybrid_retest may run).**" : "**No — continue diagnose loop; multi-user blocked.**",
      "",
    ].join("\n");
    await fs.writeFile(path.join(outMat, "final_decision.md"), decision, "utf8");
  }

  await fs.writeFile(path.join(outMat, "proactive_single_user_v2_audit.md"), lines.join("\n"), "utf8");

  console.log(`[v2 analyze] ${path.join(outMat, "proactive_single_user_v2_summary.csv")}`);
  console.log(`[v2 analyze] ${path.join(outMat, "proactive_single_user_v2_audit.md")}`);
  if (chapter) {
    console.log(`[v2 analyze] chapter3: vrc-paper/paper/sections/chapter3_single_proactive_delivery.tex`);
    console.log(`[v2 analyze] §7 passed: ${chapter.passed}/6`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
