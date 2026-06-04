/**
 * VRC headed-client optimizations (env-gated via URL params).
 * VRC_OPT_ADAPTIVE_DPR=1 | VRC_OPT_SPLAT_BUDGET=1 | VRC_OPT_LOD_THROTTLE=1
 */
(function vrcOptRuntimeBootstrap() {
  const u = new URLSearchParams(location.search);
  const flags = {
    adaptiveDpr: u.get("VRC_OPT_ADAPTIVE_DPR") === "1",
    splatBudget: u.get("VRC_OPT_SPLAT_BUDGET") === "1",
    lodThrottle: u.get("VRC_OPT_LOD_THROTTLE") === "1",
  };

  const CFG = {
    adaptiveDpr: {
      minRenderScale: 0.65,
      maxRenderScale: 1.0,
      initialRenderScale: 1.0,
      stepDown: 0.05,
      stepUp: 0.025,
      controlWindowMs: 2000,
      p95HighMs: 33,
      p95LowMs: 18,
    },
    splatBudget: {
      minBudgetScale: 0.5,
      maxBudgetScale: 1.0,
      initialBudgetScale: 1.0,
      stepDown: 0.05,
      stepUp: 0.025,
      controlWindowMs: 2000,
      p95HighMs: 33,
      p95LowMs: 18,
    },
    lodThrottle: {
      minUpdateIntervalMs: 50,
      maxUpdateIntervalMs: 150,
      positionDeltaThreshold: 0.2,
      rotationDeltaThresholdDeg: 2,
      highVelocityMps: 2.5,
    },
  };

  function p95Of(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }

  function windowFrameTimes(diag, windowMs, now) {
    const fts = diag?.measure_frame_times?.length
      ? diag.measure_frame_times
      : diag?.frame_times ?? [];
    if (!fts.length) return fts.slice(-60);
    const cutoff = now - windowMs;
    return fts.slice(-Math.min(fts.length, 120));
  }

  const metrics = {
    render_scale_current: 1,
    render_scale_min: 1,
    render_scale_mean_sum: 0,
    render_scale_mean_n: 0,
    render_scale_change_count: 0,
    budget_scale_current: 1,
    budget_scale_min: 1,
    budget_scale_mean_sum: 0,
    budget_scale_mean_n: 0,
    budget_scale_change_count: 0,
    lod_update_count: 0,
    visibility_update_count: 0,
    skipped_lod_update_count: 0,
    skipped_visibility_update_count: 0,
    lod_interval_sum_ms: 0,
    lod_interval_n: 0,
    camera_position_delta_sum: 0,
    camera_rotation_delta_sum: 0,
    camera_delta_n: 0,
    quality_proxy_sum: 0,
    quality_proxy_n: 0,
    device_pixel_ratio: null,
    drawing_buffer_width: null,
    drawing_buffer_height: null,
  };

  let basePixelRatio = 1;
  let baseLodSplatScale = null;
  let lastLodUpdateMs = 0;
  let lastCamPos = null;
  let lastCamQuat = null;
  let lastControlMs = 0;

  const adaptive = {
    renderScale: CFG.adaptiveDpr.initialRenderScale,
    lastAdjustMs: 0,
    apply(renderer) {
      if (!renderer) return;
      const pr = Math.max(
        CFG.adaptiveDpr.minRenderScale,
        Math.min(CFG.adaptiveDpr.maxRenderScale, basePixelRatio * this.renderScale),
      );
      renderer.setPixelRatio(pr);
      if (typeof window.onWindowResize === "function") window.onWindowResize();
      metrics.render_scale_current = this.renderScale;
      metrics.device_pixel_ratio = window.devicePixelRatio;
      const c = renderer.domElement;
      if (c) {
        metrics.drawing_buffer_width = c.width;
        metrics.drawing_buffer_height = c.height;
      }
    },
    tick(now, frameP95) {
      if (now - this.lastAdjustMs < 250) return;
      const prev = this.renderScale;
      if (frameP95 > CFG.adaptiveDpr.p95HighMs) {
        this.renderScale = Math.max(
          CFG.adaptiveDpr.minRenderScale,
          this.renderScale - CFG.adaptiveDpr.stepDown,
        );
      } else if (frameP95 > 0 && frameP95 < CFG.adaptiveDpr.p95LowMs) {
        this.renderScale = Math.min(
          CFG.adaptiveDpr.maxRenderScale,
          this.renderScale + CFG.adaptiveDpr.stepUp,
        );
      }
      if (Math.abs(this.renderScale - prev) > 1e-4) {
        metrics.render_scale_change_count += 1;
        this.lastAdjustMs = now;
      }
      metrics.render_scale_min = Math.min(metrics.render_scale_min, this.renderScale);
      metrics.render_scale_mean_sum += this.renderScale;
      metrics.render_scale_mean_n += 1;
    },
  };

  const budget = {
    budgetScale: CFG.splatBudget.initialBudgetScale,
    lastAdjustMs: 0,
    apply(spark) {
      if (!spark || baseLodSplatScale == null) return;
      const scale = Math.max(
        CFG.splatBudget.minBudgetScale,
        Math.min(CFG.splatBudget.maxBudgetScale, this.budgetScale),
      );
      const lodCount = spark.lodSplatCount ?? spark.defaultSplatTarget?.() ?? 0;
      if (lodCount <= 0) return;
      const targetRendered = Math.max(1, Math.floor(lodCount * baseLodSplatScale * scale));
      spark.lodSplatScale = targetRendered / lodCount;
      spark.lodDirty = true;
      metrics.budget_scale_current = scale;
      metrics.quality_proxy_sum += targetRendered;
      metrics.quality_proxy_n += 1;
      window.__vrcAblation = window.__vrcAblation || {};
      window.__vrcAblation.targetRenderedSplats = targetRendered;
    },
    tick(now, frameP95) {
      if (now - this.lastAdjustMs < 250) return;
      const prev = this.budgetScale;
      if (frameP95 > CFG.splatBudget.p95HighMs) {
        this.budgetScale = Math.max(CFG.splatBudget.minBudgetScale, this.budgetScale - CFG.splatBudget.stepDown);
      } else if (frameP95 > 0 && frameP95 < CFG.splatBudget.p95LowMs) {
        this.budgetScale = Math.min(CFG.splatBudget.maxBudgetScale, this.budgetScale + CFG.splatBudget.stepUp);
      }
      if (Math.abs(this.budgetScale - prev) > 1e-4) {
        metrics.budget_scale_change_count += 1;
        this.lastAdjustMs = now;
      }
      metrics.budget_scale_min = Math.min(metrics.budget_scale_min, this.budgetScale);
      metrics.budget_scale_mean_sum += this.budgetScale;
      metrics.budget_scale_mean_n += 1;
    },
  };

  const lodThrottle = {
    shouldUpdate(spark, camera, now) {
      if (!spark || !camera) return true;
      const cfg = CFG.lodThrottle;
      const pos = camera.position;
      const quat = camera.quaternion;
      let posDelta = 0;
      let rotDeltaDeg = 0;
      if (lastCamPos) posDelta = pos.distanceTo(lastCamPos);
      if (lastCamQuat) {
        const dot = Math.abs(lastCamQuat.dot(quat));
        rotDeltaDeg = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
      }
      lastCamPos = pos.clone();
      lastCamQuat = quat.clone();
      if (metrics.camera_delta_n === 0) {
        metrics.camera_position_delta_sum += posDelta;
        metrics.camera_rotation_delta_sum += rotDeltaDeg;
        metrics.camera_delta_n += 1;
      } else {
        metrics.camera_position_delta_sum += posDelta;
        metrics.camera_rotation_delta_sum += rotDeltaDeg;
        metrics.camera_delta_n += 1;
      }

      const elapsed = now - lastLodUpdateMs;
      const interval =
        posDelta > cfg.highVelocityMps * 0.08
          ? cfg.minUpdateIntervalMs
          : posDelta < 0.01 && rotDeltaDeg < 0.5
            ? cfg.maxUpdateIntervalMs
            : (cfg.minUpdateIntervalMs + cfg.maxUpdateIntervalMs) / 2;

      if (elapsed >= cfg.maxUpdateIntervalMs) return true;
      if (elapsed < cfg.minUpdateIntervalMs) return false;
      if (posDelta >= cfg.positionDeltaThreshold) return true;
      if (rotDeltaDeg >= cfg.rotationDeltaThresholdDeg) return true;
      return elapsed >= interval;
    },
    apply(spark, camera, now, forceOff) {
      if (!spark) return;
      const mode = window.__vrcAblation?.mode || "";
      const fixedLodModes = new Set(["normal_fixed_lod", "render_plus_camera_only"]);
      if (fixedLodModes.has(mode) || forceOff) {
        spark.enableDriveLod = false;
        metrics.skipped_lod_update_count += 1;
        metrics.skipped_visibility_update_count += 1;
        return;
      }
      const lodOnly = mode === "render_plus_lod_update_only";
      const visOnly = mode === "render_plus_visibility_only";
      let update = this.shouldUpdate(spark, camera, now);
      if (lodOnly) update = true;
      if (visOnly) update = true;

      if (update) {
        spark.enableDriveLod = true;
        if (lastLodUpdateMs > 0) {
          const dt = now - lastLodUpdateMs;
          metrics.lod_interval_sum_ms += dt;
          metrics.lod_interval_n += 1;
        }
        lastLodUpdateMs = now;
        metrics.lod_update_count += 1;
        metrics.visibility_update_count += 1;
      } else {
        spark.enableDriveLod = false;
        metrics.skipped_lod_update_count += 1;
        metrics.skipped_visibility_update_count += 1;
      }
    },
  };

  window.__vrcOptInit = function initVrcOpt(renderer, spark) {
    basePixelRatio =
      Number(window.__vrcAblation?.basePixelRatio) ||
      renderer?.getPixelRatio?.() ||
      window.devicePixelRatio ||
      1;
    baseLodSplatScale =
      window.__vrcAblation?.baseLodSplatScale ?? spark?.lodSplatScale ?? 1.5;
    window.__vrcAblation = window.__vrcAblation || {};
    window.__vrcAblation.baseLodSplatScale = baseLodSplatScale;
    adaptive.renderScale = CFG.adaptiveDpr.initialRenderScale;
    budget.budgetScale = CFG.splatBudget.initialBudgetScale;
    if (flags.adaptiveDpr && renderer) adaptive.apply(renderer);
  };

  window.__vrcOptTick = function vrcOptTick(now) {
    const phase = window.__vrcAblation?.phase;
    if (phase !== "measure") return;
    const renderer = window.__slDiagRenderer;
    const spark = window.__slDiagSpark;
    const camera = window.__slDiagCam;
    const diag = window.__stutterDiag;
    const frameP95 = p95Of(windowFrameTimes(diag, CFG.adaptiveDpr.controlWindowMs, now));

    const mode = window.__vrcAblation?.mode || "";
    if (mode === "normal_fixed_lod" && spark) {
      spark.enableDriveLod = false;
      if (baseLodSplatScale != null) spark.lodSplatScale = baseLodSplatScale;
    }
    if (mode === "render_plus_camera_only" && spark) {
      spark.enableDriveLod = false;
    }
    if (mode === "render_plus_visibility_only" && spark) {
      spark.enableDriveLod = true;
      if (baseLodSplatScale != null) spark.lodSplatScale = baseLodSplatScale;
      metrics.lod_update_count += 1;
      metrics.visibility_update_count += 1;
    }
    if (mode === "render_plus_lod_update_only" && spark) {
      spark.enableDriveLod = true;
    }

    if (flags.lodThrottle || mode.startsWith("render_plus_") || mode === "normal_fixed_lod") {
      lodThrottle.apply(spark, camera, now, mode === "render_plus_camera_only" || mode === "normal_fixed_lod");
    }

    if (flags.adaptiveDpr) {
      adaptive.tick(now, frameP95);
      adaptive.apply(renderer);
    }
    if (flags.splatBudget) {
      budget.tick(now, frameP95);
      budget.apply(spark);
    }
  };

  window.__vrcOptGetMetrics = function getVrcOptMetrics() {
    const splats = window.__ablationReadSplatCounts?.() ?? {};
    return {
      ...metrics,
      render_scale_mean:
        metrics.render_scale_mean_n > 0
          ? metrics.render_scale_mean_sum / metrics.render_scale_mean_n
          : metrics.render_scale_current,
      budget_scale_mean:
        metrics.budget_scale_mean_n > 0
          ? metrics.budget_scale_mean_sum / metrics.budget_scale_mean_n
          : metrics.budget_scale_current,
      avg_lod_update_interval_ms:
        metrics.lod_interval_n > 0 ? metrics.lod_interval_sum_ms / metrics.lod_interval_n : null,
      camera_position_delta_mean:
        metrics.camera_delta_n > 0
          ? metrics.camera_position_delta_sum / metrics.camera_delta_n
          : null,
      camera_rotation_delta_mean:
        metrics.camera_delta_n > 0
          ? metrics.camera_rotation_delta_sum / metrics.camera_delta_n
          : null,
      quality_proxy:
        metrics.quality_proxy_n > 0
          ? metrics.quality_proxy_sum / metrics.quality_proxy_n
          : splats.target_rendered_splats ?? splats.rendered_splat_count,
      visible_splat_count: splats.visible_splat_count,
      target_rendered_splats:
        window.__vrcAblation?.targetRenderedSplats ?? splats.rendered_splat_count,
      rendered_splat_count: splats.rendered_splat_count,
      flags: { ...flags },
    };
  };

  window.__vrcOpt = { flags, CFG, metrics, adaptive, budget, lodThrottle };
})();
