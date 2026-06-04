/**
 * READY prediction: scene hotness (A), short-horizon motion (B), session/trace (C).
 */
(function readyPredictionBootstrap() {
  const core = () => window.__readyCore;
  const visited = new Map();
  let sceneScores = null;

  function recordVisit(range, dwellMs) {
    const v = visited.get(range) || { count: 0, dwell_ms: 0 };
    v.count += 1;
    v.dwell_ms += dwellMs || 0;
    visited.set(range, v);
  }

  /** A. Scene-level hotness at manifest load */
  function sceneHotness(manifest, flags) {
    if (!flags.useSceneHotness) return new Map();
    const out = new Map();
    manifest.forEach((ent, idx) => {
      const cls = core().classifyChunk(ent, idx);
      let s = cls.centrality * 2;
      if (cls.isFirstScreen) s += 5;
      if (cls.isBaseLod) s += 2.5;
      if (cls.isHot) s += 1.5;
      const hist = window.__proactiveSceneHotChunks;
      if (hist && hist.has(ent.range)) s += 3;
      out.set(ent.range, { score: s, confidence: 0.85, source: "scene" });
    });
    sceneScores = out;
    return out;
  }

  function cameraState(poseHistory) {
    const cam = window.__slDiagCamera || window.__proactiveLastCamera;
    if (!cam || poseHistory.length < 2) {
      const p = poseHistory[poseHistory.length - 1] || { x: 0, y: 0, z: 0 };
      return { position: p, linearVel: { x: 0, y: 0, z: 0 }, angularVel: 0 };
    }
    const a = poseHistory[poseHistory.length - 2];
    const b = poseHistory[poseHistory.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return {
      position: b,
      linearVel: {
        x: (b.x - a.x) / dt,
        y: (b.y - a.y) / dt,
        z: (b.z - a.z) / dt,
      },
      angularVel: Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / dt,
    };
  }

  function predictPose(poseHistory, horizonMs) {
    const st = cameraState(poseHistory);
    return {
      x: st.position.x + st.linearVel.x * horizonMs,
      y: st.position.y + st.linearVel.y * horizonMs,
      z: st.position.z + st.linearVel.z * horizonMs,
    };
  }

  function viewProb(ent, pose, horizonMs) {
    const start = core().byteStart(ent);
    const dist = Math.abs(pose.x) * 0.12 + Math.abs(pose.y) * 0.12 + Math.abs(pose.z) * 0.02;
    const viewport = 1 / (1 + start / 65536);
    const horizonDecay = 1 / (1 + horizonMs / 2000);
    const p = Math.min(0.98, viewport * horizonDecay * (1.1 - dist * 0.02));
    return p;
  }

  /** B. Short-horizon motion — P(c,t) at 500/1000/2000ms */
  function motionPrediction(manifest, poseHistory, flags) {
    if (!flags.useMotionPrediction) return new Map();
    const horizons = core().HORIZONS_MS;
    const merged = new Map();
    const tNow = core().nowMs();

    for (const h of horizons) {
      const pose = predictPose(poseHistory, h);
      for (const ent of manifest) {
        const p = viewProb(ent, pose, h);
        const predicted_visible_time_ms = tNow + h * (0.65 + p * 0.35);
        const confidence = Math.min(0.95, 0.35 + p * 0.6);
        const prev = merged.get(ent.range);
        if (!prev || p > prev.demand_probability) {
          merged.set(ent.range, {
            demand_probability: p,
            predicted_visible_time_ms,
            prediction_confidence: confidence,
            horizon_ms: h,
            source: "motion",
          });
        }
      }
    }
    return merged;
  }

  /** C. Session / path prior */
  function sessionPrediction(manifest, flags) {
    if (!flags.useSessionPrediction) return new Map();
    const out = new Map();
    const refDemand = window.__proactiveReferenceDemand || [];
    const pathPrior = new Map();
    for (const d of refDemand) {
      const rk =
        String(d.range_header || d.chunk_id || "").match(/bytes=\d+-\d+/)?.[0] || "";
      if (rk) pathPrior.set(rk, (pathPrior.get(rk) || 0) + 1);
    }
    for (const ent of manifest) {
      const vis = visited.get(ent.range);
      let p = 0.05;
      if (vis) p += Math.min(0.4, vis.count * 0.08 + vis.dwell_ms / 60000);
      if (pathPrior.has(ent.range)) p += Math.min(0.35, pathPrior.get(ent.range) * 0.05);
      out.set(ent.range, {
        demand_probability: Math.min(0.9, p),
        prediction_confidence: vis ? 0.7 : 0.45,
        source: "session",
      });
    }
    return out;
  }

  function mergePredictions(manifest, poseHistory, flags) {
    const scene = sceneHotness(manifest, flags);
    const motion = motionPrediction(manifest, poseHistory, flags);
    const session = sessionPrediction(manifest, flags);
    const tNow = core().nowMs();
    const merged = new Map();

    for (const ent of manifest) {
      const m = motion.get(ent.range);
      const s = session.get(ent.range);
      const sc = scene.get(ent.range);
      let demand_probability = 0.05;
      let prediction_confidence = 0.3;
      let predicted_visible_time_ms = tNow + 4000;

      if (m) {
        demand_probability = Math.max(demand_probability, m.demand_probability);
        prediction_confidence = Math.max(prediction_confidence, m.prediction_confidence);
        predicted_visible_time_ms = m.predicted_visible_time_ms;
      }
      if (s && flags.useSessionPrediction) {
        demand_probability = Math.min(0.98, demand_probability * 0.65 + s.demand_probability * 0.35);
        prediction_confidence = Math.max(prediction_confidence, s.prediction_confidence);
      }
      if (sc && flags.useSceneHotness) {
        const boost = Math.min(0.5, sc.score / 12);
        demand_probability = Math.min(0.98, demand_probability + boost * (1 - demand_probability));
        if (sc.score > 4) predicted_visible_time_ms = Math.min(predicted_visible_time_ms, tNow + 1500);
      }

      if (prediction_confidence < 0.4 && sc) {
        demand_probability = Math.max(demand_probability, Math.min(0.55, sc.score / 10));
        predicted_visible_time_ms = tNow + 2500;
      }

      merged.set(ent.range, {
        ent,
        demand_probability,
        predicted_visible_time_ms,
        prediction_confidence,
      });
    }
    return merged;
  }

  window.__readyPrediction = {
    sceneHotness,
    motionPrediction,
    sessionPrediction,
    mergePredictions,
    recordVisit,
    predictPose,
  };
})();
