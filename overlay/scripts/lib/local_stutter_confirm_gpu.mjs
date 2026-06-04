/**
 * GPU validation for NVIDIA RTX 4070 confirm batch.
 */
export function inferAngleBackend(renderer = "", chromeArgs = []) {
  const args = (chromeArgs || []).join(" ");
  if (args.includes("--use-angle=gl")) return "gl";
  if (args.includes("--use-angle=d3d11on12")) return "d3d11on12";
  if (args.includes("--use-angle=d3d11")) return "d3d11";
  const r = String(renderer).toLowerCase();
  if (r.includes("direct3d11") || r.includes("d3d11")) return "d3d11";
  if (r.includes("opengl")) return "gl";
  return "unknown";
}

export function validateNvidiaTrial(gpu = {}, chromeArgs = []) {
  const renderer = String(gpu.webgl_renderer || gpu.UNMASKED_RENDERER_WEBGL || "");
  const vendor = String(gpu.webgl_vendor || gpu.UNMASKED_VENDOR_WEBGL || "");
  const rlow = renderer.toLowerCase();
  const vlow = vendor.toLowerCase();
  const reasons = [];

  if (gpu.is_swiftshader || rlow.includes("swiftshader") || rlow.includes("llvmpipe")) {
    reasons.push("software_renderer");
  }
  if (!/nvidia|geforce|rtx\s*4070/.test(`${vlow} ${rlow}`)) {
    reasons.push("missing_nvidia");
  }
  if (!/4070/.test(rlow)) {
    reasons.push("missing_rtx_4070");
  }
  if (!/d3d11|direct3d11/.test(rlow)) {
    reasons.push("missing_d3d11");
  }
  if (!/angle/.test(rlow)) {
    reasons.push("missing_angle");
  }
  if (gpu.visibility_state && gpu.visibility_state !== "visible") {
    reasons.push(`visibility_${gpu.visibility_state}`);
  }

  const angle_backend = inferAngleBackend(renderer, chromeArgs);
  const ok = reasons.length === 0;
  return {
    trial_valid: ok,
    invalid_reason: ok ? "" : reasons.join(";"),
    angle_backend,
    has_nvidia: /nvidia|geforce/.test(`${vlow} ${rlow}`),
    has_rtx_4070: /4070/.test(rlow),
    has_d3d11: /d3d11|direct3d11/.test(rlow),
    has_angle: /angle/.test(rlow),
  };
}
