/**
 * Enhanced GPU / Chrome backend dump for render bottleneck diagnosis.
 */
import { collectGpuBackend } from "./local_stutter_ablation_gpu_backend.mjs";

function inferAngleBackend(chromeArgs = [], renderer = "") {
  const args = chromeArgs.join(" ");
  if (args.includes("--use-angle=gl")) return "gl";
  if (args.includes("--use-angle=d3d11on12")) return "d3d11on12";
  if (args.includes("--use-angle=d3d9")) return "d3d9";
  if (args.includes("--use-angle=vulkan")) return "vulkan";
  if (args.includes("--use-angle=d3d11")) return "d3d11";
  const r = String(renderer).toLowerCase();
  if (r.includes("direct3d11") || r.includes("d3d11")) return "d3d11";
  if (r.includes("opengl")) return "gl";
  return "default";
}

function isIntegratedGpu(renderer = "", vendor = "") {
  const s = `${vendor} ${renderer}`.toLowerCase();
  if (/geforce|rtx |radeon rx|quadro|arc a\d|nvidia/i.test(s)) return false;
  return /intel|uhd|iris|hd graphics|integrated|amd radeon graphics/i.test(s);
}

export async function collectGpuBackendDetailed(page, { headless, chromeArgs = [], chromeProfile = "default" }) {
  const base = await collectGpuBackend(page, { headless });
  let cdpVersion = null;
  let systemInfo = null;
  try {
    const cdp = await page.context().newCDPSession(page);
    cdpVersion = await cdp.send("Browser.getVersion");
    try {
      systemInfo = await cdp.send("SystemInfo.getInfo");
    } catch { /* optional */ }
  } catch { /* */ }

  const renderer = base.webgl_renderer || systemInfo?.gpu?.deviceString || "";
  const vendor = base.webgl_vendor || "";
  const disabledGpu = chromeArgs.includes("--disable-gpu");

  return {
    ...base,
    WEBGL_UNMASKED_VENDOR_WEBGL: vendor,
    WEBGL_UNMASKED_RENDERER_WEBGL: renderer,
    chrome_version: cdpVersion?.product || base.chrome_version,
    chrome_user_agent: base.chrome_version,
    chrome_revision: cdpVersion?.revision ?? null,
    angle_backend: inferAngleBackend(chromeArgs, renderer),
    chrome_profile: chromeProfile,
    chrome_launch_args: chromeArgs,
    hardware_acceleration: !disabledGpu,
    hardware_acceleration_note: disabledGpu
      ? "disabled via --disable-gpu"
      : "enabled (GPU process expected)",
    gpu_device_name: systemInfo?.gpu?.deviceString ?? null,
    gpu_driver_version: systemInfo?.gpu?.driverVersion ?? null,
    is_integrated_gpu: isIntegratedGpu(renderer, vendor),
    is_angle: base.is_angle || /angle/i.test(renderer),
    is_swiftshader: base.is_swiftshader,
    is_software_renderer: base.is_software_renderer || disabledGpu,
  };
}
