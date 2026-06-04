/** Minimal per-trial sanity gates for DLS harness. */
export function isSwiftShaderOrCpuRenderer(gpuRenderer) {
  const r = String(gpuRenderer ?? "").toLowerCase();
  if (!r) return { bad: true, reason: "missing_gpu_renderer" };
  if (/swiftshader|llvmpipe|software|microsoft basic render|google swiftshader/i.test(r)) {
    return { bad: true, reason: "swiftshader_or_software_renderer" };
  }
  return { bad: false, reason: "" };
}

export function evaluateTrialGate(trialJson) {
  const failures = [];
  const gpu = isSwiftShaderOrCpuRenderer(trialJson.gpu_renderer);
  if (gpu.bad) failures.push(`GPU: ${gpu.reason}`);

  const radActivity =
    trialJson.status_code === 206
    || (trialJson.total_rad_requests ?? 0) > 0
    || (trialJson.cdp_rad_206_count ?? 0) >= 3;
  if (!radActivity) failures.push("No 206/rad activity");

  if ((trialJson.measure_fps ?? 0) > 0 && (trialJson.measure_fps ?? 0) < 5) {
    failures.push("FPS too low (<5)");
  }

  return { passed: failures.length === 0, failures };
}
