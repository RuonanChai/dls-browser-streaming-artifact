/**
 * READY edge-aware delivery (LAN edge server, same subnet as laptop).
 * READY-E = edge-aware delivery scheduling — NOT raw remote CDN.
 *
 * Tier labels are observational (timing_heuristic), not separate network paths.
 * - local: in-memory / browser cache hit
 * - edge: LAN edge server (low RTT, e.g. 10.120.17.176)
 * - remote: high-latency path (heuristic only; true remote uses delivery_role=remote phase)
 */
(function readyDeliveryBootstrap() {
  const tiers = new Map();
  const warmedRanges = new Set();
  let edgeHits = 0;
  let remoteHits = 0;
  let localHits = 0;

  const declaredRole =
    new URLSearchParams(location.search).get("VRC_DELIVERY_ROLE")
    || (() => {
      const u = new URLSearchParams(location.search).get("VRC_RAD_URL") || "";
      if (/10\.120\.17\.176|192\.168\.|localhost|127\.0\.0\.1/.test(u)) return "edge";
      if (!u) return "local";
      return "remote";
    })();

  function classifyResponseMs(ms, fromCache) {
    if (fromCache) return { tier: "local", cache_status: "hit", source: "browser_cache" };
    if (ms < 35) return { tier: "edge", cache_status: "hit", source: "timing_heuristic" };
    if (ms < 120) return { tier: "edge", cache_status: "miss", source: "timing_heuristic" };
    return { tier: "remote", cache_status: "miss", source: "timing_heuristic" };
  }

  function recordFetch(range, ms, fromCache, meta = {}) {
    const c = classifyResponseMs(ms, fromCache);
    tiers.set(range, c.tier);
    if (c.tier === "local") localHits += 1;
    else if (c.tier === "edge") edgeHits += 1;
    else remoteHits += 1;

    const rec = {
      event: "delivery_tier",
      chunk_id: range,
      tier: c.tier,
      ms,
      delivery_source_declared: declaredRole,
      delivery_role: declaredRole,
      cache_status_observed: c.cache_status,
      cache_status_source: meta.cache_status_source || c.source,
      warmed_by_ready: meta.warmed_by_ready ?? warmedRanges.has(range),
      warmed_first_screen: meta.warmed_first_screen ?? false,
      warmed_base: meta.warmed_base ?? false,
      warmed_hot: meta.warmed_hot ?? false,
      edge_fetch_required: declaredRole === "edge" && c.tier !== "local",
      remote_fetch_required: declaredRole === "remote" || c.tier === "remote",
    };
    window.__proactiveChunkProbe?.state?.prefetch?.push(rec);
    return rec;
  }

  function markWarmed(range, meta = {}) {
    warmedRanges.add(range);
    recordFetch(range, 0, true, {
      ...meta,
      warmed_by_ready: true,
      cache_status_source: "warmup_manifest",
    });
  }

  function getTier(range) {
    return tiers.get(range) || (declaredRole === "edge" ? "edge" : "remote");
  }

  function scenePrewarmRanges(manifest, flags) {
    // Remote cold-start: always prewarm first-screen/base chunks for fast startup
    if (!flags.useEdgeDelivery && !flags.useSceneHotness && declaredRole !== "remote") return [];
    const firstScreen = [];
    const baseLod = [];
    const smallHighDensity = [];
    const guardBand = [];
    manifest.forEach((ent, idx) => {
      const cls = window.__readyCore.classifyChunk(ent, idx);
      const bytes = window.__readyCore.chunkBytes(ent);
      if (cls.isFirstScreen) firstScreen.push(ent);
      else if (cls.isBaseLod) baseLod.push(ent);
      else if (bytes > 0 && bytes < 49152) smallHighDensity.push(ent); // small = high splat density per byte
      else if (idx < 24) guardBand.push(ent); // early chunks = guard band for orbit trace
    });
    // Boot set optimized for q5/t1M: base LOD first (fastest visible splats),
    // then first-screen, then small high-density (best splats/byte), then guard-band.
    // Skip far-future/high-LOD enhanced chunks.
    const cap = declaredRole === "remote" ? 48 : declaredRole === "edge" ? 24 : 16;
    const ordered = [...baseLod, ...firstScreen, ...smallHighDensity, ...guardBand];
    return ordered.slice(0, cap);
  }

  function isDeadlineFeasible(ent, prediction, flags) {
    if (!flags.useEdgeDelivery) return true;
    const tier = getTier(ent.range);
    const risk = window.__readyReadiness.readinessRisk(ent, prediction, {
      nowMs: window.__readyCore.nowMs(),
    });
    if (declaredRole === "edge" && tier === "remote" && risk > 400) return false;
    // Remote: relax threshold — high RTT makes risk naturally large;
    // blocking at 600 starves the pipeline. Allow more through for startup.
    if (declaredRole === "remote" && risk > 2000) return false;
    return true;
  }

  function deliveryStats() {
    const total = edgeHits + remoteHits + localHits;
    const warmed = warmedRanges.size;
    return {
      delivery_source_declared: declaredRole,
      edge_hit_ratio: total ? (edgeHits + localHits) / total : 0,
      remote_fetch_ratio: total ? remoteHits / total : 0,
      edge_fetch_ratio: total ? edgeHits / total : 0,
      warmed_chunk_hit_ratio: total ? warmed / total : null,
      local_hits: localHits,
      edge_hits: edgeHits,
      remote_hits: remoteHits,
    };
  }

  window.__readyDelivery = {
    recordFetch,
    markWarmed,
    getTier,
    scenePrewarmRanges,
    isDeadlineFeasible,
    deliveryStats,
    tiers,
    declaredRole,
  };
})();
