/**
 * Cold-start / first-visible milestones (ms since __ablationStartStartupMonitor).
 * Injected with ablation_page_probe.js.
 */
(function ablationStartupTimelineBootstrap() {
  const LUMINANCE_THRESHOLD = 12;
  const MAX_TRACK_MS = 120_000;

  function visibleSplatCount() {
    const c = window.__ablationReadSplatCounts?.();
    return (
      Number(c?.visible_splat_count ?? c?.rendered_splat_count ?? 0) || 0
    );
  }

  function sampleCenterLuma() {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { luma: null, ok: false };
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl || !gl.readPixels) return { luma: null, ok: false };
    const w = canvas.width;
    const h = canvas.height;
    if (w < 8 || h < 8) return { luma: null, ok: false };
    const size = 16;
    const x0 = Math.max(0, Math.floor(w / 2) - Math.floor(size / 2));
    const y0 = Math.max(0, Math.floor(h / 2) - Math.floor(size / 2));
    const buf = new Uint8Array(size * size * 4);
    try {
      gl.readPixels(x0, y0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    } catch {
      return { luma: null, ok: false };
    }
    let sum = 0;
    const n = size * size;
    for (let i = 0; i < buf.length; i += 4) {
      sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    }
    return { luma: sum / n, ok: true };
  }

  window.__ablationStartupState = null;

  window.__ablationStartStartupMonitor = function ablationStartStartupMonitor() {
    const state = {
      t0: performance.now(),
      startup_mode:
        new URLSearchParams(location.search).get("VRC_STARTUP_MODE") || "steady_state",
      first_visible_splat_ms: null,
      first_quality_10k_splats_ms: null,
      first_quality_100k_splats_ms: null,
      first_nonblack_frame_ms: null,
      first_rad_request_ms: null,
      canvas_luma_sampling_ok: false,
      stopped: false,
    };
    window.__ablationStartupState = state;

    function markFirst(key, elapsed) {
      if (state[key] == null) state[key] = Math.round(elapsed * 100) / 100;
    }

    function tick() {
      if (state.stopped) return;
      const elapsed = performance.now() - state.t0;
      const vis = visibleSplatCount();
      if (vis >= 1) markFirst("first_visible_splat_ms", elapsed);
      if (vis >= 10_000) markFirst("first_quality_10k_splats_ms", elapsed);
      if (vis >= 100_000) markFirst("first_quality_100k_splats_ms", elapsed);

      const { luma, ok } = sampleCenterLuma();
      if (ok) {
        state.canvas_luma_sampling_ok = true;
        if (luma > LUMINANCE_THRESHOLD) markFirst("first_nonblack_frame_ms", elapsed);
      }

      const done =
        state.first_quality_100k_splats_ms != null
        && (state.first_nonblack_frame_ms != null || !state.canvas_luma_sampling_ok);
      if (!done && elapsed < MAX_TRACK_MS) {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
    return state;
  };

  window.__ablationNoteFirstRadRequest = function () {
    const st = window.__ablationStartupState;
    if (!st || st.first_rad_request_ms != null) return;
    st.first_rad_request_ms = Math.round((performance.now() - st.t0) * 100) / 100;
  };

  window.__ablationStopStartupMonitor = function () {
    if (window.__ablationStartupState) window.__ablationStartupState.stopped = true;
  };

  window.__ablationGetStartupSnapshot = function () {
    const st = window.__ablationStartupState;
    if (!st) {
      return {
        startup_mode: new URLSearchParams(location.search).get("VRC_STARTUP_MODE") || "steady_state",
        first_visible_splat_ms: null,
        first_quality_10k_splats_ms: null,
        first_quality_100k_splats_ms: null,
        first_nonblack_frame_ms: null,
        first_rad_request_ms: null,
        canvas_luma_sampling_ok: false,
      };
    }
    return {
      startup_mode: st.startup_mode,
      first_visible_splat_ms: st.first_visible_splat_ms,
      first_quality_10k_splats_ms: st.first_quality_10k_splats_ms,
      first_quality_100k_splats_ms: st.first_quality_100k_splats_ms,
      first_nonblack_frame_ms: st.first_nonblack_frame_ms,
      first_rad_request_ms: st.first_rad_request_ms,
      canvas_luma_sampling_ok: st.canvas_luma_sampling_ok,
    };
  };
})();
