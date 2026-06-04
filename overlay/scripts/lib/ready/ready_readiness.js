/**
 * READY readiness risk: estimated end-to-end cost vs time until predicted demand.
 */
(function readyReadinessBootstrap() {
  const core = () => window.__readyCore;
  const delivery = () => window.__readyDelivery;

  const DEFAULT_NET_MS = { local: 8, edge: 45, remote: 650 };
  const PARSE_MS_PER_BYTE = 1 / 1200;
  const GPU_MS_PER_BYTE = 1 / 2400;

  function estimateNetworkMs(ent, tier) {
    const bytes = core().chunkBytes(ent);
    const base = DEFAULT_NET_MS[tier] ?? DEFAULT_NET_MS.remote;
    return base + Math.min(400, bytes * 0.002);
  }

  function estimateParseCostMs(ent) {
    const bytes = core().chunkBytes(ent);
    return 12 + bytes * PARSE_MS_PER_BYTE;
  }

  function estimateParseWaitMs(parseQueueLen) {
    return (parseQueueLen || 0) * 18;
  }

  function estimateGpuUploadMs(ent) {
    const bytes = core().chunkBytes(ent);
    return 6 + bytes * GPU_MS_PER_BYTE;
  }

  function estimateGpuWaitMs(gpuQueueLen) {
    return (gpuQueueLen || 0) * 8;
  }

  function estimatedCost(ent, ctx) {
    const tier = delivery()?.getTier(ent.range) || "remote";
    return (
      estimateNetworkMs(ent, tier)
      + estimateParseWaitMs(ctx?.parseQueueLen)
      + estimateParseCostMs(ent)
      + estimateGpuWaitMs(ctx?.gpuQueueLen)
      + estimateGpuUploadMs(ent)
    );
  }

  function timeUntilDemand(prediction, nowMs) {
    if (!prediction) return 0;
    return (prediction.predicted_visible_time_ms ?? nowMs) - nowMs;
  }

  function readinessRisk(ent, prediction, ctx) {
    const now = ctx?.nowMs ?? core().nowMs();
    const cost = estimatedCost(ent, ctx);
    const until = timeUntilDemand(prediction, now);
    return cost + core().SAFETY_MARGIN_MS - until;
  }

  function shouldPrepare(ent, prediction, flags, ctx) {
    if (!flags.useReadinessRisk) {
      return (prediction?.demand_probability ?? 0) > 0.25;
    }
    const p = prediction?.demand_probability ?? 0;
    const risk = readinessRisk(ent, prediction, ctx);
    const cls = core().classifyChunk(ent, ctx?.idx ?? 0);
    const tier = delivery()?.declaredRole || "edge";

    // Base-first: always admit first-screen and base LOD with low threshold
    if (cls.isFirstScreen || cls.isBaseLod) return p > 0.08 || risk > -200;

    // Utility/cost admission control for remote delivery:
    // Only prefetch if expected utility (p × visibility_weight) justifies the cost
    if (tier === "remote" && flags.useWasteAware) {
      const cost = estimatedCost(ent, ctx);
      const utility = p * 100 + (cls.isHot ? 20 : 0);
      const costRatio = utility / Math.max(1, cost * 0.01);
      // Reject if utility/cost ratio is too low (waste-aware)
      if (costRatio < 0.3 && risk < 100) return false;
    }

    // Remote: lower probability threshold since we need more pipeline fill
    if (tier === "remote") return p > 0.20 && risk > -100;
    return p > 0.35 && risk > 0;
  }

  function schedulingPriority(ent, prediction, flags, ctx) {
    const cls = core().classifyChunk(ent, ctx?.idx ?? 0);
    const tier = delivery()?.declaredRole || "edge";
    let pri = (prediction?.demand_probability ?? 0) * 100;

    // Base-first priority boost (renders fastest, gives visible content early)
    if (cls.isFirstScreen) pri += 80;
    if (cls.isBaseLod) pri += 60;

    if (flags.useReadinessRisk) {
      pri += Math.max(0, readinessRisk(ent, prediction, ctx)) * 0.05;
    }
    if (flags.useReferenceDemand) {
      pri += referenceDemandUrgency(ent, ctx?.nowMs) * 10;
    }

    // Delivery-role-aware priority adjustments
    if (tier === "remote") {
      // Remote: strongly boost base/first-screen for fast time-to-visible
      if (cls.isBaseLod) pri += 40;
      // Penalize high-cost low-probability chunks on remote
      const cost = estimatedCost(ent, ctx);
      const p = prediction?.demand_probability ?? 0;
      if (p < 0.4 && cost > 300) pri -= 20;
    } else {
      const observedTier = delivery()?.getTier(ent.range);
      if (flags.useEdgeDelivery && observedTier === "edge") pri += 25;
      if (flags.useEdgeDelivery && observedTier === "remote" && readinessRisk(ent, prediction, ctx) > 500) {
        pri -= 30;
      }
    }
    return pri;
  }

  function referenceDemandUrgency(ent, nowMs) {
    const ref = window.__proactiveReferenceDemand || [];
    if (!ref.length) return 0;
    const rk = ent.range;
    const entry = ref.find((d) => (d.range_header || d.chunk_id || "").includes(rk));
    const need = entry?.chunk_needed_time ?? entry?.needed_time;
    if (need == null) return 0;
    const slack = need - nowMs;
    if (slack <= 0) return 5;
    if (slack < 200) return 3;
    if (slack < 500) return 1.5;
    return 0;
  }

  window.__readyReadiness = {
    estimatedCost,
    readinessRisk,
    shouldPrepare,
    schedulingPriority,
    timeUntilDemand,
    estimateNetworkMs,
    estimateParseCostMs,
  };
})();
