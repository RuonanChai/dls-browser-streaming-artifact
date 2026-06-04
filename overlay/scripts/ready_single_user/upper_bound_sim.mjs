#!/usr/bin/env node
/**
 * P0-5 Analytical Upper Bound simulator.
 *
 * Computes a paper-quality upper bound on quality_at_5s, time_to_1M,
 * and blank_ratio assuming:
 *   - Perfect demand prediction (oracle)
 *   - Perfect pre-decode (zero parse cost on critical path)
 *   - Network capacity = measured GCS p50 throughput
 *   - Concurrent fetches = measured maxParallel
 *   - All chunks visible at need_time + 0
 *
 * This is offline (does not run a browser). Outputs:
 *   paper_materials/ready_single_user_v1/upper_bound/upper_bound_metrics.json
 *
 * The actual READY can never beat this; it's a paper-claim ceiling.
 *
 * Usage:
 *   node scripts/ready_single_user/upper_bound_sim.mjs \
 *     --refTrial=<trial.json> \
 *     [--throughputMbps=43] [--maxParallel=4] [--rttMs=180]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(
  PROJECT_ROOT,
  "paper_materials/ready_single_user_v1/upper_bound",
);

function parseArgs(argv) {
  const o = {
    refTrial: null,
    throughputMbps: 43,
    maxParallel: 4,
    rttMs: 180,
    parseSkip: true, // pre-decode → 0 parse cost on critical path
    moveMs: 40000,
  };
  for (const a of argv) {
    if (a.startsWith("--refTrial=")) o.refTrial = a.slice(11);
    else if (a.startsWith("--throughputMbps=")) o.throughputMbps = Number(a.slice(17));
    else if (a.startsWith("--maxParallel=")) o.maxParallel = Number(a.slice(14));
    else if (a.startsWith("--rttMs=")) o.rttMs = Number(a.slice(8));
    else if (a.startsWith("--moveMs=")) o.moveMs = Number(a.slice(9));
    else if (a === "--noParseSkip") o.parseSkip = false;
  }
  return o;
}

/**
 * Build the demand timeline from a reference trial.
 * Returns a list of {chunk_id, need_time, bytes, splat_count} sorted by need_time.
 */
async function loadDemandFromTrial(refTrialPath) {
  const j = JSON.parse(await fs.readFile(refTrialPath, "utf8"));
  const snap = j.proactive_snapshot || {};
  const chunks = snap.chunk_states || [];
  const demand = [];
  for (const ch of chunks) {
    const need = ch.needed_time ?? ch.chunk_needed_time;
    if (need == null) continue;
    demand.push({
      chunk_id: ch.chunk_id,
      need_time: need,
      bytes: ch.bytes || 0,
      // Estimate splats per chunk: SH=1 => ~28 bytes/splat post-compression
      splat_count: ch.bytes ? Math.floor(ch.bytes / 28) : 0,
    });
  }
  demand.sort((a, b) => a.need_time - b.need_time);
  return demand;
}

/**
 * Simulate a perfect-prefetch + perfect-predecode pipeline.
 *
 * Each chunk takes: rtt_ms (one round-trip overhead) + bytes / throughput.
 * Up to maxParallel chunks can be in-flight concurrently.
 * Chunks become visible as soon as their fetch completes (predecode is free).
 *
 * Issue order = need_time order, started as early as possible.
 * Earliest start time for chunk i: max(0, slot_free_time[slot]).
 *
 * Returns a visible-splat timeline at 100ms resolution.
 */
