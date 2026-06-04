#!/usr/bin/env node
/**
 * DLS evaluation runner.
 *   node scripts/ready_single_user/run.mjs --phase=dls-main-burst-cos-n5 --trials=5
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMatrix, resolveDelivery } from "./delivery.mjs";
import { expandTrials, trialId } from "./matrix.mjs";
import { runVrcTrial } from "./trial_cell.mjs";
import { cleanupStaleAblationProcesses } from "../lib/local_stutter_ablation_cell.mjs";
import { PAPER_MATERIALS_DIR, PHASE_ALIASES, DLS_PHASE_ORDER } from "./constants.mjs";
import { normalizeDeliveryKey } from "./delivery_metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const METHOD_NAME_TO_ID = {
  spark_od: "spark_od",
  "spark-od": "spark_od",
  dls: "dls",
  dls_l: "dls_l",
  "dls-l": "dls_l",
  dls_a: "dls_a",
  "dls-a": "dls_a",
};

function warnDeprecatedPhase(requested) {
  const alias = PHASE_ALIASES[requested];
  if (alias && alias !== requested) {
    console.warn(`[dls] phase alias: ${requested} -> ${alias}`);
  }
}

function parseArgs(argv) {
  const o = {
    phase: "dls-main-burst-cos-n5",
    batchDir: null,
    maxRetries: 2,
    trialsPerBaseline: null,
    methods: null,
  };
  for (const a of argv) {
    if (a.startsWith("--phase=")) o.phase = a.slice(8);
    else if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
    else if (a.startsWith("--maxRetries=")) o.maxRetries = Number(a.slice(13)) || 2;
    else if (a.startsWith("--trials=")) o.trialsPerBaseline = Number(a.slice(9)) || 1;
    else if (a.startsWith("--methods=")) {
      o.methods = a.slice(10).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return o;
}

async function curlCheck(url) {
  if (!url) return { ok: true };
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("curl", ["-sfI", "-m", "15", url], { encoding: "utf8" });
    return { ok: r.status === 0, stderr: r.stderr };
  } catch (e) {
    return { ok: false, stderr: String(e) };
  }
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

async function ensureBatchDir(opts, phaseName) {
  let batchDir = opts.batchDir;
  if (!batchDir) {
    batchDir = path.join(root, PAPER_MATERIALS_DIR, "runs", phaseName);
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

async function buildManifestTrials(matrix, phaseName, existing = [], opts = {}) {
  const byKey = new Map(existing.map((t) => [trialId(t), t]));
  const resolvedPhase = PHASE_ALIASES[phaseName] ?? phaseName;
  for (const desc of expandTrials(matrix, resolvedPhase, { trialsPerBaseline: opts.trialsPerBaseline })) {
    const key = trialId(desc);
    if (!byKey.has(key)) {
      byKey.set(key, { ...desc, status: "pending", trial_key: key, attempts: 0 });
    }
  }
  return [...byKey.values()];
}

async function runPhaseTrials({ batchDir, manifest, matrix, opts, phaseFilter }) {
  let portOff = 0;
  await cleanupStaleAblationProcesses();

  for (const desc of manifest.trials) {
    if (phaseFilter && desc.phase !== phaseFilter && desc.phase !== (PHASE_ALIASES[phaseFilter] ?? phaseFilter)) continue;
    if (desc.status === "completed" && desc.hard_gate_passed) continue;

    const tid = trialId(desc);
    desc.attempts = desc.attempts || 0;
    const requestedKey = desc.delivery_key;

    while (desc.attempts <= opts.maxRetries) {
      desc.attempts += 1;
      console.log(`\n[dls] === ${tid} attempt ${desc.attempts} ===`);
      desc.status = "running";
      await saveManifest(batchDir, manifest);

      try {
        let actualKey = desc.delivery_key;
        let delivery = await resolveDelivery(actualKey, matrix);
        const curl = await curlCheck(delivery.curl_check_url);
        if (!curl.ok && delivery.curl_check_url) {
          if (delivery.no_fallback) {
            throw new Error(`Remote delivery unreachable: ${delivery.curl_check_url}`);
          }
          console.warn("[dls] edge unreachable, falling back to local_disk");
          actualKey = "local_disk";
          delivery = await resolveDelivery(actualKey, matrix);
        }

        desc.actual_delivery_key = actualKey;
        const { trialJson, gate } = await runVrcTrial({
          batchDir,
          desc: { ...desc, delivery_key: actualKey },
          delivery,
          requestedDeliveryKey: requestedKey,
          assetPortOffset: portOff++,
          matrix,
        });

        desc.status = trialJson.status;
        desc.hard_gate_passed = gate.passed;
        desc.trial_json = path.join(batchDir, "per_trial_json", `${tid}.json`);
        if (gate.passed) {
          console.log(`[dls] PASS ${trialJson.baseline_name} FV=${trialJson.first_visible_splat_ms}ms`);
          break;
        }
        if (desc.attempts > opts.maxRetries) {
          console.error(`[dls] FAIL ${tid}: ${gate.failures.join("; ")}`);
        }
      } catch (e) {
        console.error(`[dls] ERROR ${tid}:`, e?.message || e);
        if (desc.attempts > opts.maxRetries) desc.status = "failed";
      }
    }
    await saveManifest(batchDir, manifest);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  warnDeprecatedPhase(opts.phase);
  const phaseName = PHASE_ALIASES[opts.phase] ?? opts.phase;
  const matrix = await loadMatrix();
  const batchDir = await ensureBatchDir(opts, phaseName);

  let manifest = await loadManifest(batchDir);
  manifest.trials = await buildManifestTrials(matrix, phaseName, manifest.trials ?? [], opts);
  if (opts.methods?.length) {
    const allow = new Set(opts.methods.map((m) => METHOD_NAME_TO_ID[m.toLowerCase()] ?? m));
    manifest.trials = manifest.trials.filter((t) => allow.has(t.baseline_id));
  }
  manifest.batch_dir = batchDir;
  await saveManifest(batchDir, manifest);

  console.log(`\n[dls] >>> Phase ${phaseName}`);
  await runPhaseTrials({ batchDir, manifest, matrix, opts, phaseFilter: phaseName });

  console.log(`\n[dls] Done. batchDir=${batchDir}`);
  console.log(`Analyze: node scripts/ready_single_user/analyze.mjs --batchDir=${batchDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
