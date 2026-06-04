/**
 * READY controller — coordinates boot set, motion prediction, continuous
 * scheduling, demand-frontier tracking, and parse/GPU queue dispatch.
 *
 * Mechanism dispatch is driven by flags from ready_core.methodFlags():
 *   useBootSet              — issue static bootstrap prefetch at start
 *   useMotionPrediction     — score chunks by predicted future viewport
 *   useContinuousScheduling — re-evaluate priorities every tick
 *   usePredecode            — controlled by prefetch controller (see fetch hook)
 *   useSessionPrediction    — read __proactiveReferenceDemand (READY-S only)
 *
 * Demand-frontier tracking (remote delivery):
 *   Observes Spark's demand stream and prefetches the next N chunks in manifest
 *   order ahead of the highest-demanded index. This aligns with Spark's
 *   LOD-sequential demand pattern on high-RTT links where viewport prediction
 *   has low accuracy.
 *
 * Tick counter is exposed at window.__readyContinuousTickCount for the
 * sanity-check pipeline.
 */
(function readyControllerBootstrap() {
  function createReadyController(ctx) {
    const {
      flags,
      manifest,
      radUrl,
      cache,
      budget,
      bytesUsedRef,
      parseBudgetPerSec,
      enqueuePrefetch,
      fetchCompleteHook,
      fullCid,
    } = ctx;

    const core = window.__readyCore;
    const predict = window.__readyPrediction;
    const ready = window.__readyReadiness;
    const delivery = window.__readyDelivery;

    const poseHistory = [];
    let predictions = new Map();
    let parseTokens = parseBudgetPerSec;
    let schedulers = null;
    let tickCount = 0;
    window.__readyContinuousTickCount = 0;
    window.__readySessionPriorUsed = !!flags.useSessionPrediction;

    setInterval(() => {
      parseTokens = Math.min(parseBudgetPerSec, parseTokens + parseBudgetPerSec);
    }, 1000);

    function recordPose() {
      const cam = window.__slDiagCamera;
      if (!cam) return;
      window.__proactiveLastCamera = cam;
      const t = performance.now();
      poseHistory.push({ t, x: cam.position.x, y: cam.position.y, z: cam.position.z });
      if (poseHistory.length > 120) poseHistory.shift();
    }

    // =========================================================================
    // Demand-frontier tracker
    // =========================================================================
    // Spark demands chunks roughly in byte-offset order (base LOD first, then
    // higher LODs). On remote (high RTT), viewport prediction has low accuracy
    // because the prediction horizon (2s) is shorter than the fetch latency
    // (1.3s). Instead, we observe the demand frontier and prefetch AHEAD of it.
    //
    // FRONTIER_LOOKAHEAD: how many chunks ahead of the frontier to prefetch.
    // Higher = more speculative; lower = more conservative. 8 is ~10s of
    // demand at typical orbit speed on coit-40m.
    const FRONTIER_LOOKAHEAD = 8;
    let demandFrontierIdx = -1; // highest manifest index demanded so far
    let frontierPrefetchCount = 0;

    // Build a range→index lookup for O(1) frontier updates
    const rangeToIdx = new Map();
    manifest.forEach((ent, idx) => rangeToIdx.set(ent.range, idx));

    /**
     * Called when Spark demands a chunk (via fetch interceptor noteDemand).
     * Updates the frontier and issues prefetches for the next N chunks.
     * Only active for variants with useMotionPrediction (READY-P/C/R/READY/READY-S)
     * OR useDemandSafe (READY-DS).
     * READY-B (boot-only) should NOT use frontier tracking.
     */
    function onDemandObserved(range) {
      if (!flags.useMotionPrediction && !flags.useDemandSafe) return;
      const idx = rangeToIdx.get(range);
      if (idx == null || idx <= demandFrontierIdx) return;
      demandFrontierIdx = idx;
      // Prefetch the next FRONTIER_LOOKAHEAD chunks beyond the frontier
      const start = demandFrontierIdx + 1;
      const end = Math.min(manifest.length, start + FRONTIER_LOOKAHEAD);
      for (let i = start; i < end; i++) {
        const ent = manifest[i];
        if (cache.has(ent.range)) continue;
        if (flags.useBudget && bytesUsedRef.value >= budget) break;
        // Priority: closer to frontier = higher priority (1000 base - distance)
        const pri = 1000 - (i - demandFrontierIdx);
        enqueuePrefetch(ent.url || radUrl, ent.range, pri);
        frontierPrefetchCount += 1;
      }
    }

    // Expose frontier state for diagnostics
    window.__readyDemandFrontier = {
      get idx() { return demandFrontierIdx; },
      get prefetchCount() { return frontierPrefetchCount; },
      get lookahead() { return FRONTIER_LOOKAHEAD; },
    };

    // =========================================================================

    schedulers = window.__readySchedulers.createSchedulers(flags, {
      parseImmediate(cid) {
        if (flags.useBudget) parseTokens = Math.max(0, parseTokens - 1);
        window.__proactiveChunkProbe?.noteParseComplete(cid);
      },
      async runParseWork(cid) {
        if (flags.useBudget && parseTokens < 1) {
          await new Promise((r) => setTimeout(r, 40));
        }
        if (flags.useBudget) parseTokens = Math.max(0, parseTokens - 1);
        const rk = String(cid).match(/bytes=\d+-\d+/)?.[0];
        const hit = rk ? cache.get(rk) : null;
        if (hit?.buffer) {
          try {
            const dv = new Uint8Array(hit.buffer);
            let sum = 0;
            const step = Math.max(1, Math.floor(dv.length / 4096));
            for (let i = 0; i < dv.length; i += step) sum = (sum + dv[i]) | 0;
            hit.__parseSum = sum;
          } catch (_) { /* */ }
        }
      },
      async runGpuWork(cid) {
        window.__proactiveChunkProbe?.noteUploadComplete?.(cid);
      },
    });

    function onFetchComplete(ent, cid, ms, fromCache) {
      delivery.recordFetch(ent.range, ms, fromCache);
      const pred = predictions.get(ent.range);
      schedulers.scheduleParse(ent, pred, cid);
      fetchCompleteHook?.(ent, cid);
    }

    /**
     * Boot set: enqueue prewarm chunks once at scene start.
     * For READY-B (useBootSet=true, useMotionPrediction=false) this is the
     * ONLY scheduling step. For other variants, boot set fills the pipeline
     * before motion prediction kicks in.
     */
    function runSceneStart() {
      if (!flags.useBootSet) return;
      const prewarm = delivery.scenePrewarmRanges(manifest, flags);
      const t0 = performance.now();
      for (const ent of prewarm) {
        const pred = predictions.get(ent.range) || {
          demand_probability: 0.7,
          predicted_visible_time_ms: core.nowMs() + 800,
        };
        const pri = ready.schedulingPriority(ent, pred, flags, { nowMs: core.nowMs() });
        window.__readyDelivery?.markWarmed?.(ent.range, {
          warmed_first_screen: window.__readyCore.classifyChunk(ent, 0).isFirstScreen,
          warmed_base: window.__readyCore.classifyChunk(ent, 0).isBaseLod,
          warmed_hot: window.__readyCore.classifyChunk(ent, 0).isHot,
        });
        enqueuePrefetch(ent.url || radUrl, ent.range, pri + 200);
      }
      window.__readyScenePrewarmMs = performance.now() - t0;
    }

    /**
     * Continuous scheduling tick: re-rank candidate chunks by predicted demand
     * and enqueue the top-k that are not yet cached.
     *
     * Only invoked if useMotionPrediction is true. For READY-B (boot-only)
     * this never fires.
     */
    function runSchedulingTick() {
      if (!flags.useMotionPrediction) return;
      tickCount += 1;
      window.__readyContinuousTickCount = tickCount;
      recordPose();
      predictions = predict.mergePredictions(manifest, poseHistory, flags);
      const now = core.nowMs();
      const scored = [];

      manifest.forEach((ent, idx) => {
        const pred = predictions.get(ent.range);
        if (!pred) return;
        if (!ready.shouldPrepare(ent, pred, flags, {
          nowMs: now,
          idx,
          parseQueueLen: schedulers.parseQ.length,
          gpuQueueLen: schedulers.gpuQ.length,
        })) return;
        if (!delivery.isDeadlineFeasible(ent, pred, flags)) return;
        const pri = ready.schedulingPriority(ent, pred, flags, { nowMs: now, idx });
        scored.push({ ent, score: pri, pred });
      });

      scored.sort((a, b) => b.score - a.score);
      // READY-P uses a smaller cap (prediction-only, no continuous adaptation)
      const cap = (flags.isReadyP || flags.isReadyR)
        ? Math.max(8, Math.ceil(manifest.length / 12))
        : 48;
      for (let i = 0; i < Math.min(cap, scored.length); i++) {
        if (flags.useBudget && bytesUsedRef.value >= budget) break;
        const { ent, score } = scored[i];
        if (cache.has(ent.range)) continue;
        enqueuePrefetch(ent.url || radUrl, ent.range, score);
      }
    }

    return {
      start() {
        predictions = predict.mergePredictions(manifest, poseHistory, flags);
        // Boot set always runs once if useBootSet is true.
        runSceneStart();
        // Single initial scheduling pass for any variant with motion prediction.
        runSchedulingTick();
        // Continuous scheduling only for READY-C, READY, READY-S.
        if (flags.useContinuousScheduling) {
          const tickMs = (delivery.declaredRole === "remote") ? 200 : 400;
          setInterval(() => runSchedulingTick(), tickMs);
        }
        // Pose recording is needed for any prediction-driven variant.
        if (flags.useMotionPrediction) {
          setInterval(recordPose, 100);
        }
      },
      onFetchComplete,
      onDemandObserved,
      getStats() {
        return {
          controller: "READY",
          flags,
          predictions_size: predictions.size,
          delivery: delivery.deliveryStats(),
          schedulers: schedulers.metrics,
          scene_prewarm_ms: window.__readyScenePrewarmMs,
          continuous_tick_count: tickCount,
          session_prior_used: !!flags.useSessionPrediction,
          demand_frontier_idx: demandFrontierIdx,
          frontier_prefetch_count: frontierPrefetchCount,
        };
      },
    };
  }

  window.__readyCreateController = createReadyController;
})();
