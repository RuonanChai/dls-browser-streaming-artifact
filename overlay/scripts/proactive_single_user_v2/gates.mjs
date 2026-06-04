/**
 * Post-trial gates for v2 proactive single-user experiment (ready-aware).
 */

export function isSwiftShaderOrCpuRenderer(gpuRenderer) {
  const r = String(gpuRenderer ?? "").toLowerCase();
  if (!r) return { bad: true, reason: "missing_gpu_renderer" };
  if (/swiftshader|llvmpipe|software|microsoft basic render|google swiftshader/i.test(r)) {
    return { bad: true, reason: "swiftshader_or_software_renderer" };
  }
  return { bad: false, reason: "" };
}

export function evaluateProactiveTrialGate(trialJson) {
  const failures = [];
  const checks = [];

  const gpu = isSwiftShaderOrCpuRenderer(trialJson.gpu_renderer);
  checks.push({ gate: "gpu", passed: !gpu.bad, detail: trialJson.gpu_renderer });
  if (gpu.bad) failures.push(`GPU: ${gpu.reason}`);

  const radActivity =
    trialJson.status_code === 206
    || (trialJson.total_rad_requests ?? 0) > 0
    || (trialJson.measure_rad_requests ?? 0) > 0
    || (trialJson.cdp_rad_206_count ?? 0) >= 5;
  checks.push({
    gate: "http_or_rad_activity",
    passed: radActivity,
    status_code: trialJson.status_code,
    total_rad: trialJson.total_rad_requests,
    measure_rad: trialJson.measure_rad_requests,
    cdp_rad_206: trialJson.cdp_rad_206_count,
  });
  if (!radActivity) failures.push("No 206/rad activity (probe or CDP)");

  if (
    (trialJson.measure_rad_requests ?? 0) === 0
    && (trialJson.cdp_rad_206_count ?? 0) === 0
    && (trialJson.measure_fps ?? 0) > 120
  ) {
    failures.push("Invalid streaming trial: high FPS but zero rad requests");
  }

  const minDemand = trialJson.baseline_id === "B0_on_demand" ? 5 : 3;
  const demandOk = (trialJson.demanded_chunks ?? 0) >= minDemand || (trialJson.demand_trace_count ?? 0) >= minDemand;
  const metricsOk = trialJson.proactive_metrics_complete !== false && demandOk;
  checks.push({ gate: "proactive_metrics", passed: metricsOk, demanded: trialJson.demanded_chunks });
  if (!metricsOk) failures.push("Incomplete proactive chunk metrics or demand trace too small");

  if (trialJson.baseline_id === "B4_ready_oracle" && !trialJson.oracle_upper_bound_labeled) {
    failures.push("B4_ready_oracle must be labeled oracle_upper_bound");
  }

  if ((trialJson.visible_splat_max ?? 0) <= 0 && (trialJson.first_visible_splat_ms ?? null) == null) {
    checks.push({ gate: "visible_splat", passed: false });
    failures.push("No visible splat observed");
  }

  if (trialJson.baseline_id !== "B0_on_demand") {
    if (trialJson.ready_event_used == null) {
      failures.push("ready_event_used annotation missing for ready-aware baseline");
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    checks,
    halt_batch: gpu.bad,
  };
}
