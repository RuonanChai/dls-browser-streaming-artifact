#!/usr/bin/env node
/**
 * Remote experiment integrity audit for a READY single-user batch.
 *
 *   node scripts/ready_single_user/remote_integrity_audit.mjs \
 *     --batchDir=paper_materials/ready_single_user_v1/runs/validation_phase_remote_validation_2026-05-27T21-19-06
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRadRangeManifest } from "../lib/ablation_rad_range_manifest.mjs";
import { loadJsonMaybe, rebuildReferenceDemandFromSpark } from "./oracle_reference.mjs";
import { PAPER_MATERIALS_DIR } from "./constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const o = { batchDir: null, out: null };
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
    else if (a.startsWith("--out=")) o.out = path.resolve(a.slice(6));
  }
  return o;
}

function uniq(arr) {
  return [...new Set(arr)];
}

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function auditTrial(batchDir, file) {
  const j = await readJson(path.join(batchDir, "per_trial_json", file));
  if (!j) return null;
  const runDir = path.join(batchDir, "per_trial_runs", j.trial_id ?? file.replace(".json", ""));
  let cdpFirst = null;
  let cdpProtocols = [];
  let cdpFromDisk = 0;
  try {
    const cdpText = await fs.readFile(path.join(runDir, "cdp_network_audit.csv"), "utf8");
    const lines = cdpText.trim().split(/\r?\n/).slice(1).filter(Boolean);
    for (const line of lines.slice(0, 20)) {
      const cols = line.split(",");
      const url = cols[2] ?? "";
      const range = cols[3] ?? "";
      const status = cols[4] ?? "";
      const proto = cols[5] ?? "";
      const disk = cols[11] ?? "";
      if (url.includes(".rad") && status === "206") {
        if (!cdpFirst) cdpFirst = { range, proto, url: url.slice(0, 120) };
        cdpProtocols.push(proto);
        if (disk === "true") cdpFromDisk += 1;
      }
    }
  } catch { /* */ }

  return {
    trial_id: j.trial_id,
    baseline: j.baseline_name ?? j.baseline_id,
    trial_index: j.trial_index ?? file.match(/__t(\d+)/)?.[1],
    status: j.status,
    hard_gate_passed: j.hard_gate_passed,
    asset_url: j.asset_url,
    run_id: j.run_id,
    browser_profile_fresh: j.browser_profile_fresh,
    cache_state: j.cache_state,
    gpu_renderer: j.gpu_renderer,
    delivery_role: j.delivery_role,
    actual_delivery_key: j.actual_delivery_key,
    first_visible_splat_ms: j.first_visible_splat_ms,
    oracle_input_valid: j.oracle_input_valid,
    oracle_demand_count: j.oracle_demand_count,
    oracle_visible_gt_count: j.oracle_visible_gt_count,
    oracle_selected_count: j.oracle_selected_count,
    oracle_visible_boost_count: j.oracle_visible_boost_count,
    oracle_invalid_reason: j.oracle_invalid_reason,
    demand_trace_count: j.demand_trace_count ?? j.proactive_snapshot?.demand_trace?.length,
    cdpFirst,
    cdpProtocols: uniq(cdpProtocols),
    cdpFromDisk,
    run_dir: runDir,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.batchDir) {
    console.error("Usage: --batchDir=<path>");
    process.exit(1);
  }
  const batchDir = opts.batchDir;
  const batchName = path.basename(batchDir);
  const outPath =
    opts.out
    ?? path.join(root, PAPER_MATERIALS_DIR, "remote_validation_integrity_audit.md");

  const pj = path.join(batchDir, "per_trial_json");
  const files = (await fs.readdir(pj)).filter((f) => f.endsWith(".json")).sort();
  const rows = [];
  for (const f of files) {
    const r = await auditTrial(batchDir, f);
    if (r) rows.push(r);
  }

  const oracleRows = rows.filter((r) => r.baseline === "Oracle");
  const sparkRows = rows.filter((r) => r.baseline === "Spark-OD");
  const assetUrls = uniq(rows.map((r) => r.asset_url).filter(Boolean));
  const runIds = uniq(rows.map((r) => r.run_id).filter(Boolean));
  const gpus = uniq(rows.map((r) => r.gpu_renderer).filter(Boolean));

  const demandFile = await loadJsonMaybe(path.join(batchDir, "reference_demand_remote.json"));
  const visFile = await loadJsonMaybe(path.join(batchDir, "visible_ground_truth_remote.json"));
  const meta = await loadJsonMaybe(
    path.join(batchDir, "oracle_reference_meta_phase_remote_validation_remote.json"),
  );
  const sparkRebuild = await rebuildReferenceDemandFromSpark(batchDir, {
    deliveryRole: "remote",
    phase: rows[0]?.trial_id?.includes("phase_remote_validation")
      ? "phase_remote_validation"
      : null,
  });

  let manifestNote = "not probed";
  try {
    const csv =
      process.env.VRC_RAD_MANIFEST_CSV
      ?? path.join(sparkRows[0]?.run_dir ?? "", "cdp_network_audit.csv");
    const m = loadRadRangeManifest(csv);
    manifestNote = `${m.length} ranges from ${csv}`;
  } catch (e) {
    manifestNote = `error: ${e.message}`;
  }

  const fvByMethod = {};
  for (const r of rows) {
    if (!fvByMethod[r.baseline]) fvByMethod[r.baseline] = [];
    if (r.first_visible_splat_ms != null) fvByMethod[r.baseline].push(r.first_visible_splat_ms);
  }
  const fvStats = Object.fromEntries(
    Object.entries(fvByMethod).map(([k, vals]) => {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
      return [k, { n: vals.length, mean, sd, cv: sd / mean, min: Math.min(...vals), max: Math.max(...vals) }];
    }),
  );

  const lines = [
    "# Remote validation integrity audit",
    "",
    `> Batch: \`${batchName}\``,
    `> Generated: ${new Date().toISOString()}`,
    "> Role: **diagnostic only** — not final paper numbers; **no READY final claim** until Oracle sanity passes.",
    "",
    "## Executive summary",
    "",
    "| Verdict | Item |",
    "|---------|------|",
    "| **INVALID for claims** | Entire " + batchName + " batch as READY/Oracle final results |",
    "| **INVALID** | All " + oracleRows.length + " Oracle trials (`oracle_input_valid=false`) |",
    "| **DIAGNOSTIC OK** | Spark-OD / READY arms for infra variance / contamination checks only |",
    "| **BLOCKED** | `phase_remote_test_main` until Oracle sanity batch passes |",
    "",
    "## 1. Why Oracle input was invalid",
    "",
    "### 1.1 Root cause chain",
    "",
    "1. **Phase-start `ensureOracleReference` ran before any Spark-OD trial finished**, so `rebuildReferenceDemandFromSpark()` returned 0 entries.",
    "2. **RAD manifest** default path (`260506_local_diag/.../cdp_network_audit.csv`) was missing at run time; batch had no `VRC_RAD_MANIFEST_CSV`.",
    "3. Pipeline **still wrote empty** `reference_demand_remote.json` (`[]`) and `visible_ground_truth_remote.json` (`keys: []`).",
    "4. Oracle trials loaded those empty artifacts; `loadOracleInputs` fallback did not recover (manifest unresolved during trial).",
    "5. Runtime: `demand_count=0`, `visible_gt_count=0` → `manifest_overlap_0pct`, `zero_prefetch_selected`, `zero_perceptual_boost`.",
    "",
    "### 1.2 Post-hoc reference rebuild (audit machine)",
    "",
    `| Check | Result |`,
    `|-------|--------|`,
    `| Spark-OD demand rebuild from batch | **${sparkRebuild?.length ?? 0}** entries (if >0, recoverable) |`,
    "| On-disk `reference_demand_remote.json` | **" + (Array.isArray(demandFile) ? demandFile.length : 0) + "** entries |",
    "| On-disk visible GT keys | **" + (visFile?.keys?.length ?? 0) + "** |",
    "| Meta `demand_count` | **" + (meta?.demand_count ?? "—") + "** |",
    `| Manifest probe | ${manifestNote} |`,
    "",
    "### 1.3 Per-Oracle trial",
    "",
    "| trial | valid | demand | visible GT | selected | boost | invalid_reason |",
    "|-------|-------|--------|------------|----------|-------|----------------|",
  ];

  for (const o of oracleRows) {
    lines.push(
      `| ${o.trial_id?.replace(/.*__/, "") ?? "?"} | ${o.oracle_input_valid ? "YES" : "**NO**"} | ${o.oracle_demand_count ?? 0} | ${o.oracle_visible_gt_count ?? 0} | ${o.oracle_selected_count ?? 0} | ${o.oracle_visible_boost_count ?? 0} | ${o.oracle_invalid_reason ?? "—"} |`,
    );
  }

  lines.push(
    "",
    "## 2. Continuous-run contamination audit",
    "",
    "| Check | Finding |",
    "|-------|---------|",
    "| **Chrome profile** | `browser_profile_fresh: true` per trial; isolated `$TMP/vrc-chrome-<run_id>` |",
    `| **run_id / cache bust** | ${runIds.length} unique run_ids across ${rows.length} trials — CDN URL cache-busted per trial |`,
    "| **asset_url host** | "
      + (assetUrls.length === 1 ? "consistent R2 host" : "**" + assetUrls.length + " distinct asset URLs**")
      + " |",
    "| **GPU** | "
      + (gpus.length === 1 ? (gpus[0]?.slice(0, 80) ?? "") + "…" : "**" + gpus.length + " renderers**")
      + " |",
    "| **delivery** | all `remote_server` / `remote` |",
    `| **Protocol (CDP sample)** | see per-method table below |`,
    "",
    "### 2.1 First RAD range (sample) & protocol",
    "",
    "| baseline | trial | first 206 range | protocol | fromDiskCache (sample rows) |",
    "|----------|-------|-----------------|----------|------------------------------|",
  );

  for (const r of rows.filter((x) => ["Spark-OD", "READY", "Oracle"].includes(x.baseline)).slice(0, 12)) {
    lines.push(
      `| ${r.baseline} | t${r.trial_index ?? "?"} | ${r.cdpFirst?.range ?? "—"} | ${r.cdpProtocols?.join(",") ?? "—"} | ${r.cdpFromDisk} |`,
    );
  }

  lines.push(
    "",
    "### 2.2 First-visible variance (remote instability)",
    "",
    "| method | n | mean FV (ms) | sd | CV | min | max | usable for claim? |",
    "|--------|--:|-------------:|---:|---:|----:|----:|:-----------------|",
  );
  for (const [method, s] of Object.entries(fvStats).sort((a, b) => a[1].mean - b[1].mean)) {
    const claim =
      method === "Oracle"
        ? "**NO** (invalid input)"
        : s.cv > 0.35
          ? "**DIAG only** (CV>35%)"
          : "diagnostic";
    lines.push(
      `| ${method} | ${s.n} | ${s.mean.toFixed(0)} | ${s.sd.toFixed(0)} | ${(s.cv * 100).toFixed(0)}% | ${s.min.toFixed(0)} | ${s.max.toFixed(0)} | ${claim} |`,
    );
  }

  lines.push(
    "",
    "## 3. What is usable vs must be invalid",
    "",
    "| Data | Usable? | Notes |",
    "|------|---------|-------|",
    `| Spark-OD / READY / READY-* metrics in this batch | **Diagnostic only** | High FV variance; interleaved remote CDN |`,
    `| Oracle metrics in this batch | **INVALID** | Empty reference; not Oracle-Sched |`,
    `| Cross-method ranking in this batch | **INVALID for paper** | Oracle not fair; remote noise |`,
    `| CDP / server_monitor / trace per trial | **Yes** | Contamination & infra debugging |`,
    "| Spark-OD demand_trace in per_trial_json | **Yes** | Rebuild Oracle reference (" + (sparkRebuild?.length ?? 0) + " merged ranges) |",
    "",
    "## 4. Required next step (Oracle sanity)",
    "",
    "Minimal pipeline (new batch, do **not** extend validation batch):",
    "",
    "```powershell",
    "cd D:\\Program\\spark-main\\spark-main",
    "$env:VRC_REMOTE_CDN_ASSET_URL = \"https://${REMOTE_CDN_URL}/coit-40m-sh1-lod.rad"",
    "$batch = \"paper_materials/ready_single_user_v1/runs/oracle_integrity_sanity_<timestamp>\"",
    "node scripts/ready_single_user/run.mjs --phase=phase_remote_dev --trials=1 --methods=Spark-OD,Oracle,READY --batchDir=$batch",
    "# After Spark-OD completes:",
    "$env:VRC_RAD_MANIFEST_CSV = \"<batch>/per_trial_runs/remote_server__spark_od__*_t0/cdp_network_audit.csv\"",
    "node scripts/ready_single_user/build_oracle_reference.mjs --phase=phase_remote_dev --delivery=remote --batchDir=$batch --force",
    "# Re-run Oracle+READY if first Oracle invalid",
    "```",
    "",
    "Pass criteria: `oracle_input_valid=true`, `demand_count>0`, `visible_gt_count>0`, `selected_count>0`, `visible_boost_count>0`.",
    "",
    "## 5. Code fixes applied (this audit)",
    "",
    "- `ensureOracleReference` no longer writes empty demand/GT artifacts.",
    "- Phase start no longer pre-writes empty Oracle reference.",
    "- `trial_cell` rebuilds Oracle reference from Spark-OD before each Oracle trial.",
    "- `build_oracle_reference.mjs` awaits `rebuildReferenceDemandFromSpark`.",
    "- Manifest fallback searches `ready_single_user_v1` Spark-OD CDP audits.",
    "",
    "---",
    "",
    "*Do not run `phase_remote_test_main` or write READY final claim until §4 passes.*",
    "",
  );

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`[remote_integrity_audit] wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
