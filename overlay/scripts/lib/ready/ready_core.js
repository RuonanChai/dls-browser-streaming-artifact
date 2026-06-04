/**
 * READY — shared types, chunk classification, method feature flags.
 * READY is a remote-aware, deadline-driven readiness controller (not viewport-only prefetch).
 */
(function readyCoreBootstrap() {
  const declaredRole =
    new URLSearchParams(location.search).get("VRC_DELIVERY_ROLE")
    || (() => {
      const u = new URLSearchParams(location.search).get("VRC_RAD_URL") || "";
      if (/10\.120\.17\.176|192\.168\.|localhost|127\.0\.0\.1/.test(u)) return "edge";
      if (!u) return "local";
      return "remote";
    })();

  // Delivery-role-aware prediction horizons: remote needs longer lookahead
  const HORIZONS_MS = declaredRole === "remote"
    ? [1000, 2000, 4000]
    : declaredRole === "edge"
      ? [500, 1000, 2000]
      : [300, 600, 1200];

  // Remote safety margin accounts for higher RTT variance
  const SAFETY_MARGIN_MS = Number(
    new URLSearchParams(location.search).get("VRC_READY_SAFETY_MS")
    || (declaredRole === "remote" ? 200 : declaredRole === "edge" ? 80 : 40),
  );

  function methodFlags(code) {
    const c = String(code || "B0");

    // Canonical 8-baseline ablation hierarchy (per Todolist.md).
    // Each flag is set EXACTLY by membership; no implicit cascading.
    const isSparkOd  = c === "B0";
    const isNaive    = c === "B1";
    const isProgs    = c === "B2";
    const isSgss     = c === "SGSS";
    const isReadyB   = c === "READY-B";
    const isReadyP   = c === "READY-P" || c === "VRC-P" || c === "B3R";
    const isReadyC   = c === "READY-C";
    const isReadyR   = c === "READY-R";
    const isReadyFull = c === "READY" || c === "VRC";
    const isReadyS   = c === "READY-S";
    const isReadyDS  = c === "READY-DS";
    // Legacy / appendix-only ablations
    const isReadyE   = c === "READY-E" || c === "READY-D" || c === "VRC-D";
    const isReadyG   = c === "READY-G" || c === "READY-I" || c === "VRC-I";
    const isReadyV   = c === "READY-V" || c === "VRC-V";
    // Reference / oracle
    const isOracle       = c === "Oracle" || c === "B4R";
    const isDemandOracle = c === "DemandOracle" || c === "B4";
    const isOraclePD     = c === "OraclePD";
    // Composite: anything that runs the READY controller (any prediction-driven family member)
    const readyFamily = isReadyB || isReadyP || isReadyC || isReadyR || isReadyFull || isReadyS
      || isReadyE || isReadyG || isReadyDS;

    // ===== Mechanism flags (single source of truth) =====
    // These flags directly mirror Todolist.md's mechanism-combination table.

    // boot set: bot+predecode-only baseline (READY-B) and all full READY variants use boot set
    const useBootSet = isReadyB || isReadyP || isReadyC || isReadyR || isReadyFull || isReadyS;

    // motion prediction: READY-P/C/R/full/S use it; READY-B and READY-DS do NOT
    const useMotionPrediction = isReadyP || isReadyC || isReadyR || isReadyFull || isReadyS
      || isReadyE || isReadyG;

    // continuous re-scheduling (200ms tick): READY-C, READY, READY-S
    const useContinuousScheduling = isReadyC || isReadyFull || isReadyS;

    // pre-decode via Spark worker pool: READY-B, READY-R, READY, READY-S, READY-DS
    const usePredecode = isReadyB || isReadyR || isReadyFull || isReadyS || isReadyDS;

    // session prior (read __proactiveReferenceDemand): ONLY READY-S
    // Critical: must be false for READY to avoid trace-leakage claim
    const useSessionPrediction = isReadyS;

    // Demand-safe mode: READY-DS uses demand-frontier + idle-window + post-fetch pre-decode
    // NO viewport prediction, NO continuous tick, NO boot set prefetch
    const useDemandSafe = isReadyDS;

    // Token-bucket: every proactive baseline shares the same on-demand-priority gate
    const useTokenBucket = !isSparkOd;

    return {
      code: c,
      // baseline membership
      isSparkOd, isNaive, isProgs, isSgss,
      isReadyB, isReadyP, isReadyC, isReadyR, isReadyFull, isReadyS, isReadyDS,
      isReadyE, isReadyG, isReadyV,
      isOracle, isDemandOracle, isOraclePD,
      readyFamily,
      // mechanism flags (direct routing — DO NOT add implicit cascades)
      useBootSet,
      useMotionPrediction,
      useContinuousScheduling,
      usePredecode,
      useSessionPrediction,
      useDemandSafe,
      useTokenBucket,
      // controller dispatch
      useReadyController: readyFamily,
      // legacy / scoring weights (kept for runVrcFull score components)
      useSceneHotness:  isReadyE || isReadyG || isReadyFull || isReadyS,
      useReadinessRisk: isReadyE || isReadyG || isReadyFull || isReadyS,
      useEdgeDelivery:  isReadyE || isReadyG || isReadyFull || isReadyS,
      useDeadlineParse: isReadyG || isReadyFull || isReadyS,
      useDeadlineGpu:   isReadyG || isReadyFull || isReadyS,
      useReferenceDemand: useSessionPrediction,
      useBudget: !isReadyB && !isReadyP,
      useWasteAware: isReadyFull || isReadyS,
      // legacy aliases
      isVrcP: isReadyP, isVrc: isReadyFull, isVrcD: isReadyE,
      isVrcI: isReadyG, isVrcB: isReadyB, isVrcV: isReadyV,
      readyAware: !isSparkOd,
      usePrediction: useMotionPrediction,
      useViewOnly: isSgss || isReadyV,
      useFirstVisible: isReadyFull || isReadyS || isProgs,
      useDeadline: isReadyFull || isReadyS,
    };
  }

  function byteStart(ent) {
    return Number(String(ent?.range || "").match(/bytes=(\d+)/)?.[1] || 0);
  }

  function chunkBytes(ent) {
    const m = String(ent?.range || "").match(/bytes=(\d+)-(\d+)/);
    if (ent?.encoded_bytes) return ent.encoded_bytes;
    if (m) return Number(m[2]) - Number(m[1]) + 1;
    return 65536;
  }

  /** Scene / LOD role for prewarm and downgrade */
  function classifyChunk(ent, idx) {
    const start = byteStart(ent);
    const bytes = chunkBytes(ent);
    const isFirstScreen = start < 262144;
    const isBaseLod = start < 1048576 || bytes <= 49152;
    const isHot = isFirstScreen || (idx >= 0 && idx < 12);
    const centrality = 1 / (1 + start / 524288);
    return { isFirstScreen, isBaseLod, isHot, centrality, start, bytes };
  }

  function sessionT0() {
    return window.__proactiveChunkProbe?.state?.session_t0 ?? performance.now();
  }

  function nowMs() {
    return performance.now() - sessionT0();
  }

  window.__readyCore = {
    HORIZONS_MS,
    SAFETY_MARGIN_MS,
    methodFlags,
    classifyChunk,
    byteStart,
    chunkBytes,
    sessionT0,
    nowMs,
  };
})();
