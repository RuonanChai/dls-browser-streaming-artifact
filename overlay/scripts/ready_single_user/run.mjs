#!/usr/bin/env node
/**
 * READY single-user paper runner.
 *
 *   node scripts/ready_single_user/run.mjs --phase=phase_edge_cold --trials=1
 *   node scripts/ready_single_user/run.mjs --phase=phase_edge_warm_ready --resume
 */
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMatrix, resolveDelivery } from "./delivery.mjs";
import { expandTrials, trialId } from "./matrix.mjs";
import { runVrcTrial } from "./trial_cell.mjs";
import { cleanupStaleAblationProcesses } from "../lib/local_stutter_ablation_cell.mjs";
import { evaluatePhaseASanity, writeBlockerReport } from "./gates.mjs";
import { PAPER_MATERIALS_DIR, PHASE_ALIASES } from "./constants.mjs";
import { normalizeDeliveryKey } from "./delivery_metadata.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PHASE_ORDER = [
  "phase_delivery_compare",
  "phase_local_ceiling",
  "phase_edge_cold",
  "phase_edge_warm_ready",
  "phase_ready_ablation_on_edge",
  "phase_remote_direct",
  "phase_remote_direct_cold",
  "phase_remote_warm_equal",
  "phase_remote_dev",
  "phase_remote_validation",
  "phase_remote_test_main",
];

function warnDeprecatedPhase(requested) {
  const alias = PHASE_ALIASES[requested];
  if (alias && alias !== requested) {
    console.warn(
      `[vrc-su] WARNING: ${requested} is deprecated; use ${alias}. `
      + "origin_server is now treated as edge_server (LAN edge).",
    );
  } else if (requested === "origin_server" || requested.includes("origin")) {
    console.warn(
      "[vrc-su] WARNING: origin_server is deprecated; use edge / edge_server (LAN edge).",
    );
  }
}

function parseArgs(argv) {
  const o = {
    phase: "phase_edge_cold",
    batchDir: null,
    resume: false,
    autonomous: false,
    maxRetries: 2,
    trialsPerBaseline: null,
    methods: null,
  };
  for (const a of argv) {
    if (a.startsWith("--phase=")) o.phase = a.slice(8);
    else if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
    else if (a === "--resume") o.resume = true;
    else if (a === "--autonomous") o.autonomous = true;
    else if (a.startsWith("--maxRetries=")) o.maxRetries = Number(a.slice(13)) || 2;
    else if (a.startsWith("--trials=")) o.trialsPerBaseline = Number(a.slice(9)) || 1;
    else if (a.startsWith("--methods=")) {
      o.methods = a
        .slice(10)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return o;
}

const METHOD_NAME_TO_ID = {
  "spark-od": "spark_od",
  spark_od: "spark_od",
  "naive-pf": "naive_pf",
  naive_pf: "naive_pf",
  "ready-b": "ready_b",
  ready_b: "ready_b",
  "ready-p": "ready_p",
  ready_p: "ready_p",
  "ready-c": "ready_c",
  ready_c: "ready_c",
  "ready-r": "ready_r",
  ready_r: "ready_r",
  "ready-s": "ready_s",
  ready_s: "ready_s",
  oracle: "oracle",
  ready: "ready",
  "ready-e": "ready_e",
  ready_e: "ready_e",
  "ready-g": "ready_g",
  ready_g: "ready_g",
  progs: "progs",
  sgss: "sgss",
  // DLS paper baselines
  dls: "dls",
  "dls-l": "dls_l",
  dls_l: "dls_l",
  "dls-a": "dls_a",
  dls_a: "dls_a",
  "seq-p": "seq_pf",
  seq_pf: "seq_pf",
  "view-p": "view_pf",
  view_pf: "view_pf",
  "dec-a": "dec_ahead",
  dec_ahead: "dec_ahead",
  "range-f": "range_fuse",
  range_fuse: "range_fuse",
};

async function curlCheck(url) {
  if (!url) return { ok: true, snippet: "local_skip" };
  const r = spawnSync(
    "curl.exe",
    ["-sI", "--connect-timeout", "12", "-H", "Range: bytes=0-1023", url],
    { encoding: "utf8", windowsHide: true },
  );
  const out = (r.stdout || "") + (r.stderr || "");
  return { ok: /206|200/.test(out), snippet: out.split("\n")[0] };
}

async function loadManifest(batchDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(batchDir, "manifest.json"), "utf8"));
  } catch {
    return { trials: [] };
  }
}