function simulateUpperBound(demand, opts) {
  const { throughputMbps, maxParallel, rttMs, moveMs } = opts;
  const bytesPerMs = (throughputMbps * 1e6) / 8 / 1000; // bytes/ms

  // Each slot is a fetch worker; track when it next becomes free.
  const slotFree = new Array(maxParallel).fill(0);
  // For each chunk, compute (start, end_ready) where end_ready = bytes-on-wire complete.
  const events = [];
  for (let i = 0; i < demand.length; i += 1) {
    const ch = demand[i];
    // Pick the earliest-free slot
    const slot = slotFree.indexOf(Math.min(...slotFree));
    const startT = slotFree[slot]; // start as early as possible (perfect prediction)
    const fetchMs = rttMs + (ch.bytes / bytesPerMs);
    const readyT = startT + fetchMs;
    slotFree[slot] = readyT;
    events.push({ chunk_id: ch.chunk_id, start_t: startT, ready_t: readyT, bytes: ch.bytes, splats: ch.splat_count, need_t: ch.need_time });
  }

  // Visible-splat timeline: at each ms, count splats whose ready_t <= t.
  // Sample at 100ms.
  const sampleEveryMs = 100;
  events.sort((a, b) => a.ready_t - b.ready_t);
  const timeline = [];
  let cumSplats = 0;
  let evIdx = 0;
  for (let t = 0; t <= moveMs; t += sampleEveryMs) {
    while (evIdx < events.length && events[evIdx].ready_t <= t) {
      cumSplats += events[evIdx].splats;
      evIdx += 1;
    }
    timeline.push({ t, visible_splat_count: cumSplats });
  }

  // Derived metrics
  const splatsAt = (sec) => {
    const targetMs = sec * 1000;
    let last = 0;
    for (const e of timeline) {
      if (e.t <= targetMs) last = e.visible_splat_count;
    }
    return last;
  };
  const timeTo1M = (() => {
    for (const e of timeline) {
      if (e.visible_splat_count >= 1_000_000) return e.t;
    }
    return null;
  })();
  const firstVisible = (() => {
    for (const e of timeline) {
      if (e.visible_splat_count > 0) return e.t;
    }
    return null;
  })();
  // blank_ratio = fraction of measure window where visible_splat_count == 0
  const blankSamples = timeline.filter((e) => e.visible_splat_count === 0).length;
  const blankRatio = timeline.length ? blankSamples / timeline.length : 1;

  return {
    visible_splat_count_1s: splatsAt(1),
    visible_splat_count_3s: splatsAt(3),
    visible_splat_count_5s: splatsAt(5),
    visible_splat_count_10s: splatsAt(10),
    quality_at_1s: splatsAt(1),
    quality_at_3s: splatsAt(3),
    quality_at_5s: splatsAt(5),
    quality_at_10s: splatsAt(10),
    time_to_1M_visible_splats_ms: timeTo1M,
    first_visible_splat_ms: firstVisible,
    blank_ratio: blankRatio,
    visible_splat_max: timeline.length ? timeline[timeline.length - 1].visible_splat_count : 0,
    timeline_sample_count: timeline.length,
    total_chunks_simulated: demand.length,
    total_bytes: demand.reduce((s, c) => s + c.bytes, 0),
    fetch_window_end_ms: events.length ? events[events.length - 1].ready_t : 0,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.refTrial) {
    console.error(
      "Usage: node upper_bound_sim.mjs --refTrial=<trial.json> "
      + "[--throughputMbps=43] [--maxParallel=4] [--rttMs=180]",
    );
    process.exit(1);
  }

  const demand = await loadDemandFromTrial(opts.refTrial);
  if (!demand.length) {
    console.error(`No demanded chunks in ${opts.refTrial}`);
    process.exit(2);
  }

  const ub = simulateUpperBound(demand, opts);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "upper_bound_metrics.json");
  const result = {
    timestamp: new Date().toISOString(),
    inputs: {
      ref_trial: opts.refTrial,
      throughput_mbps: opts.throughputMbps,
      max_parallel: opts.maxParallel,
      rtt_ms: opts.rttMs,
      parse_skip: opts.parseSkip,
      move_ms: opts.moveMs,
    },
    upper_bound: ub,
    note:
      "Analytical ceiling: perfect prediction + perfect pre-decode + measured network. "
      + "READY cannot beat this in steady-state; gap = headroom for measurement noise + missed predictions.",
  };
  await fs.writeFile(outPath, JSON.stringify(result, null, 2), "utf8");

  console.log("=".repeat(70));
  console.log("P0-5 Analytical Upper Bound");
  console.log("=".repeat(70));
  console.log(`Inputs: throughput=${opts.throughputMbps}Mbps maxParallel=${opts.maxParallel} rtt=${opts.rttMs}ms`);
  console.log(`Reference trial: ${opts.refTrial}`);
  console.log(`Demanded chunks simulated: ${demand.length}`);
  console.log("");
  console.log(`first_visible_splat_ms : ${ub.first_visible_splat_ms ?? "never"}`);
  console.log(`time_to_1M_splats_ms   : ${ub.time_to_1M_visible_splats_ms ?? "never"}`);
  console.log(`quality_at_5s          : ${ub.quality_at_5s.toLocaleString()}`);
  console.log(`quality_at_10s         : ${ub.quality_at_10s.toLocaleString()}`);
  console.log(`blank_ratio            : ${(ub.blank_ratio * 100).toFixed(1)}%`);
  console.log(`fetch_window_end_ms    : ${Math.round(ub.fetch_window_end_ms)}`);
  console.log("");
  console.log(`Saved: ${path.relative(PROJECT_ROOT, outPath)}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(3);
});
