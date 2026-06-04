import { BASELINES, DEFAULT_PREDICTION_HORIZON_MS } from "./constants.mjs";

export function expandTrials(matrix, phaseName) {
  const phase = matrix.phases[phaseName];
  if (!phase) throw new Error(`Unknown phase: ${phaseName}`);
  const interleave = phase.interleave === true;
  const trials = [];
  if (interleave) {
    // Round-robin across baselines so each baseline experiences the same
    // cache-warming sequence — B0 t0 / B3 t0 / B4 t0 / B0 t1 / B3 t1 / B4 t1 / ...
    const N = phase.trials_per_baseline ?? 1;
    for (let i = 0; i < N; i++) {
      for (const baselineId of phase.baselines) {
        const arm = BASELINES[baselineId];
        if (!arm) continue;
        trials.push({
          phase: phaseName,
          delivery_key: phase.delivery,
          baseline_id: baselineId,
          baseline: arm,
          trial_index: i,
          scenario: matrix.scenario,
          warmup_ms: matrix.warmup_ms,
          move_ms: matrix.move_ms,
          timeout_ms: matrix.timeout_ms,
          prefetch_budget_bytes: matrix.prefetch_budget_bytes,
          parse_budget_chunks_per_sec: matrix.parse_budget_chunks_per_sec ?? 24,
          prediction_horizon_ms: matrix.default_prediction_horizon_ms ?? DEFAULT_PREDICTION_HORIZON_MS,
          ready_event_policy: matrix.ready_event_policy ?? "parse_or_upload",
        });
      }
    }
    return trials;
  }
  for (const baselineId of phase.baselines) {
    const arm = BASELINES[baselineId];
    if (!arm) continue;
    for (let i = 0; i < (phase.trials_per_baseline ?? 1); i++) {
      trials.push({
        phase: phaseName,
        delivery_key: phase.delivery,
        baseline_id: baselineId,
        baseline: arm,
        trial_index: i,
        scenario: matrix.scenario,
        warmup_ms: matrix.warmup_ms,
        move_ms: matrix.move_ms,
        timeout_ms: matrix.timeout_ms,
        prefetch_budget_bytes: matrix.prefetch_budget_bytes,
        parse_budget_chunks_per_sec: matrix.parse_budget_chunks_per_sec ?? 24,
        prediction_horizon_ms: matrix.default_prediction_horizon_ms ?? DEFAULT_PREDICTION_HORIZON_MS,
        ready_event_policy: matrix.ready_event_policy ?? "parse_or_upload",
      });
    }
  }
  return trials;
}

export function trialId(desc) {
  return [
    desc.delivery_key,
    desc.baseline_id,
    desc.phase,
    `t${desc.trial_index}`,
  ].join("__");
}
