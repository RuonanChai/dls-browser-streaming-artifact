/**
 * Collect WebGL / Chrome GPU backend info from the page.
 */
export async function collectGpuBackend(page, { headless }) {
  return page.evaluate((headedLaunch) => {
    const out = {
      headed_launch: headedLaunch,
      headless_ua: /HeadlessChrome/i.test(navigator.userAgent),
      chrome_version: navigator.userAgent,
      device_pixel_ratio: window.devicePixelRatio,
      canvas_css_width: null,
      canvas_css_height: null,
      drawing_buffer_width: null,
      drawing_buffer_height: null,
      webgl_vendor: null,
      webgl_renderer: null,
      is_angle: false,
      is_swiftshader: false,
      is_software_renderer: false,
      visibility_state: document.visibilityState,
      UNMASKED_VENDOR_WEBGL: null,
      UNMASKED_RENDERER_WEBGL: null,
    };
    const canvas = document.getElementById("canvas") || document.querySelector("canvas");
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      out.canvas_css_width = Math.round(r.width);
      out.canvas_css_height = Math.round(r.height);
    }
    try {
      const glCanvas = canvas || document.createElement("canvas");
      const gl = glCanvas.getContext("webgl2") || glCanvas.getContext("webgl");
      if (gl) {
        out.drawing_buffer_width = gl.drawingBufferWidth;
        out.drawing_buffer_height = gl.drawingBufferHeight;
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) {
          out.UNMASKED_VENDOR_WEBGL = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || "";
          out.UNMASKED_RENDERER_WEBGL = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "";
          out.webgl_vendor = out.UNMASKED_VENDOR_WEBGL;
          out.webgl_renderer = out.UNMASKED_RENDERER_WEBGL;
        }
        const rlow = String(out.webgl_renderer || "").toLowerCase();
        out.is_angle = rlow.includes("angle");
        out.is_swiftshader = rlow.includes("swiftshader");
        out.is_software_renderer =
          out.is_swiftshader || rlow.includes("llvmpipe") || rlow.includes("software");
      }
    } catch (e) {
      out.error = String(e?.message || e);
    }
    return out;
  }, !headless);
}