async function saveManifest(batchDir, manifest) {
  manifest.updated_at = new Date().toISOString();
  await fs.writeFile(path.join(batchDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function ensureBatchDir(opts) {
  let batchDir = opts.batchDir;
  if (!batchDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    batchDir = path.join(root, PAPER_MATERIALS_DIR, "runs", ts);
  }
  await fs.mkdir(path.join(batchDir, "per_trial_json"), { recursive: true });
  await fs.mkdir(path.join(batchDir, "per_trial_runs"), { recursive: true });
  await fs.mkdir(path.join(batchDir, "config"), { recursive: true });
  await fs.copyFile(
    path.join(root, "config", "ready_single_user", "experiment_matrix.json"),
    path.join(batchDir, "config", "experiment_matrix.json"),
  );
  return batchDir;
}

async function buildManifestTrials(matrix, phases, existing = [], opts = {}) {
  const byKey = new Map(existing.map((t) => [trialId(t), t]));
  for (const phaseName of phases) {
    warnDeprecatedPhase(phaseName);
    for (const desc of expandTrials(matrix, phaseName, {
      trialsPerBaseline: opts.trialsPerBaseline,
    })) {
      const key = trialId(desc);
      if (!byKey.has(key)) {
        byKey.set(key, { ...desc, status: "pending", trial_key: key, attempts: 0 });
      }
    }
  }
  return [...byKey.values()];
}

async function runPhaseTrials({ batchDir, manifest, matrix, opts, phaseFilter }) {
  let portOff = 0;
  const serverSummaries = [];

  await cleanupStaleAblationProcesses();

  const phaseCfg = matrix.phases?.[phaseFilter];
  if (phaseFilter && phaseCfg && phaseCfg.delivery) {
    const deliveryKey = phaseCfg.delivery === "remote" ? "remote_server"
      : phaseCfg.delivery === "remote_gcs" ? "remote_gcs"
      : phaseCfg.delivery === "remote_cos" ? "remote_cos"
      : `${phaseCfg.delivery}_server`;
    const delivery = await resolveDelivery(deliveryKey, matrix);
    const hasOracle = manifest.trials.some(
      (t) => t.phase === phaseFilter && (t.baseline_id === "oracle" || t.baseline_name === "Oracle"),
    );
    const hasSpark = manifest.trials.some(
      (t) => t.phase === phaseFilter && t.baseline_id === "spark_od",
    );
    if (hasOracle) {
      console.warn(
        "[vrc-su] Oracle reference is built after Spark-OD trials in batch (trial_cell). "
        + "Skipping empty pre-flight reference write.",
      );
    }
    if (hasOracle && !hasSpark) {
      console.warn(
        "[vrc-su] Oracle trials scheduled without Spark-OD in manifest — "
        + "reference demand may be synthetic. Add Spark-OD for auditable demand trace.",
      );
    }
  }

  for (const desc of manifest.trials) {
    if (phaseFilter && desc.phase !== phaseFilter) continue;
    if (desc.status === "completed" && desc.hard_gate_passed) continue;

    const tid = trialId(desc);
    desc.attempts = desc.attempts || 0;
    const requestedKey = desc.delivery_key;

    while (desc.attempts <= opts.maxRetries) {
      desc.attempts += 1;
      console.log(
        `\n[vrc-su] === ${tid} attempt ${desc.attempts} `
        + `(delivery_role=${desc.delivery_role ?? "?"}) ===`,
      );
      desc.status = "running";
      await saveManifest(batchDir, manifest);

      try {
        let actualKey = desc.delivery_key;
        let delivery = await resolveDelivery(actualKey, matrix);
        const curl = await curlCheck(delivery.curl_check_url);

        if (!curl.ok && delivery.curl_check_url) {
          const role = delivery.delivery_role;
          if (delivery.no_fallback || role === "remote") {
            throw new Error(
              `Remote delivery unreachable (no fallback to edge/local): ${delivery.curl_check_url}`,
            );
          }
          if (role === "edge") {
            console.warn("[vrc-su] LAN edge unreachable, falling back to local_disk");
            actualKey = "local_disk";
            delivery = await resolveDelivery(actualKey, matrix);
          } else {
            throw new Error(`curl failed: ${delivery.curl_check_url}`);
          }
        }

        desc.actual_delivery_key = actualKey;
        const refRole = normalizeDeliveryKey(actualKey).delivery_role;
        const refPath = path.join(batchDir, `reference_demand_${refRole}.json`);

        const { trialJson, gate, serverSummary } = await runVrcTrial({
          batchDir,
          desc: { ...desc, delivery_key: actualKey },
          delivery,
          requestedDeliveryKey: requestedKey,
          referenceDemandPath: refPath,
          assetPortOffset: portOff++,
          matrix,
        });

        if (serverSummary) serverSummaries.push(serverSummary);
        desc.status = trialJson.status;
        desc.hard_gate_passed = gate.passed;
        desc.trial_json = path.join(batchDir, "per_trial_json", `${tid}.json`);

        if (gate.passed) {
          console.log(
            `[vrc-su] PASS ${trialJson.baseline_name} `
            + `role=${trialJson.delivery_role} miss100=${((trialJson.miss100 || 0) * 100).toFixed(1)}% `
            + `useful=${trialJson.useful_chunks_before_demand}`,
          );
          break;
        }
        if (desc.attempts > opts.maxRetries) {
          console.error(`[vrc-su] FAIL ${tid}: ${gate.failures.join("; ")}`);
        }
      } catch (e) {
        console.error(`[vrc-su] ERROR ${tid}:`, e?.message || e);
        if (desc.attempts > opts.maxRetries) desc.status = "failed";
      }
    }
    await saveManifest(batchDir, manifest);
  }

  return serverSummaries;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const matrix = await loadMatrix();
  const batchDir = await ensureBatchDir(opts);

  const phaseRequested = opts.phase;
  warnDeprecatedPhase(phaseRequested);
  const phases = opts.autonomous ? PHASE_ORDER : [phaseRequested];

  let manifest = await loadManifest(batchDir);
  manifest.trials = await buildManifestTrials(matrix, phases, manifest.trials ?? [], opts);
  if (opts.methods?.length) {
    const allow = new Set(
      opts.methods.map((m) => METHOD_NAME_TO_ID[m.toLowerCase()] ?? m),
    );
    manifest.trials = manifest.trials.filter((t) => allow.has(t.baseline_id));
    console.log(`[vrc-su] Filtered to methods: ${[...allow].join(", ")}`);
  }
  manifest.batch_dir = batchDir;
  await saveManifest(batchDir, manifest);

  for (const phase of phases) {
    console.log(`\n[vrc-su] >>> Phase ${phase}`);
    await runPhaseTrials({
      batchDir,
      manifest,
      matrix,
      opts,
      phaseFilter: phase,
    });
  }

  console.log(`\n[vrc-su] Done. batchDir=${batchDir}`);
  console.log(`Run: node scripts/ready_single_user/analyze.mjs --batchDir=${batchDir} --phase=all`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
