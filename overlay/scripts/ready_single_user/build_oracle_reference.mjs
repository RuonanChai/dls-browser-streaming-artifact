#!/usr/bin/env node
/**
 * Build reference_demand + visible_ground_truth for Oracle trials.
 *
 *   node scripts/ready_single_user/build_oracle_reference.mjs --phase=phase_remote_dev --delivery=remote
 *   node scripts/ready_single_user/build_oracle_reference.mjs --batchDir=<batch> --phase=phase_remote_dev
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMatrix, resolveDelivery } from "./delivery.mjs";
import {
  ensureOracleReference,
  rebuildReferenceDemandFromSpark,
  oraclePaths,
} from "./oracle_reference.mjs";
import { PAPER_MATERIALS_DIR } from "./constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const o = {
    phase: "phase_remote_dev",
    delivery: "remote",
    batchDir: null,
    force: false,
  };
  for (const a of argv) {
    if (a.startsWith("--phase=")) o.phase = a.slice(8);
    else if (a.startsWith("--delivery=")) o.delivery = a.slice(11);
    else if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
    else if (a === "--force") o.force = true;
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const matrix = await loadMatrix();
  const phaseCfg = matrix.phases?.[opts.phase] ?? {};
  const deliveryKey = phaseCfg.delivery === "remote" ? "remote_server" : `${opts.delivery}_server`;
  const delivery = await resolveDelivery(deliveryKey, matrix);

  let batchDir = opts.batchDir;
  if (!batchDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    batchDir = path.join(root, PAPER_MATERIALS_DIR, "runs", `oracle_ref_${opts.phase}_${ts}`);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(batchDir, { recursive: true }),
    );
  }

  const sparkOnly = await rebuildReferenceDemandFromSpark(batchDir, {
    deliveryRole: delivery.delivery_role,
    deliveryKey,
    phase: opts.phase,
  });
  if (sparkOnly?.length) {
    console.log(`[build_oracle_reference] Found ${sparkOnly.length} demand entries from Spark-OD in batch`);
  } else {
    console.warn(
      "[build_oracle_reference] No Spark-OD demand in batch — will use manifest synthetic demand. "
      + "Run Spark-OD reference pass first for best results.",
    );
  }

  const result = await ensureOracleReference(batchDir, {
    phase: opts.phase,
    deliveryRole: delivery.delivery_role,
    deliveryKey,
    assetUrl: delivery.asset_url,
    force: opts.force,
  });

  const paths = oraclePaths(batchDir, { phase: opts.phase, deliveryRole: delivery.delivery_role });
  console.log(`[build_oracle_reference] batchDir=${batchDir}`);
  console.log(`  demand: ${paths.demandByRole} (${result.demand?.length ?? 0} entries)`);
  console.log(`  visible: ${paths.visibleByRole} (${result.visibleKeys?.length ?? 0} keys)`);
  console.log(`  rebuilt=${result.rebuilt}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
