/**
 * Oracle input audit artifacts (batch + paper_materials).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAPER_MATERIALS_DIR } from "./constants.mjs";
import { validateOracleInputs, oracleRangeKey } from "./oracle_reference.mjs";
import { loadRadRangeManifest, manifestForRadUrl } from "../lib/ablation_rad_range_manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, PAPER_MATERIALS_DIR);

function trialOracleRow(t) {
  const audit = t.oracle_run_audit ?? {};
  const manifestRanges = [];
  return {
    phase: t.phase,
    delivery_role: t.delivery_role,
    method: t.baseline_name,
    baseline_id: t.baseline_id,
    trial_id: t.trial_id,
    oracle_enabled: t.oracle_enabled ?? t.baseline_id === "oracle",
    oracle_type: t.oracle_type ?? "perceptual_ready",
    oracle_label: t.oracle_label ?? (t.baseline_id === "oracle" ? "Oracle-Sched" : null),
    oracle_demand_file: t.oracle_demand_file,
    oracle_demand_count: t.oracle_demand_count ?? audit.demandRef_length,
    oracle_visible_gt_count: t.oracle_visible_gt_count ?? audit.visibleSet_size,
    oracle_key_schema: t.oracle_key_schema,
    oracle_manifest_overlap_count: t.oracle_manifest_overlap_count,
    oracle_manifest_overlap_ratio: t.oracle_manifest_overlap_ratio,
    oracle_perceptual_boost_applied_count:
      t.oracle_visible_boost_count ?? audit.visible_boost_count,
    oracle_prefetch_candidate_count:
      t.oracle_prefetch_candidate_count ?? audit.candidate_count,
    oracle_prefetch_selected_count: t.oracle_selected_count ?? audit.selected_count,
    oracle_input_valid: t.oracle_input_valid,
    oracle_invalid_reason: t.oracle_invalid_reason,
    first_visible_splat_ms: t.first_visible_splat_ms,
    time_to_1M_visible_splats_ms: t.time_to_1M_visible_splats_ms,
    visible_splat_max: t.visible_splat_max,
    quality_at_5s: t.quality_at_5s,
    miss500: t.miss500 ?? t.deadline_miss_ratio_500ms,
    miss1000: t.miss1000 ?? t.deadline_miss_ratio_1000ms,
    cdp_rad_206_count: t.cdp_rad_206_count,
    throughput_cdp_session_mbps: t.throughput_cdp_session_mbps,
    measure_fps: t.measure_fps,
  };
}

export async function writeOracleInputAudit({ trials, batchDir = null }) {
  const oracleTrials = trials.filter(
    (t) => t.baseline_id === "oracle" || t.oracle_enabled === true,
  );
  const allBaselines = trials.filter((t) => t.hard_gate_passed !== false);

  const rows = [];
  for (const t of oracleTrials.length ? oracleTrials : allBaselines.filter((t) => t.baseline_id === "oracle")) {
    rows.push(trialOracleRow(t));
  }

  for (const t of allBaselines) {
    if (t.baseline_id === "oracle") continue;
    rows.push({
      phase: t.phase,
      delivery_role: t.delivery_role,
      method: t.baseline_name,
      oracle_enabled: false,
      oracle_input_valid: null,
      first_visible_splat_ms: t.first_visible_splat_ms,
      time_to_1M_visible_splats_ms: t.time_to_1M_visible_splats_ms,
      visible_splat_max: t.visible_splat_max,
      quality_at_5s: t.quality_at_5s,
      miss500: t.miss500 ?? t.deadline_miss_ratio_500ms,
      miss1000: t.miss1000 ?? t.deadline_miss_ratio_1000ms,
      cdp_rad_206_count: t.cdp_rad_206_count,
      throughput_cdp_session_mbps: t.throughput_cdp_session_mbps,
      measure_fps: t.measure_fps,
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    batch_dir: batchDir,
    oracle_trials: rows.filter((r) => r.oracle_enabled),
    comparison_rows: rows,
    schema_note:
      "Oracle-Sched = clairvoyant prefetch scheduling reference; not full-system QoE upper bound.",
  };

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "ORACLE_INPUT_AUDIT.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const md = formatOracleAuditMd(payload);
  await fs.writeFile(path.join(outDir, "ORACLE_INPUT_AUDIT.md"), md, "utf8");

  if (batchDir) {
    await fs.writeFile(path.join(batchDir, "ORACLE_INPUT_AUDIT.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(batchDir, "ORACLE_INPUT_AUDIT.md"), md, "utf8");
  }

  const csvPath = path.join(outDir, "ORACLE_COMPARISON.csv");
  await writeOracleComparisonCsv(rows, csvPath);
  if (batchDir) {
    await fs.writeFile(path.join(batchDir, "ORACLE_COMPARISON.csv"), await csvFromRows(rows), "utf8");
  }

  return { jsonPath, rows };
}

function formatOracleAuditMd(payload) {
  const lines = [
    "# Oracle Input Audit",
    "",
    `Generated: ${payload.generated_at}`,
    "",
    "Oracle is a **clairvoyant scheduling reference** (Oracle-Sched), not a full end-to-end QoE upper bound.",
    "",
    "## Oracle trials",
    "",
    "| phase | delivery | valid | demand | visible GT | boost | selected | reason |",
    "|-------|----------|-------|--------|------------|-------|----------|--------|",
  ];
  for (const r of payload.oracle_trials) {
    lines.push(
      `| ${r.phase} | ${r.delivery_role} | ${r.oracle_input_valid ? "YES" : "**NO**"} | ${r.oracle_demand_count ?? "—"} | ${r.oracle_visible_gt_count ?? "—"} | ${r.oracle_perceptual_boost_applied_count ?? "—"} | ${r.oracle_prefetch_selected_count ?? "—"} | ${r.oracle_invalid_reason ?? "—"} |`,
    );
  }
  lines.push(
    "",
    "## Rules",
    "",
    "- `oracle_input_valid=false` → do **not** call Oracle an upper bound in the paper.",
    "- READY is **not** required to beat Oracle.",
    "- Do not use Oracle first_visible alone to judge correctness.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function csvFromRows(rows) {
  const cols = [
    "phase",
    "delivery_role",
    "method",
    "oracle_input_valid",
    "oracle_demand_count",
    "oracle_visible_gt_count",
    "oracle_visible_boost_count",
    "first_visible_splat_ms",
    "time_to_1M_visible_splats_ms",
    "visible_splat_max",
    "quality_at_5s",
    "miss500",
    "miss1000",
    "cdp_rad_206_count",
    "throughput_cdp_session_mbps",
    "measure_fps",
  ];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(",")),
  ].join("\n");
}

async function writeOracleComparisonCsv(rows, csvPath) {
  await fs.writeFile(csvPath, await csvFromRows(rows), "utf8");
}
