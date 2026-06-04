/**
 * Deadline-aware parse and GPU upload queues (READY-G / READY).
 */
(function readySchedulersBootstrap() {
  function DeadlineQueue(name) {
    const items = [];
    let running = false;

    function enqueue(entry) {
      items.push(entry);
      items.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      pump();
    }

    async function pump() {
      if (running) return;
      running = true;
      while (items.length > 0) {
        const job = items.shift();
        const waitStart = performance.now();
        try {
          await job.run({
            parse_queue_length: items.length,
            wait_ms: performance.now() - waitStart,
          });
        } catch (e) {
          console.warn(`[READY ${name}]`, e);
        }
      }
      running = false;
    }

    return {
      enqueue,
      get length() {
        return items.length;
      },
    };
  }

  function parsePriority(ent, prediction, flags) {
    const core = window.__readyCore;
    const ready = window.__readyReadiness;
    const cls = core.classifyChunk(ent, 0);
    const now = core.nowMs();
    let p = ready.schedulingPriority(ent, prediction, flags, { nowMs: now });
    // Base-first: base LOD and first-screen get highest parse priority
    if (cls.isBaseLod) p += 150;
    if (cls.isFirstScreen) p += 100;
    const slack =
      (prediction?.predicted_visible_time_ms ?? now + 5000)
      - now
      - ready.estimateParseCostMs(ent);
    if (slack < 0) p += 80; // urgent: already late
    else if (slack < 200) p += 40; // tight deadline
    return p;
  }

  function gpuPriority(ent, prediction, flags) {
    const ready = window.__readyReadiness;
    const core = window.__readyCore;
    const cls = core.classifyChunk(ent, 0);
    let p = ready.schedulingPriority(ent, prediction, flags, { nowMs: core.nowMs() });
    // Base-first GPU upload: base LOD renders fastest, gives visible content
    if (cls.isBaseLod) p += 120;
    if (cls.isFirstScreen) p += 60;
    const start = core.byteStart(ent);
    const screenUtility = 1 / (1 + start / 131072);
    p += screenUtility * 20;
    return p;
  }

  function createSchedulers(flags, hooks) {
    const parseQ = DeadlineQueue("parse");
    const gpuQ = DeadlineQueue("gpu");
    const metrics = {
      parse_wait_ms: [],
      parse_cost_ms: [],
      gpu_wait_ms: [],
      late_after_parse: 0,
      skipped_enhanced: 0,
    };

    function scheduleParse(ent, prediction, cid) {
      // Remote startup-safe: disable deadline queue on remote (READY-G regression fix)
      const remoteRole = window.__readyDelivery?.declaredRole === "remote";
      if (!flags.useDeadlineParse || remoteRole) {
        hooks.parseImmediate(cid);
        return;
      }
      const pri = parsePriority(ent, prediction, flags);
      const slack =
        (prediction?.predicted_visible_time_ms ?? 0) - window.__readyCore.nowMs();
      const cls = window.__readyCore.classifyChunk(ent, 0);
      if (!cls.isBaseLod && !cls.isFirstScreen && slack < 0) {
        metrics.skipped_enhanced += 1;
        return;
      }
      const tEnqueue = performance.now();
      window.__proactiveChunkProbe?.noteParseStart?.(cid);
      parseQ.enqueue({
        priority: pri,
        run: async (ctx) => {
          const tStart = performance.now();
          metrics.parse_wait_ms.push(tStart - tEnqueue);
          await hooks.runParseWork(cid);
          const tEnd = performance.now();
          metrics.parse_cost_ms.push(tEnd - tStart);
          window.__proactiveChunkProbe?.noteParseComplete(cid);
          if (flags.useDeadlineGpu) {
            scheduleGpu(ent, prediction, cid);
          }
        },
      });
    }

    function scheduleGpu(ent, prediction, cid) {
      if (!flags.useDeadlineGpu) return;
      const tEnqueue = performance.now();
      gpuQ.enqueue({
        priority: gpuPriority(ent, prediction, flags),
        run: async () => {
          const tStart = performance.now();
          metrics.gpu_wait_ms.push(tStart - tEnqueue);
          await hooks.runGpuWork(cid, ent);
          const need = prediction?.predicted_visible_time_ms;
          const now = window.__readyCore.nowMs();
          if (need != null && now > need + 100) metrics.late_after_parse += 1;
        },
      });
    }

    return {
      parseQ,
      gpuQ,
      scheduleParse,
      scheduleGpu,
      metrics,
    };
  }

  window.__readySchedulers = { createSchedulers, DeadlineQueue };
})();
