#!/usr/bin/env node
/**
 * Minimal Oracle integrity sanity (sequential, not interleaved):
 *   Spark-OD×1 → buildOracleRef → Oracle×1 → READY×1
 *
 *   node scripts/ready_single_user/oracle_sanity_run.mjs
 *   node scripts/ready_single_user/oracle_sanity_run.mjs --batchDir=<existing>
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { PAPER_MATERIALS_DIR } from "./constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const node = process.execPath;

function parseArgs(argv) {
  const o = { batchDir: null, phase: "phase_remote_dev" };
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
    else if (a.startsWith("--phase=")) o.phase = a.slice(8);
  }
  return o;
}

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n[oracle_sanity] $ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let batchDir = opts.batchDir;
  if (!batchDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    batchDir = path.join(root, PAPER_MATERIALS_DIR, "runs", `oracle_integrity_sanity_${ts}`);
  }
  await fs.mkdir(batchDir, { recursive: true });
  await fs.mkdir(path.join(batchDir, "per_trial_json"), { recursive: true });

  const common = [
    "scripts/ready_single_user/run.mjs",
    `--phase=${opts.phase}`,
    "--trials=1",
    `--batchDir=${batchDir}`,
  ];

  await run(node, [...common, "--methods=Spark-OD"]);
  await run(node, [
    "scripts/ready_single_user/build_oracle_reference.mjs",
    `--phase=${opts.phase}`,
    "--delivery=remote",
    `--batchDir=${batchDir}`,
    "--force",
  ]);
  await run(node, [...common, "--resume", "--methods=Oracle,READY"]);

  console.log(`\n[oracle_sanity] Done. batchDir=${batchDir}`);
  console.log(
    `Verify: node scripts/ready_single_user/analyze.mjs --batchDir=${batchDir} --phase=${opts.phase}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
