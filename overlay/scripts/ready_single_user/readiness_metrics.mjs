/** Compute deadline miss ratios at multiple thresholds from chunk states. */
export function computeDeadlineMissRatios(chunkStates, demandedCount) {
  const demanded = demandedCount ?? chunkStates.filter((c) => c.needed_time != null).length;
  let miss50 = 0;
  let miss100 = 0;
  let miss250 = 0;
  let miss500 = 0;
  let miss1000 = 0;
  let useful = 0;

  for (const ch of chunkStates) {
    const needed = ch.needed_time ?? ch.chunk_needed_time;
    const ready = ch.ready_time ?? ch.chunk_ready_time;
    if (needed == null || ready == null) continue;
    const gap = ready - needed;
    if (gap <= 0) useful += 1;
    if (gap > 50) miss50 += 1;
    if (gap > 100) miss100 += 1;
    if (gap > 250) miss250 += 1;
    if (gap > 500) miss500 += 1;
    if (gap > 1000) miss1000 += 1;
  }

  const d = Math.max(1, demanded);
  return {
    demanded_chunks: demanded,
    useful_chunks_before_demand: useful,
    miss50: miss50 / d,
    miss100: miss100 / d,
    miss250: miss250 / d,
    miss500: miss500 / d,
    miss1000: miss1000 / d,
    deadline_miss_ratio_50ms: miss50 / d,
    deadline_miss_ratio_100ms: miss100 / d,
    deadline_miss_ratio_250ms: miss250 / d,
    deadline_miss_ratio_500ms: miss500 / d,
    deadline_miss_ratio_1000ms: miss1000 / d,
  };
}

export function timeToVisibleChunks(timeline, target = 50) {
  for (const e of timeline || []) {
    if ((e.visible_splat_count ?? 0) >= target) return e.t;
  }
  return null;
}

/** Time (ms) until visible_splat_count reaches 1M (paper: time_to_1M_visible). */
export function timeTo1MVisibleSplats(timeline) {
  for (const e of timeline || []) {
    if ((e.visible_splat_count ?? 0) >= 1_000_000) return e.t;
  }
  return null;
}
