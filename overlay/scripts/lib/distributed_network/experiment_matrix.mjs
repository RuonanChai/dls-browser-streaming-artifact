import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORMAL_ARMS } from "./constants.mjs";
import { resolveTrialTiming } from "./scenario_timing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");

export async function loadExperimentMatrix(nameOrPath) {
  const p = nameOrPath.includes("/") || nameOrPath.includes("\\")
    ? nameOrPath
    : path.join(projectRoot, "config", "distributed_network", `experiment_matrix.${nameOrPath}.json`);
  return JSON.parse(await fs.readFile(p, "utf8"));
}

function scenarioClientCount(scenario) {
  if (scenario === "single_user") return 1;
  if (/4users/.test(scenario)) return 4;
  return 1;
}

/**
 * Expand matrix into flat trial descriptors (single-worker: runs clients sequentially).
 */
export function expandExperimentMatrix(matrix) {
  const trials = [];
  const reduced = matrix.reduced_matrix?.enabled;

  for (const profile of matrix.profiles) {
    for (const scenario of matrix.scenarios) {
      const clientCount = scenarioClientCount(scenario);
      let arms = [...matrix.arms];
      let trialsPer = matrix.trials_per_condition ?? 1;

      if (reduced && scenario !== "single_user") {
        arms = matrix.reduced_matrix.multi_user_arms ?? arms.filter((a) =>
          ["E3_normal_streaming", "E5_fetch_only"].includes(a),
        );
        trialsPer = matrix.reduced_matrix.multi_user_trials_per_condition ?? trialsPer;
      }

      for (const armId of arms) {
        if (!FORMAL_ARMS[armId]) continue;
        const armDef = FORMAL_ARMS[armId];
        const modes =
          matrix.measurement_modes?.length > 0
            ? matrix.measurement_modes.filter((m) => {
                if (armDef.defaultMeasurementMode === "warm_steady_render_mode") {
                  return m === "warm_steady_render_mode";
                }
                return m === "streaming_in_loop_mode";
              })
            : [armDef.defaultMeasurementMode];

        for (const measurementMode of modes) {
          for (let trialIndex = 0; trialIndex < trialsPer; trialIndex++) {
            for (let clientIdx = 0; clientIdx < clientCount; clientIdx++) {
              const timing = resolveTrialTiming(matrix, scenario);
              trials.push({
                delivery_profile: profile,
                scenario,
                arm_id: armId,
                measurement_mode: measurementMode,
                trial_index: trialIndex,
                client_id: `c${clientIdx}`,
                client_count: clientCount,
                startup_mode: timing.startup_mode,
                warmup_ms: timing.warmup_ms,
                move_ms: timing.move_ms,
                timeout_ms: matrix.timeout_ms ?? 1_200_000,
              });
            }
          }
        }
      }
    }
  }

  const cs = matrix.cold_start;
  if (cs?.enabled) {
    const scenario = cs.scenario ?? "cold_start_single_user";
    const profiles = cs.profiles ?? ["local_loopback", "cdn1_r2"];
    const arms = cs.arms ?? ["E3_normal_streaming"];
    const trialsPer = cs.trials_per_condition ?? 2;
    const timing = resolveTrialTiming(matrix, scenario);
    for (const profile of profiles) {
      for (const armId of arms) {
        if (!FORMAL_ARMS[armId]) continue;
        const armDef = FORMAL_ARMS[armId];
        const measurementMode = armDef.defaultMeasurementMode;
        for (let trialIndex = 0; trialIndex < trialsPer; trialIndex++) {
          trials.push({
            delivery_profile: profile,
            scenario,
            arm_id: armId,
            measurement_mode: measurementMode,
            trial_index: trialIndex,
            client_id: "c0",
            client_count: 1,
            startup_mode: timing.startup_mode,
            warmup_ms: timing.warmup_ms,
            move_ms: timing.move_ms,
            timeout_ms: matrix.timeout_ms ?? 1_200_000,
          });
        }
      }
    }
  }

  return trials;
}

export async function writeMatrixArtifacts(batchDir, matrix, trials, profilesDoc, infra) {
  const configDir = path.join(batchDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "experiment_matrix.json"),
    `${JSON.stringify({ ...matrix, expanded_trial_count: trials.length }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(configDir, "delivery_profiles.json"),
    `${JSON.stringify(profilesDoc, null, 2)}\n`,
  );
  const inv = {
    machine_id: process.env.VRC_MACHINE_ID || os.hostname(),
    worker_id: process.env.VRC_WORKER_ID || "worker1",
    hostname: os.hostname(),
    platform: process.platform,
    note: "24h runner 当前在编排机本机顺序跑 Chrome；worker2 地址仅记录在案，未 SSH 分发",
    workers: infra?.workers ?? null,
    asset_urls: infra?.assets ?? null,
  };
  await fs.writeFile(path.join(configDir, "worker_inventory.json"), `${JSON.stringify(inv, null, 2)}\n`);
  if (infra) {
    await fs.writeFile(
      path.join(configDir, "lab_infrastructure.json"),
      `${JSON.stringify(infra, null, 2)}\n`,
      "utf8",
    );
  }
}
