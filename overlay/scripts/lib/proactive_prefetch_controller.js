/**
 * READY paper baselines on Spark/WebGL/HTTP Range substrate.
 * READY = remote-aware, deadline-driven readiness controller (not viewport-only prefetch).
 * Methods: Spark-OD, Naive-PF, PRoGS, SGSS, READY-P, READY-E, READY-G, READY, Oracle
 * Legacy codes READY-V/I/D/B still map via ready_core.methodFlags.
 * (Internal URL params remain VRC_PROACTIVE_* — instrumentation module name in-tree.)
 */
(function proactivePrefetchControllerBootstrap() {
  const u = new URLSearchParams(location.search);
  if (u.get("VRC_PROACTIVE") !== "1") return;

  const baseline = u.get("VRC_PROACTIVE_BASELINE") || "B0";
  const horizonMs = Number(u.get("VRC_PREDICTION_HORIZON_MS")) || 2000;
  const parseBudgetPerSec = Number(u.get("VRC_PARSE_BUDGET_CPS")) || 24;
  const budget = Number(u.get("VRC_PREFETCH_BUDGET_BYTES")) || 128 * 1024 * 1024;
  const maxParallel = Number(u.get("VRC_PREFETCH_MAX_PARALLEL")) || 2;
  const radUrl = u.get("VRC_RAD_URL") || "";
  const manifest = window.__proactiveRadManifest || [];
  const cache = new Map();
  const pendingRanges = new Set(); // ranges currently in queue or in-flight (dedup)
  let bytesUsed = 0;
  let scheduled = false;
  const poseHistory = [];
  let inFlight = 0;
  const queue = [];
  let worker = null;
  let workerJobs = new Map();
  let jobSeq = 0;
  let parseTokens = parseBudgetPerSec;
  let parsedChunks = 0;

  // DIAG: unconditionally init at IIFE top so it's always non-null at snapshot
  window.__cacheKeyDiag = {
    writes: [], reads: [], cacheSize: 0,
    workerUrlAtInit: !!window.__proactivePrefetchWorkerUrl,
    workerCreated: false,
    workerNullCount: 0,
    getWorkerCalls: 0,
    jobDispatched: 0,
    jobResolvedNull: 0,
    rawHitReturns: 0,
    decodedHitReturns: 0,
    missReturns: 0,
  };

  setInterval(() => {
    parseTokens = Math.min(parseBudgetPerSec, parseTokens + parseBudgetPerSec);
  }, 1000);

  function methodFlags(code) {
    if (window.__readyCore?.methodFlags) return window.__readyCore.methodFlags(code);
    const c = String(code || "B0");
    return { code: c, isSparkOd: c === "B0", readyAware: c !== "B0", useReadyController: false };
  }

  const flags = methodFlags(baseline);
  let readyController = null;
  const bytesUsedRef = { value: bytesUsed };
  const isReady = flags.readyAware;

  function fullCid(range) {
    return radUrl ? `${radUrl}::${range}` : range;
  }

  const sortedManifest = [...manifest].sort((a, b) => {
    const sa = Number(String(a.range || "").match(/bytes=(\d+)/)?.[1] || 0);
    const sb = Number(String(b.range || "").match(/bytes=(\d+)/)?.[1] || 0);
    return sa - sb;
  });

  function recordPose() {
    const cam = window.__slDiagCamera;
    if (!cam) return;
    window.__proactiveLastCamera = cam;
    poseHistory.push({
      t: performance.now(),
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
    });
    if (poseHistory.length > 120) poseHistory.shift();
  }

  function predictPose(horizon) {
    if (poseHistory.length < 2) return poseHistory[poseHistory.length - 1] || { x: 0, y: 0, z: 0 };
    const a = poseHistory[poseHistory.length - 2];
    const b = poseHistory[poseHistory.length - 1];
    const dt = Math.max(1, b.t - a.t);
    const scale = horizon / dt;
    return {
      x: b.x + (b.x - a.x) * scale,
      y: b.y + (b.y - a.y) * scale,
      z: b.z + (b.z - a.z) * scale,
    };
  }

  /** SGSS / READY view-adaptive score */
  function viewScore(ent, pose) {
    const range = ent.range || "";
    const m = range.match(/bytes=(\d+)-(\d+)/);
    const start = m ? Number(m[1]) : 0;
    const viewport_relevance = 1 / (1 + start / 65536);
    const lod_importance = ent.encoded_bytes ? Math.min(1, ent.encoded_bytes / 65536) : 0.5;
    const dist = Math.abs(pose.x) * 0.1 + Math.abs(pose.y) * 0.1 + Math.abs(pose.z) * 0.01;
    return viewport_relevance * 2 + lod_importance - dist * 0.01;
  }

  /** PRoGS-style fixed progressive score (contribution / first-paint / early-representative) */
  function progsScore(ent, idx) {
    const range = ent.range || "";
    const m = range.match(/bytes=(\d+)-(\d+)/);
    const start = m ? Number(m[1]) : idx * 65536;
    const size = ent.encoded_bytes || (m ? Number(m[2]) - Number(m[1]) + 1 : 65536);
    const contribution = Math.min(1, size / 32768);
    const firstPaint = 1 / (1 + start / 131072);
    const smallVisible = size < 49152 ? 0.5 : 0;
    const earlyRep = 1 / (1 + idx * 0.05);
    return contribution * 2 + firstPaint * 3 + smallVisible + earlyRep;
  }

  function firstVisibleBoost(ent) {
    const range = ent.range || "";
    const start = Number(String(range).match(/bytes=(\d+)/)?.[1] || 0);
    if (start < 65536) return 4.0;
    if (start < 262144) return 2.5;
    if (start < 1048576) return 0.75;
    return 0;
  }

  function parseCostPenalty(ent) {
    if (!flags.useBudget) return 0;
    // Only penalize when budget is under pressure (>70% used)
    if (bytesUsed < budget * 0.7) return 0;
    const size = ent.encoded_bytes || 65536;
    return Math.min(0.3, size / 1048576);
  }

  function wasteRiskPenalty(ent, pose) {
    if (!flags.useWasteAware) return 0;
    // Only penalize when budget is under pressure (>70% used)
    if (bytesUsed < budget * 0.7) return 0;
    return viewScore(ent, pose) < 0.2 ? 0.3 : 0;
  }

  function deadlineUrgency(ent, nowMs) {
    // Use B0 reference demand (set by trial cell) OR oracle demand
    const refDemand = window.__proactiveReferenceDemand || window.__proactiveOracleDemand || [];
    if (!refDemand.length) return 0;
    const rk = ent.range;
    const entry = refDemand.find((d) => (d.range_header || d.chunk_id || "").includes(rk))
      || refDemand.find((d) => (d.range_header || "").match(/bytes=\d+-\d+/)?.[0] === rk);
    const need = entry?.chunk_needed_time ?? entry?.needed_time;
    if (need == null) return 0;
    const slack = need - nowMs;
    if (slack <= 0) return 5;
    if (slack < 200) return 3;
    if (slack < 500) return 1.5;
    if (slack < 1000) return 0.5;
    return 0;
  }

  function vrcScore(ent, pose, nowMs) {
    let s = viewScore(ent, pose);
    if (flags.useFirstVisible) s += firstVisibleBoost(ent);
    if (flags.useDeadline) s += deadlineUrgency(ent, nowMs);
    s -= parseCostPenalty(ent);
    s -= wasteRiskPenalty(ent, pose);
    return s;
  }

  function getWorker() {
    if (worker) return worker;
    window.__cacheKeyDiag.getWorkerCalls += 1;
    const src = window.__proactivePrefetchWorkerUrl;
    if (!src) {
      window.__cacheKeyDiag.workerNullCount += 1;
      return null;
    }
    worker = new Worker(src);
    window.__cacheKeyDiag.workerCreated = true;
    worker.onmessage = (ev) => {
      const msg = ev.data;
      const job = workerJobs.get(msg.id);
      if (job?.tFetch0) job.fetchMs = performance.now() - job.tFetch0;
      workerJobs.delete(msg.id);
      inFlight = Math.max(0, inFlight - 1);
      if (msg.ok && job) {
        bytesUsed += msg.bytes || 0;
        bytesUsedRef.value = bytesUsed;
        const entry = { buffer: msg.buffer, status: msg.status || 206 };
        cache.set(msg.range, entry);
        pendingRanges.delete(msg.range);
        // DIAG: record first 10 cache write keys
        window.__cacheKeyDiag = window.__cacheKeyDiag || { writes: [], reads: [], cacheSize: 0 };
        if (window.__cacheKeyDiag.writes.length < 10) {
          window.__cacheKeyDiag.writes.push(msg.range);
        }
        window.__cacheKeyDiag.cacheSize = cache.size;
        const cid = fullCid(msg.range);
        const fetchMs = job.fetchMs ?? 0;
        window.__proactiveChunkProbe?.noteFetchComplete(cid, msg.bytes);
        const ent = sortedManifest.find((e) => e.range === msg.range);
        const chunkIdx = sortedManifest.indexOf(ent);
        if (flags.useReadyController && readyController && ent) {
          readyController.onFetchComplete(ent, cid, fetchMs, fetchMs < 30);
          parsedChunks += 1;
          // Pre-decode via Spark worker pool for any baseline with usePredecode flag
          // (READY-B, READY-R, READY, READY-S; also Oracle+PD via window override)
          if ((flags.usePredecode || window.__oraclePDPreDecode) && entry.buffer && chunkIdx >= 0) {
            preDecodeChunk(entry.buffer, chunkIdx, cid);
          }
        } else if (isReady) {
          if (flags.useBudget) parseTokens = Math.max(0, parseTokens - 1);
          parsedChunks += 1;
          try {
            const dv = new Uint8Array(entry.buffer);
            let sum = 0;
            const step = Math.max(1, Math.floor(dv.length / 4096));
            for (let i = 0; i < dv.length; i += step) sum = (sum + dv[i]) | 0;
            entry.__parseSum = sum;
          } catch (_) { /* */ }
          window.__proactiveChunkProbe?.noteParseComplete(cid);
        }
      }
      pumpQueue();
    };
    worker.onerror = () => {
      inFlight = Math.max(0, inFlight - 1);
      pumpQueue();
    };
    return worker;
  }

  /** Pre-decode a fetched chunk via Spark's worker pool and stash in __sparkPrefetchedDecoded. */
  function preDecodeChunk(buffer, chunkIdx, cid) {
    const wp = window.__sparkWorkerPool;
    if (!wp) return;
    const rootUrl = radUrl.split("?")[0]; // Strip query params for cache key
    window.__proactiveChunkProbe?.notePredecodeStart?.(cid);
    wp.withWorker(async (w) => {
      try {
        // CRITICAL: copy the buffer before passing to worker. The worker's
        // postMessage uses Transferable which DETACHES the original ArrayBuffer.
        // Without this copy, cache.get(range).buffer becomes 0-length and
        // subsequent raw-hit responses return empty bytes → Spark retry loop.
        const fileBytes = new Uint8Array(buffer.slice(0));
        const result = await w.call("loadPackedSplats", {
          fileBytes,
          pathName: rootUrl,
        });
        if (result?.lodSplats) {
          window.__sparkPrefetchedDecoded = window.__sparkPrefetchedDecoded || {};
          window.__sparkPrefetchedDecoded[rootUrl] = window.__sparkPrefetchedDecoded[rootUrl] || new Map();
          window.__sparkPrefetchedDecoded[rootUrl].set(chunkIdx, result);
          // notePredecodeEnd records predecode_end_time AND parse_complete_time.
          // GPU upload happens later when Spark demands the chunk; do NOT mark
          // upload_complete here.
          window.__proactiveChunkProbe?.notePredecodeEnd?.(cid);
        }
      } catch (e) {
        // Pre-decode failed — Spark will fetch+parse normally
      }
    });
  }

  function fetchChunkInWorker(url, range) {
    return new Promise((resolve) => {
      if (cache.has(range)) {
        const hit = cache.get(range);
        const ent = sortedManifest.find((e) => e.range === range);
        const cid = fullCid(range);
        if (flags.useReadyController && readyController && ent) {
          readyController.onFetchComplete(ent, cid, 0, true);
        }
        resolve(hit);
        return;
      }
      if (flags.useBudget && bytesUsed >= budget) {
        resolve(null);
        return;
      }
      if (!flags.useBudget && bytesUsed >= budget * 4) {
        resolve(null);
        return;
      }
      const w = getWorker();
      if (!w) {
        window.__cacheKeyDiag.jobResolvedNull += 1;
        resolve(null);
        return;
      }
      const cid = fullCid(range);
      const tFetch0 = performance.now();
      window.__proactiveChunkProbe?.notePrefetchStart(cid, { baseline, source_baseline: baseline });
      const id = ++jobSeq;
      workerJobs.set(id, { range, fetchMs: 0, tFetch0 });
      window.__cacheKeyDiag.jobDispatched += 1;
      w.postMessage({ id, url, range });
      const iv = setInterval(() => {
        if (cache.has(range)) {
          clearInterval(iv);
          resolve(cache.get(range));
        }
      }, 50);
      setTimeout(() => {
        clearInterval(iv);
        resolve(cache.get(range) || null);
      }, 120000);
    });
  }

  const downstreamFetch = globalThis.fetch.bind(globalThis);
  let onDemandInFlight = 0;
  let lastOnDemandT = -Infinity;

  // Unified admission control (P0-4 back-pressure fix, v3).
  //
  // v2 used a combined in-flight cap (inFlight + onDemandInFlight >= maxParallel)
  // which starved prefetch on high-RTT links: with maxParallel=3 and Spark always
  // having 1-2 demands in flight, prefetch got at most 1-2 slots → only 8 fetches
  // dispatched in 40s on GCS (1.3s RTT).
  //
  // v3: SEPARATE pools. Demand uses the browser's native concurrency (no cap from
  // us). Prefetch has its own dedicated pool of `maxParallel` slots. The only
  // interaction: a short cooldown after each demand completes, to avoid
  // bursting prefetch into a demand-heavy window.
  // READY-DS uses strict idle-window: onDemandInFlight must be 0 AND 300ms since last demand.
  const ON_DEMAND_HOT_MS = flags.useDemandSafe ? 300 : 100;
  const MAX_QUEUE_SIZE = flags.useDemandSafe ? 8 : 32;

  // P0-2 cache breakdown counters (exposed via __proactiveBreakdownCounters)
  const breakdownCounters = {
    duplicate_prefetch_skipped: 0,
    prefetch_paused_by_token_bucket: 0,
    prefetch_paused_by_recent_demand: 0,
    prefetch_paused_by_combined_inflight: 0,
    prefetch_paused_by_demand_active: 0,     // READY-DS: onDemandInFlight > 0
    prefetch_queue_full_dropped: 0,
    prefetch_pump_total: 0,
  };
  window.__proactiveBreakdownCounters = breakdownCounters;

  function pumpQueue() {
    breakdownCounters.prefetch_pump_total += 1;
    while (inFlight < maxParallel && queue.length > 0) {
      if (flags.useBudget && bytesUsed >= budget) break;
      // READY-DS strict idle-window: no prefetch while ANY demand is in flight
      if (flags.useDemandSafe && onDemandInFlight > 0) {
        breakdownCounters.prefetch_paused_by_demand_active += 1;
        break;
      }
      // Short cooldown: don't burst prefetch right after a demand completes
      if (performance.now() - lastOnDemandT < ON_DEMAND_HOT_MS) {
        breakdownCounters.prefetch_paused_by_recent_demand += 1;
        break;
      }
      const job = queue.shift();
      inFlight += 1;
      job().finally(() => {
        inFlight = Math.max(0, inFlight - 1);
        pumpQueue();
      });
    }
  }

  function enqueuePrefetch(url, range, priority) {
    if (cache.has(range) || pendingRanges.has(range)) {
      breakdownCounters.duplicate_prefetch_skipped += 1;
      return;
    }
    if (flags.useBudget && bytesUsed >= budget) return;
    const pri = priority ?? 0;
    // Bound queue size; drop or displace by priority. Continuous tick at 200 ms
    // re-issues prefetches every cycle, so without this cap the queue grows
    // unboundedly and dispatches stale priorities long after they matter.
    if (queue.length >= MAX_QUEUE_SIZE) {
      queue.sort((a, b) => (b._pri || 0) - (a._pri || 0));
      const lowest = queue[queue.length - 1]?._pri ?? 0;
      if (pri <= lowest) {
        breakdownCounters.prefetch_queue_full_dropped += 1;
        return;
      }
      queue.pop();
      breakdownCounters.prefetch_queue_full_dropped += 1;
    }
    // Notify probe of prefetch enqueue (P0-2 timestamp)
    const cid = fullCid(range);
    window.__proactiveChunkProbe?.notePrefetchEnqueue?.(cid, {
      baseline,
      source_baseline: baseline,
      priority: pri,
    });
    pendingRanges.add(range);
    const job = () => fetchChunkInWorker(url, range);
    job._pri = pri;
    queue.push(job);
    queue.sort((a, b) => (b._pri || 0) - (a._pri || 0));
    pumpQueue();
  }

  function scheduleRanked(scoredEntries, limit) {
    const cap = limit ?? scoredEntries.length;
    const sorted = [...scoredEntries].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (let i = 0; i < Math.min(cap, sorted.length); i++) {
      if (flags.useBudget && bytesUsed >= budget) break;
      const { ent, score } = sorted[i];
      enqueuePrefetch(ent.url || radUrl, ent.range, score);
    }
  }

  function runNaive() {
    const scored = sortedManifest.slice(0, Math.min(32, sortedManifest.length)).map((ent, idx) => ({
      ent,
      score: 1000 - idx,
    }));
    scheduleRanked(scored, scored.length);
  }

  function runProgs() {
    const scored = sortedManifest
      .map((ent, idx) => ({ ent, score: progsScore(ent, idx) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(40, sortedManifest.length));
    scheduleRanked(scored, scored.length);
  }

  function runSgss() {
    const pose = poseHistory[poseHistory.length - 1] || { x: 0, y: 0, z: 0 };
    const nowMs = performance.now() - (window.__proactiveChunkProbe?.state?.session_t0 ?? performance.now());
    const scored = sortedManifest
      .map((ent) => ({ ent, score: viewScore(ent, pose) + (flags.useDeadline ? deadlineUrgency(ent, nowMs) : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(36, sortedManifest.length));
    scheduleRanked(scored, scored.length);
  }

  function runVrcFull() {
    const horizons = [horizonMs / 2, horizonMs, horizonMs * 2];
    const nowMs = performance.now() - (window.__proactiveChunkProbe?.state?.session_t0 ?? performance.now());

    // Estimate per-chunk fetch time from byte offset (LAN edge ~100MB/s, remote ~5MB/s)
    // Only prefetch chunks we can realistically fetch before they're needed
    const estimatedBandwidthBps = 100 * 1024 * 1024; // conservative LAN estimate
    const maxPrefetchTimeMs = 3000; // don't prefetch if estimated fetch > 3s
    const maxByteOffset = estimatedBandwidthBps * (maxPrefetchTimeMs / 1000); // ~300MB

    const eligible = sortedManifest.filter((ent) => {
      const m = String(ent.range || "").match(/bytes=(\d+)/);
      const start = m ? Number(m[1]) : 0;
      return start < maxByteOffset;
    });

    const merged = new Map();
    for (const h of horizons) {
      const pose = predictPose(h);
      for (const ent of eligible) {
        let score = viewScore(ent, pose);
        if (flags.useFirstVisible) score += firstVisibleBoost(ent);
        if (flags.useDeadline) score += deadlineUrgency(ent, nowMs);
        score -= parseCostPenalty(ent);
        score -= wasteRiskPenalty(ent, pose);
        const prev = merged.get(ent.range);
        if (!prev || score > prev.score) merged.set(ent.range, { ent, score });
      }
    }
    const sliceN = Math.min(48, Math.max(12, Math.ceil(eligible.length / 3)));
    const scored = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, sliceN);
    scheduleRanked(scored, scored.length);
  }

  function runVrcPredictionOnly() {
    const sliceN = Math.max(4, Math.ceil(sortedManifest.length / 12));
    const horizons = [horizonMs / 2, horizonMs, horizonMs * 2];
    const merged = new Map();
    for (const h of horizons) {
      const pose = predictPose(h);
      for (const ent of sortedManifest) {
        const score = viewScore(ent, pose);
        const prev = merged.get(ent.range);
        if (!prev || score > prev.score) merged.set(ent.range, { ent, score });
      }
    }
    const scored = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, sliceN * horizons.length);
    scheduleRanked(scored, scored.length);
  }

  function runOracle(perceptual) {
    const demandRef = window.__proactiveOracleDemand || [];
    const visibleArr = window.__proactiveVisibleGroundTruth || [];
    const visibleSet =
      visibleArr instanceof Set
        ? visibleArr
        : new Set(Array.isArray(visibleArr) ? visibleArr : []);
    const oracleType = perceptual ? "perceptual_ready" : "demand_time";
    const keySchema = window.__proactiveOracleKeySchema || "range_bytes";
    const prefetchCap = Math.min(48, sortedManifest.length);

    const audit = {
      oracle_type: oracleType,
      oracle_key_schema: keySchema,
      demandRef_length: demandRef.length,
      visibleSet_size: visibleSet.size,
      candidate_count: sortedManifest.length,
      selected_count: 0,
      visible_boost_count: 0,
      top10_selected_chunks: [],
      first_selected_need_time_ms: null,
      first_selected_is_visible_gt: false,
      oracle_input_valid: false,
      oracle_invalid_reason: null,
    };

    if (!demandRef.length) {
      audit.oracle_input_valid = false;
      audit.oracle_invalid_reason = "empty_demand";
      window.__oracleRunAudit = audit;
      return audit;
    }

    const byRange = new Map();
    for (const d of demandRef) {
      const rk = String(d.range_header || d.chunk_id || "").match(/bytes=\d+-\d+/)?.[0]
        || String(d.chunk_id || "").match(/bytes=\d+-\d+/)?.[0];
      if (rk) byRange.set(rk, d.chunk_needed_time ?? d.chunk_needed_time_ms ?? d.needed_time ?? 1e9);
    }

    let missingDemand = 0;
    const scored = sortedManifest
      .map((ent) => {
        const rk = ent.range;
        const hasDemand = byRange.has(rk);
        if (!hasDemand) missingDemand += 1;
        let need = hasDemand ? byRange.get(rk) : null;
        let boosted = false;
        if (need != null && perceptual && visibleSet.has(rk)) {
          need -= 500;
          boosted = true;
          audit.visible_boost_count += 1;
        }
        const score = need == null ? -1 : 1e9 - need;
        return { ent, score, need, boosted, hasDemand };
      })
      .filter((x) => x.hasDemand)
      .sort((a, b) => b.score - a.score);

    const selected = scored.slice(0, prefetchCap);
    audit.selected_count = selected.length;
    audit.missing_demand_ranges = missingDemand;
    if (selected.length) {
      audit.first_selected_need_time_ms = selected[0].need;
      audit.first_selected_is_visible_gt = visibleSet.has(selected[0].ent.range);
      audit.top10_selected_chunks = selected.slice(0, 10).map((s) => ({
        range: s.ent.range,
        need_time_ms: s.need,
        visible_boost: s.boosted,
      }));
    }

    if (!selected.length) {
      audit.oracle_input_valid = false;
      audit.oracle_invalid_reason = "no_manifest_demand_overlap";
    } else if (perceptual && audit.visible_boost_count <= 0) {
      audit.oracle_input_valid = false;
      audit.oracle_invalid_reason = "zero_perceptual_boost";
    } else {
      audit.oracle_input_valid = true;
    }

    window.__oracleRunAudit = audit;
    scheduleRanked(
      selected.map((s) => ({ ent: s.ent, score: s.score })),
      selected.length,
    );
    return audit;
  }

  function rangeOnly(cid) {
    const m = String(cid || "").match(/bytes=\d+-\d+/);
    return m ? m[0] : cid;
  }

  window.__proactiveStartPrefetch = function () {
    if (scheduled || flags.isSparkOd) return { skipped: true, baseline };
    scheduled = true;
    if (flags.isNaive) runNaive();
    else if (flags.isProgs) runProgs();
    else if (flags.isSgss || flags.isVrcV) runSgss();
    else if (flags.useReadyController && window.__readyCreateController) {
      // Unified READY family dispatch (READY-B / READY-P / READY-C / READY-R /
      // READY / READY-S, plus legacy READY-E / READY-G).
      // The controller reads flags.useBootSet, useMotionPrediction,
      // useContinuousScheduling, usePredecode, useSessionPrediction and
      // dispatches the correct mechanism subset.
      readyController = window.__readyCreateController({
        flags,
        manifest: sortedManifest,
        radUrl,
        cache,
        budget,
        bytesUsedRef,
        parseBudgetPerSec,
        enqueuePrefetch,
        fullCid,
      });
      readyController.start();
    } else if (flags.isOracle) {
      runOracle(true);
    } else if (flags.isDemandOracle) {
      runOracle(false);
    } else if (flags.isOraclePD) {
      // Legacy runtime "Upper Bound" — kept for compat. New evaluation uses the
      // offline analytical Upper Bound simulator; do not include in P1-1.
      window.__oraclePDPreDecode = true;
      runOracle(true);
      setInterval(() => { runOracle(true); }, 200);
    }
    else if (baseline === "B1") runNaive();
    else if (baseline === "B2") runProgs();
    else if (baseline === "B3R") runOracle(true);
    else if (baseline === "B4") runOracle(false);
    else if (baseline === "B4R") runOracle(true);
    const oracleAudit = window.__oracleRunAudit || null;
    return {
      scheduled: true,
      baseline,
      bytesUsed,
      cached: cache.size,
      maxParallel,
      max_parallel: maxParallel,
      budget,
      flags,
      horizon_ms: horizonMs,
      parse_budget_chunks_per_sec: parseBudgetPerSec,
      oracle_audit: oracleAudit,
    };
  };

  window.__proactiveGetReadyStats = function () {
    return {
      baseline,
      flags,
      parsed_chunks: parsedChunks,
      cache_size: cache.size,
      bytes_used: bytesUsed,
      horizon_ms: horizonMs,
      parse_budget_chunks_per_sec: parseBudgetPerSec,
      ready_controller: readyController?.getStats?.() ?? null,
    };
  };

  function extractRange(input, init) {
    const h = init?.headers;
    if (h instanceof Headers) return h.get("Range") || h.get("range") || "";
    if (h && typeof h === "object") return h.Range || h.range || "";
    if (input && typeof input !== "string" && input.headers) {
      return input.headers.get("Range") || input.headers.get("range") || "";
    }
    return init?._proactiveRange || "";
  }

  if (!globalThis.__proactiveFetchWrapped) {
    globalThis.__proactiveFetchWrapped = true;
    globalThis.fetch = async function proactiveFetch(input, init) {
      recordPose();
      const url = typeof input === "string" ? input : input?.url || "";
      if (!/\.rad(\?|#|$)/i.test(url)) return downstreamFetch(input, init);
      const range = extractRange(input, init);
      const mergedInit = { ...(init || {}), _proactiveRange: range || undefined };
      const cid = window.__proactiveChunkProbe?.noteDemand(url, mergedInit, "spark") ?? "";
      const rk = range || rangeOnly(cid);
      // Demand-frontier: notify READY controller so it can prefetch ahead
      if (readyController?.onDemandObserved && rk) {
        readyController.onDemandObserved(rk);
      }
      // P0-2: cache lookup phase
      window.__proactiveChunkProbe?.noteCacheLookup?.(cid, rk);
      window.__proactiveChunkProbe?.noteFetchStart?.(cid);
      // Raw byte cache only. Decoded-hit check REMOVED: SplatPager handles
      // __sparkPrefetchedDecoded internally before calling fetch(). If fetch()
      // is called, SplatPager already missed the decoded cache, so we must NOT
      // intercept with a decoded-hit response (causes retry loops).
      // DIAG: record first 10 cache read keys
      window.__cacheKeyDiag = window.__cacheKeyDiag || { writes: [], reads: [], cacheSize: 0, rawHitReturns: 0, decodedHitReturns: 0, decodedHitButRawMissFallsThrough: 0, missReturns: 0 };
      if (window.__cacheKeyDiag.reads.length < 10) {
        window.__cacheKeyDiag.reads.push({
          rk,
          cacheHas: cache.has(rk),
          cacheSize: cache.size,
          isSparkOd: !!flags.isSparkOd,
          rkTruthy: !!rk,
        });
      }
      if (!flags.isSparkOd && rk && cache.has(rk)) {
        const hit = cache.get(rk);
        window.__cacheKeyDiag.rawHitReturns += 1;
        window.__proactiveChunkProbe?.noteCacheHit?.(cid, "raw");
        window.__proactiveChunkProbe?.noteFetchComplete(cid, hit.buffer?.byteLength ?? 0);
        if (isReady) window.__proactiveChunkProbe?.noteParseComplete(cid);
        // Build Content-Range header from the range key (bytes=X-Y)
        const rangeMatch = rk.match(/bytes=(\d+)-(\d+)/);
        const headers = { "Content-Type": "application/octet-stream" };
        if (rangeMatch) {
          const start = rangeMatch[1];
          const end = rangeMatch[2];
          headers["Content-Range"] = `bytes ${start}-${end}/*`;
        }
        return new Response(hit.buffer.slice(0), {
          status: hit.status || 206,
          headers,
        });
      }
      // Cache miss → on-demand network fetch
      window.__cacheKeyDiag.missReturns += 1;
      window.__proactiveChunkProbe?.noteCacheMiss?.(cid);
      onDemandInFlight += 1;
      lastOnDemandT = performance.now();
      try {
        const res = await downstreamFetch(input, init);
        try {
          const bytes = (await res.clone().arrayBuffer()).byteLength;
          window.__proactiveChunkProbe?.noteResponseEnd?.(cid, bytes);
          window.__proactiveChunkProbe?.noteFetchComplete(cid, bytes);
        } catch { /* */ }
        return res;
      } finally {
        onDemandInFlight = Math.max(0, onDemandInFlight - 1);
        lastOnDemandT = performance.now();
        pumpQueue();
      }
    };
  }

  setInterval(recordPose, 100);

  // Periodic pump tick: re-evaluates admission gates so the cooldown gate
  // (#2: ON_DEMAND_HOT_MS) can release without waiting for the next
  // enqueuePrefetch / fetch finally callback. Without this the queue can
  // stall if the last demand burst ends while the queue is non-empty.
  setInterval(() => {
    if (queue.length > 0) pumpQueue();
  }, 100);
})();
