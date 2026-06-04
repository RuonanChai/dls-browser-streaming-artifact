#!/usr/bin/env node
/**
 * Dry-run test: verify pass_criteria_loader can evaluate fake stats correctly.
 * No real experiments are run.
 */
import { evaluatePhase } from "./pass_criteria_loader.mjs";

// Synthetic batch: P0-4 sanity_check should PASS
const passingStats = {
  "Spark-OD": {
    n: 3,
    q5s_median: 814000,
    t1m_median: 10000,
    blank_ratio_median: 0.081,
    first_visible_median: 2691,
    fps_median: 97.4,
    decoded_hit_pct_median: 0,
    raw_hit_pct_median: 0,
    continuous_tick_count_median: 0,
    session_prior_used: false,
  },
  "Naive-PF": {
    n: 3,
    q5s_median: 869000,
    fps_median: 91.4,
    decoded_hit_pct_median: 0,
    raw_hit_pct_median: 38,
    continuous_tick_count_median: 0,
    session_prior_used: false,
  },
  "READY-B": {
    n: 3, q5s_median: 920000, fps_median: 90,
    decoded_hit_pct_median: 35, raw_hit_pct_median: 10,
    continuous_tick_count_median: 0, session_prior_used: false,
  },
  "READY-P": {
    n: 3, q5s_median: 950000, fps_median: 90,
    decoded_hit_pct_median: 0, raw_hit_pct_median: 50,
    continuous_tick_count_median: 0, session_prior_used: false,
  },
  "READY-C": {
    n: 3, q5s_median: 960000, fps_median: 88,
    decoded_hit_pct_median: 0, raw_hit_pct_median: 45,
    continuous_tick_count_median: 180, session_prior_used: false,
  },
  "READY-R": {
    n: 3, q5s_median: 970000, fps_median: 88,
    decoded_hit_pct_median: 30, raw_hit_pct_median: 15,
    continuous_tick_count_median: 0, session_prior_used: false,
  },
  READY: {
    n: 3,
    q5s_median: 984000, t1m_median: 8001,
    blank_ratio_median: 0.059, first_visible_median: 1882,
    fps_median: 88.8, throughput_median: 58.0,
    decoded_hit_pct_median: 47, raw_hit_pct_median: 18,
    continuous_tick_count_median: 200, session_prior_used: false,
  },
  "READY-S": {
    n: 3, q5s_median: 985000, fps_median: 88,
    decoded_hit_pct_median: 47, continuous_tick_count_median: 200,
    session_prior_used: true,
  },
};

// P1-1 main_ablation: claim gate
async function testPhase(phase, stats, expectedPass) {
  const r = await evaluatePhase(phase, stats);
  const summary = {
    phase: r.phase,
    all_pass: r.all_pass,
    hard_failures: r.hard_failures.length,
    soft_failures: r.soft_failures.length,
    unevaluable: r.unevaluable.length,
    passed: r.passed.length,
  };
  console.log(`\n=== ${phase} ===`);
  console.log(JSON.stringify(summary, null, 2));
  if (r.hard_failures.length) {
    console.log("Hard failures:");
    for (const f of r.hard_failures) console.log(`  - ${f.check_id}: ${f.detail}`);
  }
  if (r.soft_failures.length) {
    console.log("Soft failures:");
    for (const f of r.soft_failures) console.log(`  - ${f.check_id} -> ${f.auto_fix}: ${f.detail}`);
  }
  if (r.unevaluable.length) {
    console.log("Unevaluable:");
    for (const u of r.unevaluable) console.log(`  - ${u.check_id}: ${u.detail}`);
  }
  const verdict = r.all_pass ? "PASS" : "FAIL";
  const expected = expectedPass ? "PASS" : "FAIL";
  const match = verdict === expected;
  console.log(`Result: ${verdict} (expected ${expected}) ${match ? "✓" : "✗"}`);
  return match;
}

console.log("=".repeat(70));
console.log("DRY-RUN: pass_criteria_loader self-test");
console.log("=".repeat(70));

const results = [];

// Case 1: passing stats should pass P0-4
results.push(await testPhase("P0-4_sanity_check", passingStats, true));

// Case 2: passing stats should pass P1-1 claim gate
results.push(await testPhase("P1-1_main_ablation", passingStats, true));

// Case 3: failing READY (q5s drops below 10% gain) should fail P1-1
const failingStats = {
  ...passingStats,
  READY: { ...passingStats.READY, q5s_median: 850000 }, // only 4% gain
};
results.push(await testPhase("P1-1_main_ablation", failingStats, false));

// Case 4: session_prior leak in READY should fail P0-4
const sessionLeakStats = {
  ...passingStats,
  READY: { ...passingStats.READY, session_prior_used: true },
};
results.push(await testPhase("P0-4_sanity_check", sessionLeakStats, false));

// Case 5: predecode leak in READY-P should fail P0-4
const predecodeLeakStats = {
  ...passingStats,
  "READY-P": { ...passingStats["READY-P"], decoded_hit_pct_median: 30 },
};
results.push(await testPhase("P0-4_sanity_check", predecodeLeakStats, false));

console.log(`\n${"=".repeat(70)}`);
const passed = results.filter((r) => r).length;
console.log(`SELF-TEST: ${passed}/${results.length} cases matched expectation`);
console.log("=".repeat(70));
process.exit(passed === results.length ? 0 : 1);
