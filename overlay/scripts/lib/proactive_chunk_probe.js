/**
 * Chunk-level readiness instrumentation (READY single-user paper schema).
 * ready_time: upload/visible proxy > parse_complete; never CDP network end alone.
 */
(function proactiveChunkProbeBootstrap() {
  const u = new URLSearchParams(location.search);
  if (u.get("VRC_PROACTIVE") !== "1") return;

  const baselineCode = u.get("VRC_PROACTIVE_BASELINE") || "B0";
  const state = {
    baseline: baselineCode,
    source_baseline: baselineCode,
    budget_bytes: Number(u.get("VRC_PREFETCH_BUDGET_BYTES")) || 512 * 1024 * 1024,
    demand: [],
    prefetch: [],
    chunk_states: new Map(),
    visible_timeline: [],
    session_t0: performance.now(),
  };

  function chunkIdFromInit(init, url) {
    const h = init?.headers;
    let range = "";
    if (h instanceof Headers) range = h.get("Range") || h.get("range") || "";
    else if (h && typeof h === "object") range = h.Range || h.range || "";
    if (!range && init?._proactiveRange) range = init._proactiveRange;
    if (range && range.startsWith("bytes=")) return `${url}::${range}`;
    return range ? `${url}::${range}` : `full:${url}`;
  }

  function rangeKeyFromCid(cid) {
    const m = String(cid).match(/bytes=\d+-\d+/);
    return m ? m[0] : "";
  }

  function urlFromCid(cid) {
    const s = String(cid);
    const idx = s.indexOf("::");
    return idx >= 0 ? s.slice(0, idx) : s.replace(/::bytes=.*$/, "");
  }

  const manifest = window.__proactiveRadManifest || [];
  let chunkIndexToRange = null;

  function getChunkIndexToRange() {
    if (chunkIndexToRange && chunkIndexToRange.length > 0) return chunkIndexToRange;
    const src = window.__proactiveRadManifest || manifest;
    if (!src.length) return [];
    const sorted = [...src].sort((a, b) => {
      const sa = Number(String(a.range || "").match(/bytes=(\d+)/)?.[1] || 0);
      const sb = Number(String(b.range || "").match(/bytes=(\d+)/)?.[1] || 0);
      return sa - sb;
    });
    chunkIndexToRange = sorted.map((e) => e.range);
    return chunkIndexToRange;
  }

  function cidFromRange(url, range) {
    if (!range) return `full:${url}`;
    return `${url}::${range}`;
  }

  function rangeFromSparkChunk(url, chunkIdx) {
    const ranges = getChunkIndexToRange();
    const range = ranges[chunkIdx];
    if (!range) return null;
    return cidFromRange(url, range);
  }

  function getPose() {
    const cam = window.__slDiagCamera || window.__proactiveLastCamera;
    if (!cam) return { t: performance.now() - state.session_t0, x: 0, y: 0, z: 0 };
    return {
      t: performance.now() - state.session_t0,
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
      qx: cam.quaternion?.x,
      qy: cam.quaternion?.y,
      qz: cam.quaternion?.z,
      qw: cam.quaternion?.w,
    };
  }

  function emptyChunk(cid) {
    const url = urlFromCid(cid);
    const range_header = rangeKeyFromCid(cid);
    return {
      chunk_id: cid,
      url,
      range_header,
      // demand & rendering
      needed_time: null,
      visible_time: null,
      ready_time: null,
      ready_event_used: null,
      // P0-2: full pipeline timestamps (all in ms relative to session_t0)
      prefetch_enqueue_time: null,    // READY decided to prefetch
      prefetch_request_start: null,   // Worker postMessage / fetch initiated
      fetch_start_time: null,         // legacy alias of prefetch_request_start (kept)
      first_byte_time: null,          // CDP Network.responseReceived
      response_start_time: null,      // legacy alias
      response_end_time: null,        // CDP Network.loadingFinished
      fetch_end_time: null,           // legacy alias of response_end_time
      parse_start_time: null,         // worker decode start (Spark or READY)
      predecode_start_time: null,     // READY-only: __sparkWorkerPool.withWorker called
      predecode_end_time: null,       // READY-only: workerPool result resolved
      parse_complete_time: null,      // either Spark parse_complete or predecode_end
      cache_lookup_time: null,        // fetch intercept began cache check
      cache_hit_time: null,           // cache returned Response (decoded or raw)
      cache_hit_kind: null,           // "decoded" | "raw" | "miss"
      gpu_upload_start_time: null,    // Spark upload_start event
      gpu_upload_end_time: null,      // Spark upload_complete event
      upload_time: null,              // legacy alias of gpu_upload_end_time
      // derived flags
      deadline_miss_50: null,
      deadline_miss_100: null,
      useful_before_demand: null,
      bytes: 0,
      source_baseline: baselineCode,
      // legacy aliases (kept for backward compat with old analyzers)
      chunk_needed_time: null,
      chunk_prefetch_start_time: null,
      chunk_fetch_complete_time: null,
      chunk_parse_complete_time: null,
      chunk_upload_complete_time: null,
      chunk_ready_time: null,
    };
  }

  function ensureChunk(cid) {
    if (!state.chunk_states.has(cid)) {
      state.chunk_states.set(cid, emptyChunk(cid));
    }
    return state.chunk_states.get(cid);
  }

  function computeReady(ch) {
    if (ch.upload_time != null) {
      ch.ready_time = ch.upload_time;
      ch.ready_event_used = "upload";
    } else if (ch.visible_time != null) {
      ch.ready_time = ch.visible_time;
      ch.ready_event_used = "visible";
    } else if (ch.parse_complete_time != null) {
      ch.ready_time = ch.parse_complete_time;
      ch.ready_event_used = "parse_complete_proxy";
    } else {
      ch.ready_time = null;
      ch.ready_event_used = null;
    }
    ch.chunk_ready_time = ch.ready_time;
    return ch;
  }

  function updateDeadlineFlags(ch) {
    const needed = ch.needed_time;
    const ready = ch.ready_time;
    if (needed == null || ready == null) {
      ch.deadline_miss_50 = null;
      ch.deadline_miss_100 = null;
      ch.useful_before_demand = null;
      return;
    }
    ch.deadline_miss_50 = ready > needed + 50;
    ch.deadline_miss_100 = ready > needed + 100;
    ch.useful_before_demand = ready <= needed;
  }

  window.__proactiveChunkProbe = {
    state,
    noteDemand(url, init, source) {
      const cid = chunkIdFromInit(init, url);
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.needed_time == null) {
        ch.needed_time = t;
        ch.chunk_needed_time = t;
        ch.source = source || "on_demand";
        state.demand.push({
          chunk_id: cid,
          chunk_needed_time: t,
          needed_time: t,
          url,
          range_header: rangeKeyFromCid(cid) || cid,
          pose: getPose(),
          source: ch.source,
        });
      }
      return cid;
    },
    notePrefetchEnqueue(cid, meta) {
      // Called by READY controller when a chunk is added to the prefetch queue,
      // BEFORE the worker actually issues a request. Distinct from prefetch_request_start.
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.prefetch_enqueue_time == null) ch.prefetch_enqueue_time = t;
      if (meta?.source_baseline) ch.source_baseline = meta.source_baseline;
      state.prefetch.push({ event: "prefetch_enqueue", chunk_id: cid, t, ...meta });
    },
    notePrefetchStart(cid, meta) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.prefetch_request_start == null) ch.prefetch_request_start = t;
      if (ch.fetch_start_time == null) ch.fetch_start_time = t;
      ch.chunk_prefetch_start_time = ch.fetch_start_time;
      if (meta?.source_baseline) ch.source_baseline = meta.source_baseline;
      state.prefetch.push({ event: "prefetch_start", chunk_id: cid, t, ...meta });
    },
    noteFetchStart(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.prefetch_request_start == null) ch.prefetch_request_start = t;
      if (ch.fetch_start_time == null) ch.fetch_start_time = t;
      if (ch.response_start_time == null) ch.response_start_time = t;
    },
    noteFirstByte(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.first_byte_time == null) ch.first_byte_time = t;
      if (ch.response_start_time == null) ch.response_start_time = t;
    },
    noteResponseEnd(cid, bytes) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.response_end_time == null) ch.response_end_time = t;
      if (ch.fetch_end_time == null) ch.fetch_end_time = t;
      ch.chunk_fetch_complete_time = t;
      if (bytes) ch.bytes = bytes;
      state.prefetch.push({ event: "response_end", chunk_id: cid, t, bytes: ch.bytes });
    },
    noteFetchComplete(cid, bytes) {
      // Backward-compatible alias for noteResponseEnd.
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.response_end_time == null) ch.response_end_time = t;
      ch.fetch_end_time = t;
      ch.chunk_fetch_complete_time = t;
      ch.bytes = bytes || ch.bytes;
      state.prefetch.push({ event: "fetch_complete", chunk_id: cid, t, bytes: ch.bytes });
    },
    noteParseStart(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.parse_start_time == null) ch.parse_start_time = t;
    },
    notePredecodeStart(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.predecode_start_time == null) ch.predecode_start_time = t;
      if (ch.parse_start_time == null) ch.parse_start_time = t;
    },
    notePredecodeEnd(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.predecode_end_time == null) ch.predecode_end_time = t;
      ch.parse_complete_time = t;
      ch.chunk_parse_complete_time = t;
      computeReady(ch);
      updateDeadlineFlags(ch);
      state.prefetch.push({ event: "predecode_end", chunk_id: cid, t });
    },
    noteCacheLookup(cid, range) {
      // Called by fetch intercept BEFORE the cache check decides hit/miss.
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.cache_lookup_time == null) ch.cache_lookup_time = t;
    },
    noteCacheHit(cid, kind) {
      // kind: "decoded" | "raw"
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.cache_hit_time == null) ch.cache_hit_time = t;
      if (ch.cache_hit_kind == null) ch.cache_hit_kind = kind;
      state.prefetch.push({ event: "cache_hit", chunk_id: cid, t, kind });
    },
    noteCacheMiss(cid) {
      const ch = ensureChunk(cid);
      if (ch.cache_hit_kind == null) ch.cache_hit_kind = "miss";
    },
    noteUploadStart(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.gpu_upload_start_time == null) ch.gpu_upload_start_time = t;
    },
    noteParseComplete(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.parse_start_time == null) ch.parse_start_time = t;
      ch.parse_complete_time = t;
      ch.chunk_parse_complete_time = t;
      computeReady(ch);
      updateDeadlineFlags(ch);
      state.prefetch.push({ event: "parse_complete", chunk_id: cid, t });
    },
    noteUploadComplete(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.gpu_upload_end_time == null) ch.gpu_upload_end_time = t;
      ch.upload_time = t;
      ch.chunk_upload_complete_time = t;
      computeReady(ch);
      updateDeadlineFlags(ch);
      state.prefetch.push({ event: "upload_complete", chunk_id: cid, t });
    },
    noteVisible(cid) {
      const ch = ensureChunk(cid);
      const t = performance.now() - state.session_t0;
      if (ch.visible_time == null) {
        ch.visible_time = t;
        computeReady(ch);
        updateDeadlineFlags(ch);
      }
    },
    sampleVisible() {
      const c = window.__ablationReadSplatCounts?.() ?? {};
      const vis = Number(c.visible_splat_count ?? c.rendered_splat_count ?? 0) || 0;
      const t = performance.now() - state.session_t0;
      state.visible_timeline.push({ t, visible_splat_count: vis });
      return vis;
    },
    getSnapshot() {
      const chunks = [...state.chunk_states.values()].map((ch) => {
        computeReady(ch);
        updateDeadlineFlags(ch);
        return ch;
      });
      const demandSet = new Set(state.demand.map((d) => d.chunk_id));
      let useful_before = 0;
      let miss50 = 0;
      let miss100 = 0;
      let wasted_bytes = 0;
      let total_received = 0;
      let useful_bytes = 0;
      const readyEventCounts = {};

      for (const ch of chunks) {
        if (ch.bytes > 0) total_received += ch.bytes;
        if (ch.ready_event_used) {
          readyEventCounts[ch.ready_event_used] = (readyEventCounts[ch.ready_event_used] || 0) + 1;
        }
        const needed = ch.needed_time;
        const ready = ch.ready_time;
        if (needed != null && ready != null) {
          if (ready <= needed) useful_before += 1;
          if (ready > needed + 50) miss50 += 1;
          if (ready > needed + 100) miss100 += 1;
          if (ch.bytes > 0) useful_bytes += ch.bytes;
        } else if (ch.fetch_start_time != null && !demandSet.has(ch.chunk_id) && ch.bytes > 0) {
          wasted_bytes += ch.bytes;
        }
      }

      const demanded = state.demand.length;
      const parseFilled = chunks.filter((c) => c.parse_complete_time != null).length;
      const parseFillRate = chunks.length ? parseFilled / chunks.length : 0;

      // P0-2: cache hit breakdown over demanded chunks
      let decodedHits = 0;
      let rawHits = 0;
      let networkFallthrough = 0;
      for (const ch of chunks) {
        if (ch.needed_time == null) continue; // only count demanded chunks
        if (ch.cache_hit_kind === "decoded") decodedHits += 1;
        else if (ch.cache_hit_kind === "raw") rawHits += 1;
        else networkFallthrough += 1;
      }
      const totalDemanded = decodedHits + rawHits + networkFallthrough;
      const cacheHitBreakdown = {
        decoded_hit_pct: totalDemanded ? (decodedHits / totalDemanded) * 100 : 0,
        raw_hit_pct: totalDemanded ? (rawHits / totalDemanded) * 100 : 0,
        network_fallthrough_pct: totalDemanded ? (networkFallthrough / totalDemanded) * 100 : 0,
        total_demanded_chunks: totalDemanded,
        decoded_hit_count: decodedHits,
        raw_hit_count: rawHits,
        network_fallthrough_count: networkFallthrough,
      };
      // Pull duplicate/token-bucket counters from the controller-side state
      const controllerCounters = window.__proactiveBreakdownCounters || {};
      cacheHitBreakdown.duplicate_prefetch_skipped = controllerCounters.duplicate_prefetch_skipped || 0;
      cacheHitBreakdown.prefetch_paused_by_token_bucket = controllerCounters.prefetch_paused_by_token_bucket || 0;
      cacheHitBreakdown.prefetch_paused_by_recent_demand = controllerCounters.prefetch_paused_by_recent_demand || 0;
      cacheHitBreakdown.prefetch_paused_by_combined_inflight = controllerCounters.prefetch_paused_by_combined_inflight || 0;
      cacheHitBreakdown.prefetch_queue_full_dropped = controllerCounters.prefetch_queue_full_dropped || 0;
      cacheHitBreakdown.prefetch_pump_total = controllerCounters.prefetch_pump_total || 0;
      cacheHitBreakdown.duplicate_prefetch_skipped_pct = totalDemanded
        ? ((controllerCounters.duplicate_prefetch_skipped || 0) / totalDemanded) * 100
        : 0;
      cacheHitBreakdown.prefetch_paused_by_token_bucket_pct = controllerCounters.prefetch_pump_total
        ? ((controllerCounters.prefetch_paused_by_token_bucket || 0) / controllerCounters.prefetch_pump_total) * 100
        : 0;
      cacheHitBreakdown.prefetch_paused_total_pct = controllerCounters.prefetch_pump_total
        ? (((controllerCounters.prefetch_paused_by_token_bucket || 0)
            + (controllerCounters.prefetch_paused_by_recent_demand || 0)
            + (controllerCounters.prefetch_paused_by_combined_inflight || 0))
            / controllerCounters.prefetch_pump_total) * 100
        : 0;

      // fast_but_empty: high FPS + low useful content + no visible splats
      // Must check visible_splat_count to avoid false positives when content IS rendering
      const lastVis = state.visible_timeline?.length
        ? state.visible_timeline[state.visible_timeline.length - 1]?.visible_splat_count ?? 0
        : 0;
      const fast_but_empty =
        (window.__stutterDiag?.measure_frame_times?.length || 0) > 30 &&
        useful_before < Math.max(3, demanded * 0.05) &&
        lastVis === 0;

      const ready_event_used =
        Object.keys(readyEventCounts).sort((a, b) => readyEventCounts[b] - readyEventCounts[a])[0] || null;

      return {
        baseline: state.baseline,
        source_baseline: state.source_baseline,
        demand_trace: state.demand,
        prefetch_trace: state.prefetch,
        chunk_states: chunks,
        visible_splat_timeline: state.visible_timeline,
        useful_chunks_before_demand: useful_before,
        demanded_chunks: demanded,
        deadline_miss_ratio_50ms: demanded ? miss50 / demanded : 0,
        deadline_miss_ratio_100ms: demanded ? miss100 / demanded : 0,
        wasted_prefetch_bytes: wasted_bytes,
        total_received_bytes: total_received,
        useful_bytes_ratio: total_received > 0 ? useful_bytes / total_received : 0,
        fast_but_empty_detected: fast_but_empty,
        ready_event_used,
        ready_event_counts: readyEventCounts,
        parse_complete_fill_rate: parseFillRate,
        // P0-2 additions
        cache_hit_breakdown: cacheHitBreakdown,
        breakdown_counters: {
          duplicate_prefetch_skipped: controllerCounters.duplicate_prefetch_skipped || 0,
          prefetch_paused_by_token_bucket: controllerCounters.prefetch_paused_by_token_bucket || 0,
          prefetch_paused_by_recent_demand: controllerCounters.prefetch_paused_by_recent_demand || 0,
          prefetch_paused_by_combined_inflight: controllerCounters.prefetch_paused_by_combined_inflight || 0,
          prefetch_queue_full_dropped: controllerCounters.prefetch_queue_full_dropped || 0,
          prefetch_pump_total: controllerCounters.prefetch_pump_total || 0,
        },
        continuous_tick_count: window.__readyContinuousTickCount || 0,
        session_prior_used: !!window.__readySessionPriorUsed,
        metrics_version: 6,
      };
    },
  };

  const sparkEnqueue = new Map();

  const prevSparkHook = window.__sparkExpEvent;
  window.__sparkExpEvent = function proactiveSparkHook(evt) {
    const url = evt?.object_url || evt?.object_id || "";
    if (evt?.type === "fetch_enqueue") {
      const cid = rangeFromSparkChunk(url, evt.chunk);
      if (cid) sparkEnqueue.set(cid, performance.now() - state.session_t0);
    }
    if (evt?.type === "fetch_response") {
      const cid = rangeFromSparkChunk(url, evt.chunk);
      if (cid) {
        const t = performance.now() - state.session_t0;
        const ch = ensureChunk(cid);
        if (ch.needed_time == null) {
          ch.needed_time = sparkEnqueue.get(cid) ?? t;
          ch.chunk_needed_time = ch.needed_time;
        }
        ch.fetch_end_time = t;
        ch.chunk_fetch_complete_time = t;
        ch.chunk_prefetch_start_time = sparkEnqueue.get(cid) ?? null;
        // Record bytes from range header or event
        if (evt.bytes) ch.bytes = evt.bytes;
        else if (!ch.bytes) {
          const rk = rangeKeyFromCid(cid);
          const m = rk.match(/bytes=(\d+)-(\d+)/);
          if (m) ch.bytes = Number(m[2]) - Number(m[1]) + 1;
        }
      }
    }
    if (evt?.type === "parse_start") {
      const cid = rangeFromSparkChunk(url, evt.chunk);
      if (cid) {
        const t = performance.now() - state.session_t0;
        const ch = ensureChunk(cid);
        ch.parse_start_time = t;
        ch.chunk_parse_start_time = t;
      }
    }
    if (evt?.type === "parse_complete") {
      const cid = rangeFromSparkChunk(url, evt.chunk);
      if (cid) {
        const t = performance.now() - state.session_t0;
        const ch = ensureChunk(cid);
        ch.parse_complete_time = t;
        ch.chunk_parse_complete_time = t;
        computeReady(ch);
        updateDeadlineFlags(ch);
      }
    }
    if (evt?.type === "upload_start") {
      // upload_start uses page id, map back via recent parse_complete chunks
      const t = performance.now() - state.session_t0;
      // Store for pairing with upload_complete
      if (!state._pendingUploadStart) state._pendingUploadStart = new Map();
      state._pendingUploadStart.set(evt.page, t);
    }
    if (evt?.type === "upload_complete") {
      const t = performance.now() - state.session_t0;
      const startT = state._pendingUploadStart?.get(evt.page);
      // Find the most recent chunk that was parsed but not yet uploaded
      for (const ch of state.chunk_states.values()) {
        if (ch.parse_complete_time != null && ch.upload_time == null) {
          ch.chunk_upload_start_time = startT ?? t;
          ch.chunk_upload_complete_time = t;
          ch.upload_time = t;
          computeReady(ch);
          updateDeadlineFlags(ch);
          break;
        }
      }
      state._pendingUploadStart?.delete(evt.page);
    }
    if (typeof prevSparkHook === "function") prevSparkHook(evt);
  };

  const iv = setInterval(() => window.__proactiveChunkProbe.sampleVisible(), 500);
  window.__proactiveStopVisibleSampler = () => clearInterval(iv);
})();
