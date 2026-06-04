/**
 * Ablation page probe v2: phased metrics, full fetch/parse, WebGL upload hooks.
 */
(function ablationProbeBootstrap() {
  const u = new URLSearchParams(location.search);
  const mode = (u.get("ablation_mode") || u.get("VRC_DIAG_MODE") || "normal").trim();
  const pixelRatioParam = (u.get("pixel_ratio") || u.get("VRC_PIXEL_RATIO") || "auto").trim();
  const forceGlFinish = u.get("VRC_FORCE_GL_FINISH_AFTER_UPLOAD") === "1";

  const PURE_RENDER = new Set([
    "render_only",
    "render_only_pure",
    "static_camera_render_only",
    "static_camera_render_only_pure",
    "moving_camera_render_only",
    "moving_camera_render_only_pure",
    "render_plus_camera_only",
    "render_plus_visibility_only",
    "render_plus_lod_update_only",
  ]);

  const cfg = {
    mode,
    pixelRatioParam,
    disableLod: u.get("VRC_DISABLE_LOD_UPDATE") === "1",
    disableGpuUpload: u.get("VRC_DISABLE_GPU_UPLOAD") === "1",
    disableRender: u.get("VRC_DISABLE_RENDER_LOOP") === "1",
    networkBlocked: false,
    preloadComplete: false,
    phase: "preload",
    label: mode,
    forceGlFinish,
  };

  function emptyPhase() {
    return {
      rad_requests: 0,
      fetch_total_ms: [],
      parse_total_ms: [],
      parse_call_count: 0,
      fetch_bytes: 0,
      frame_times: [],
      renderer_render_call_ms: [],
      draw_calls_per_frame: [],
      rendered_splat_samples: [],
    };
  }

  const metrics = {
    phase: "preload",
    preload: emptyPhase(),
    measure: emptyPhase(),
    fetch_enqueue_ts: new Map(),
    upload: {
      call_count: 0,
      bytes_estimated: 0,
      cpu_times_ms: [],
      largest_upload_bytes: 0,
      largest_upload_time_ms: 0,
      long_call_count_over_16ms: 0,
    },
    total_fetch_requests: 0,
    total_fetch_bytes: 0,
    parse_call_count: 0,
    parse_total_ms_sum: 0,
  };

  function activePhase() {
    return metrics.phase === "measure" ? metrics.measure : metrics.preload;
  }

  function recordRadRequest(bytes, phaseOverride) {
    if (typeof window.__ablationNoteFirstRadRequest === "function") {
      window.__ablationNoteFirstRadRequest();
    }
    const ph = phaseOverride
      ? (phaseOverride === "measure" ? metrics.measure : metrics.preload)
      : activePhase();
    ph.rad_requests += 1;
    metrics.total_fetch_requests += 1;
    if (bytes > 0) {
      ph.fetch_bytes += bytes;
      metrics.total_fetch_bytes += bytes;
    }
  }

  function recordParse(ms) {
    const ph = activePhase();
    ph.parse_total_ms.push(ms);
    ph.parse_call_count += 1;
    metrics.parse_call_count += 1;
    metrics.parse_total_ms_sum += ms;
  }

  function recordUpload(dt, bytes) {
    const u = metrics.upload;
    u.call_count += 1;
    u.bytes_estimated += bytes;
    u.cpu_times_ms.push(dt);
    if (bytes > u.largest_upload_bytes) u.largest_upload_bytes = bytes;
    if (dt > u.largest_upload_time_ms) u.largest_upload_time_ms = dt;
    if (dt > 16) u.long_call_count_over_16ms += 1;
    if (cfg.forceGlFinish && this?.finish) {
      try {
        this.finish();
      } catch { /* */ }
    }
  }

  function estimateUploadBytes(fn, args) {
    const a = args[0];
    if (fn === "bufferData" || fn === "bufferSubData") {
      const data = args[1];
      if (data?.byteLength) return data.byteLength;
      if (typeof a === "number") return a;
    }
    if (fn === "texImage2D" || fn === "texSubImage2D" || fn === "compressedTexImage2D") {
      const data = args[args.length - 1];
      if (data?.byteLength) return data.byteLength;
      const w = Number(args[3]) || 0;
      const h = Number(args[4]) || 0;
      if (w && h) return w * h * 4;
    }
    return 0;
  }

  function wrapGlProto(proto) {
    if (!proto || proto.__ablationUploadWrapped) return;
    proto.__ablationUploadWrapped = true;
    for (const fn of [
      "bufferData",
      "bufferSubData",
      "texImage2D",
      "texSubImage2D",
      "compressedTexImage2D",
    ]) {
      if (typeof proto[fn] !== "function") continue;
      const orig = proto[fn];
      proto[fn] = function ablationGlUpload(...args) {
        const blockUpload = mode === "parse_only" || cfg.disableGpuUpload;
        if (blockUpload) {
          return undefined;
        }
        const t0 = performance.now();
        const ret = orig.apply(this, args);
        recordUpload.call(this, performance.now() - t0, estimateUploadBytes(fn, args));
        return ret;
      };
    }
  }

  wrapGlProto(WebGLRenderingContext?.prototype);
  wrapGlProto(WebGL2RenderingContext?.prototype);

  window.__vrcAblation = cfg;
  window.__ablationProbe = {
    cfg,
    metrics,
    getRadStats() {
      return {
        phase: metrics.phase,
        preload_rad_requests: metrics.preload.rad_requests,
        measure_rad_requests: metrics.measure.rad_requests,
        total_fetch_requests: metrics.total_fetch_requests,
        total_fetch_bytes: metrics.total_fetch_bytes,
      };
    },
    recordDrawCalls(delta) {
      if (metrics.phase === "measure" && delta >= 0) {
        metrics.measure.draw_calls_per_frame.push(delta);
      }
    },
    recordRenderedSplats(n) {
      if (metrics.phase === "measure" && Number.isFinite(n) && n >= 0) {
        metrics.measure.rendered_splat_samples.push(n);
      }
    },
    getSnapshot() {
      const up = metrics.upload;
      const parseAll = [
        ...metrics.preload.parse_total_ms,
        ...metrics.measure.parse_total_ms,
      ];
      const parseSorted = [...parseAll].sort((a, b) => a - b);
      const p95 = (arr, p) => {
        if (!arr.length) return 0;
        return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
      };
      const upSorted = [...up.cpu_times_ms].sort((a, b) => a - b);
      return {
        cfg: { ...cfg, phase: metrics.phase },
        preload: { ...metrics.preload },
        measure: { ...metrics.measure },
        upload: { ...up },
        total_fetch_requests: metrics.total_fetch_requests,
        total_fetch_bytes: metrics.total_fetch_bytes,
        parse_call_count: metrics.parse_call_count,
        parse_total_ms_sum: metrics.parse_total_ms_sum,
        parse_p95_ms: p95(parseSorted, 0.95),
        upload_cpu_time_p50_ms: p95(upSorted, 0.5),
        upload_cpu_time_p95_ms: p95(upSorted, 0.95),
        measure_rad_requests: metrics.measure.rad_requests,
        preload_rad_requests: metrics.preload.rad_requests,
        draw_calls_per_frame: [...metrics.measure.draw_calls_per_frame],
        rendered_splat_samples: [...metrics.measure.rendered_splat_samples],
      };
    },
  };

  window.__ablationApplyRenderSplatBudget = function (percent) {
    const spark = window.__slDiagSpark;
    if (!spark) return { ok: false, error: "no_spark" };
    const baseScale = window.__vrcAblation.baseLodSplatScale ?? spark.lodSplatScale ?? 1.5;
    const lodCount = spark.lodSplatCount ?? spark.defaultSplatTarget?.() ?? 0;
    const pct = Math.max(0.01, Math.min(100, Number(percent) || 100));
    const targetRendered = Math.max(1, Math.floor(lodCount * baseScale * (pct / 100)));
    spark.lodSplatScale = targetRendered / Math.max(1, lodCount);
    spark.lodDirty = true;
    window.__vrcAblation.renderSplatBudgetPercent = pct;
    window.__vrcAblation.targetRenderedSplats = targetRendered;
    return {
      ok: true,
      render_splat_budget_percent: pct,
      base_lod_splat_scale: baseScale,
      lod_splat_count: lodCount,
      lod_splat_scale: spark.lodSplatScale,
      target_rendered_splats: targetRendered,
    };
  };

  window.__ablationLockLodFetchers = function () {
    const spark = window.__slDiagSpark;
    const pager = spark?.pager;
    if (pager && typeof pager.driveFetchers === "function" && !pager.__ablationFetchLocked) {
      pager.__ablationOrigDriveFetchers = pager.driveFetchers.bind(pager);
      pager.driveFetchers = function ablationNoFetch() {};
      pager.__ablationFetchLocked = true;
    }
    return { locked: !!pager?.__ablationFetchLocked };
  };

  window.__ablationReadSplatCounts = function () {
    const spark = window.__slDiagSpark;
    if (!spark) return {};
    const visible = spark.display?.numSplats ?? spark.maxSplats ?? 0;
    const scale = spark.lodSplatScale ?? 0;
    let lodCount = spark.lodSplatCount ?? 0;
    if (lodCount <= 0 && scale > 0 && visible > 0) {
      lodCount = Math.round(visible / scale);
    }
    const rendered = Math.round(lodCount * scale) || visible;
    return {
      loaded_splat_count: lodCount,
      visible_splat_count: visible,
      rendered_splat_count: rendered,
      lod_splat_scale: scale,
      spark_max_splats: spark.maxSplats ?? null,
    };
  };

  const CHUNK_RE = /\.(rad|spz|splat)(\?|#|$)/i;
  const origFetch = globalThis.fetch.bind(globalThis);
  window.__ablationOrigFetch = origFetch;

  globalThis.fetch = async function ablationFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const isRad = CHUNK_RE.test(url);

    if (isRad && cfg.networkBlocked && metrics.phase === "measure") {
      return new Response(new ArrayBuffer(0), { status: 204, statusText: "ablation-blocked" });
    }

    if (!isRad) return origFetch(input, init);

    const enqueuePhase = metrics.phase;
    const t0 = performance.now();
    const res = await origFetch(input, init);
    let bytes = 0;
    try {
      const buf = await res.clone().arrayBuffer();
      bytes = buf.byteLength;
    } catch { /* */ }
    const fetchMs = performance.now() - t0;
    recordRadRequest(bytes, enqueuePhase);
    const phaseBucket = enqueuePhase === "measure" ? metrics.measure : metrics.preload;
    phaseBucket.fetch_total_ms.push(fetchMs);

    if (mode === "fetch_only") {
      return new Promise(() => {});
    }

    return res;
  };

  const prevSparkHook = window.__sparkExpEvent;
  window.__sparkExpEvent = function ablationSparkEvent(evt) {
    if (!evt || !evt.type) {
      if (prevSparkHook) prevSparkHook(evt);
      return;
    }
    const t = performance.now();
    if (evt.type === "fetch_enqueue") {
      const key = `${evt.object_url || evt.object_id || ""}::${evt.chunk ?? ""}`;
      metrics.fetch_enqueue_ts.set(key, t);
    }
    if (evt.type === "fetch_response") {
      const key = `${evt.object_url || evt.object_id || ""}::${evt.chunk ?? ""}`;
      const t0 = metrics.fetch_enqueue_ts.get(key);
      if (t0 != null) recordParse(t - t0);
    }
    if (prevSparkHook) prevSparkHook(evt);
  };

  window.__ablationBlockNetwork = function () {
    cfg.networkBlocked = true;
    cfg.preloadComplete = true;
  };

  window.__ablationSetPhase = function (p) {
    metrics.phase = p;
    cfg.phase = p;
  };

  window.__ablationBeginMeasurePhase = function () {
    metrics.phase = "measure";
    cfg.phase = "measure";
    cfg.networkBlocked = true;
    const d = window.__stutterDiag;
    if (d) {
      d.measure_frame_times = [];
      d.measure_jank_33 = 0;
      d.measure_jank_100 = 0;
      d.frame_times = d.measure_frame_times;
    }
    metrics.measure = emptyPhase();
  };

  window.__ablationResetPreloadPhase = function () {
    metrics.preload = emptyPhase();
    metrics.phase = "preload";
    cfg.phase = "preload";
    cfg.networkBlocked = false;
  };

  window.__ablationReplayFetchManifest = async function (radUrl) {
    const manifest = window.__ablationRadManifest || [];
    const concurrency = 4;
    let idx = 0;
    async function worker() {
      while (idx < manifest.length) {
        const i = idx++;
        const ent = manifest[i];
        const url = ent.url || radUrl;
        const headers = ent.range ? { Range: ent.range } : {};
        const t0 = performance.now();
        const res = await origFetch(url, { headers });
        const buf = await res.arrayBuffer();
        const ms = performance.now() - t0;
        recordRadRequest(buf.byteLength);
        activePhase().fetch_total_ms.push(ms);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { count: manifest.length };
  };
})();
