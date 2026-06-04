/** Visible splat timeline helpers used by trial_cell / analyze. */
export function computeVisibleTimelineMetrics(timeline, moveMs = 40_000) {
  const tl = timeline || [];
  let blankMs = 0;
  let lastT = 0;
  let lastVis = 0;
  for (const e of tl) {
    const t = e.t ?? 0;
    if (lastVis <= 0 && t > lastT) blankMs += t - lastT;
    lastT = t;
    lastVis = Math.max(lastVis, e.visible_splat_count ?? 0);
  }
  const at = (sec) => {
    const target = sec * 1000;
    let best = 0;
    for (const e of tl) {
      if ((e.t ?? 0) <= target) best = Math.max(best, e.visible_splat_count ?? 0);
    }
    return best;
  };
  const vis1m = tl.find((e) => (e.visible_splat_count ?? 0) >= 1_000_000);
  return {
    blank_time_ms: blankMs,
    blank_ratio: moveMs > 0 ? blankMs / moveMs : null,
    visible_splat_count_1s: at(1),
    visible_splat_count_3s: at(3),
    visible_splat_count_5s: at(5),
    visible_splat_count_10s: at(10),
    quality_at_1s: at(1),
    quality_at_3s: at(3),
    quality_at_5s: at(5),
    quality_at_10s: at(10),
    time_to_1M_visible_splats_ms: vis1m?.t ?? null,
  };
}
