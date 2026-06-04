/**
 * 24h hard gates — mark trial failed; halt batch on fatal violations.
 */

export const GATE_DEFAULTS = {
  e3_min_measure_rad: Number(process.env.VRC_GATE_E3_MIN_MEASURE_RAD) || 30,
  halt_on_hard_gate: process.env.VRC_HALT_ON_HARD_GATE !== "0",
};

const FOCUS_ARMS = new Set([
  "E3_normal_streaming",
  "E5_fetch_only",
  "E8_pure_render",
]);

export function isSwiftShaderOrCpuRenderer(gpuRenderer) {
  const r = String(gpuRenderer ?? "").toLowerCase();
  if (!r) return { bad: true, reason: "missing_gpu_renderer" };
  if (/swiftshader|llvmpipe|software|microsoft basic render|google swiftshader/i.test(r)) {
    return { bad: true, reason: "swiftshader_or_software_renderer" };
  }
  if (/angle \(google, vulkan/i.test(r) && !/nvidia|amd|intel/i.test(r)) {
    return { bad: true, reason: "possible_cpu_angle_backend" };
  }
  return { bad: false, reason: "" };
}

/**
 * @param {object} trialJson
 * @param {{ e3MinMeasureRad?: number }} opts
 * @returns {{ passed: boolean, failures: string[], halt_batch: boolean, gate_results: object[] }}
 */
export function evaluateHardGates(trialJson, opts = {}) {
  const e3Min = opts.e3MinMeasureRad ?? GATE_DEFAULTS.e3_min_measure_rad;
  const failures = [];
  const gateResults = [];
  let haltBatch = false;

  const arm = trialJson.arm_id;
  const measureRad = Number(trialJson.measure_rad_requests);
  const gpu = trialJson.gpu_renderer ?? "";

  const trialStatus = String(trialJson.status ?? "");
  const trialError = String(trialJson.error ?? "");
  const trialInvalid = trialStatus === "failed" || trialError.length > 0;
  if (trialInvalid) {
    gateResults.push({
      gate: "trial_runtime_success",
      passed: false,
      status: trialStatus || "(empty)",
      error: trialError.slice(0, 200) || "(empty)",
    });
    failures.push(`HARD_GATE_TRIAL: invalid_trial status=${trialStatus || "?"} error=${trialError.slice(0, 120) || "(empty)"}`);
  }

  if (!FOCUS_ARMS.has(arm) && arm) {
    return {
      passed: !trialInvalid,
      failures,
      halt_batch: false,
      gate_results: gateResults,
    };
  }

  const gpuCheck = isSwiftShaderOrCpuRenderer(gpu);
  gateResults.push({
    gate: "gpu_not_swiftshader",
    passed: !gpuCheck.bad,
    detail: gpu || "(empty)",
    reason: gpuCheck.reason,
  });
  if (gpuCheck.bad) {
    failures.push(`HARD_GATE_GPU: ${gpuCheck.reason}`);
    haltBatch = true;
  }

  if (arm === "E8_pure_render") {
    const ok = Number.isFinite(measureRad) && measureRad === 0;
    gateResults.push({
      gate: "e8_measure_rad_zero",
      passed: ok,
      measure_rad_requests: measureRad,
    });
    if (!ok) {
      failures.push(`HARD_GATE_E8: measure_rad_requests=${measureRad} (must be 0)`);
      haltBatch = true;
    }
  }

  if (arm === "E3_normal_streaming" && trialJson.measurement_mode === "streaming_in_loop_mode") {
    const profile = trialJson.delivery_profile ?? "";
    const isRemote = /cdn|hpc|throttled/i.test(profile);
    const effectiveE3Min = isRemote ? 1 : e3Min;
    const ok = Number.isFinite(measureRad) && measureRad >= effectiveE3Min;
    gateResults.push({
      gate: "e3_streaming_measure_rad_min",
      passed: ok,
      measure_rad_requests: measureRad,
      threshold: effectiveE3Min,
      original_threshold: e3Min,
      profile_class: isRemote ? "remote" : "local",
    });
    if (!ok) {
      failures.push(
        `HARD_GATE_E3: measure_rad_requests=${measureRad} < ${effectiveE3Min} (streaming workload invalid)`,
      );
      haltBatch = !isRemote;
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    halt_batch: haltBatch && GATE_DEFAULTS.halt_on_hard_gate,
    gate_results: gateResults,
  };
}

export function applyHardGatesToTrialJson(trialJson, gateEval) {
  trialJson.hard_gate_passed = gateEval.passed;
  trialJson.hard_gate_failures = gateEval.failures;
  trialJson.hard_gate_results = gateEval.gate_results;
  trialJson.halt_batch_recommended = gateEval.halt_batch;
  if (!gateEval.passed) {
    trialJson.status = "failed";
    trialJson.gate_failed = true;
  }
  return trialJson;
}
