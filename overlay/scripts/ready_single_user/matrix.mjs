import { BASELINES, DEFAULT_PREDICTION_HORIZON_MS, LEGACY_BASELINE_MAP } from "./constants.mjs";

import { normalizeDeliveryKey } from "./delivery_metadata.mjs";



function mapStartupMode(phase) {

  const m = phase.startup_mode ?? "cold";

  if (m === "warm_edge" || m === "warm") return "warm_edge";

  if (m === "warm_remote_equal") return "warm_remote_equal";

  if (m === "cold_start" || m === "cold") return "cold_start";

  return m;

}



export function expandTrials(matrix, phaseName, opts = {}) {

  const phase = matrix.phases[phaseName];

  if (!phase) throw new Error(`Unknown phase: ${phaseName}`);

  const interleave = phase.interleave === true;

  const trials = [];

  const resolveBaselineId = (id) => LEGACY_BASELINE_MAP[id] ?? id;

  const N = opts.trialsPerBaseline ?? phase.trials_per_baseline ?? 1;



  const pushTrial = (baselineId, extra = {}) => {

    const canonicalId = resolveBaselineId(baselineId);

    const arm = BASELINES[canonicalId];

    if (!arm) return;

    const dk = extra.delivery_key ?? phase.delivery ?? "edge";

    const norm = normalizeDeliveryKey(dk);

    trials.push({

      phase: phaseName,

      delivery_key: norm.storage_key,

      delivery_role: norm.delivery_role,

      requested_delivery: norm.display,

      baseline_id: canonicalId,

      baseline_name: arm.name,

      baseline: arm,

      scenario: matrix.scenario,

      warmup_ms:

        extra.warmup_ms

        ?? (phase.warmup_mode === "base_hot_first_screen" ? (phase.warmup_ms ?? 8000) : 0),

      move_ms: matrix.move_ms,

      timeout_ms: matrix.timeout_ms,

      prefetch_budget_bytes: matrix.prefetch_budget_bytes,

      parse_budget_chunks_per_sec: matrix.parse_budget_chunks_per_sec ?? 24,

      prediction_horizon_ms: matrix.default_prediction_horizon_ms ?? DEFAULT_PREDICTION_HORIZON_MS,

      ready_event_policy: matrix.ready_event_policy ?? "parse_or_upload",

      startup_mode: mapStartupMode(phase),

      warmup_mode: phase.warmup_mode ?? "none",

      trace: extra.trace ?? phase.trace ?? matrix.default_trace ?? "orbit",

      network_profile: extra.network_profile ?? null,

      trial_index: extra.trial_index ?? 0,

    });

  };



  const baselines = phase.baselines ?? [];

  const deliveryKeys = phase.deliveries

    ? phase.deliveries

    : [phase.delivery ?? "edge"];



  if (phase.network_profiles) {

    for (const np of phase.network_profiles) {

      for (let i = 0; i < N; i++) {

        for (const dk of deliveryKeys) {

          for (const baselineId of baselines) {

            pushTrial(baselineId, { network_profile: np, trial_index: i, delivery_key: dk });

          }

        }

      }

    }

    return interleave ? interleaveTrials(trials, baselines.length) : trials;

  }



  if (phase.traces && phase.traces.length > 1) {

    for (const tr of phase.traces) {

      for (let i = 0; i < N; i++) {

        for (const dk of deliveryKeys) {

          for (const baselineId of baselines) {

            pushTrial(baselineId, { trace: tr, trial_index: i, delivery_key: dk });

          }

        }

      }

    }

    return interleave ? interleaveTrials(trials, baselines.length) : trials;

  }



  if (interleave) {

    for (let i = 0; i < N; i++) {

      for (const dk of deliveryKeys) {

        for (const baselineId of baselines) {

          pushTrial(baselineId, { trial_index: i, delivery_key: dk });

        }

      }

    }

    return trials;

  }



  for (const dk of deliveryKeys) {

    for (const baselineId of baselines) {

      for (let i = 0; i < N; i++) {

        pushTrial(baselineId, { trial_index: i, delivery_key: dk });

      }

    }

  }

  return trials;

}



/** Round-robin by trial_index: all baselines for t0, then t1, … */
function interleaveTrials(trials, _baselineCount) {
  if (!trials.length) return trials;
  const byTi = new Map();
  for (const t of trials) {
    const ti = t.trial_index ?? 0;
    if (!byTi.has(ti)) byTi.set(ti, []);
    byTi.get(ti).push(t);
  }
  const out = [];
  for (const ti of [...byTi.keys()].sort((a, b) => a - b)) {
    const group = byTi.get(ti);
    group.sort((a, b) => String(a.baseline_id).localeCompare(String(b.baseline_id)));
    out.push(...group);
  }
  return out;
}



export function trialId(desc) {

  const parts = [

    desc.delivery_key,

    desc.baseline_id,

    desc.phase,

  ];

  if (desc.network_profile) parts.push(desc.network_profile);

  if (desc.trace && desc.trace !== "orbit") parts.push(desc.trace);

  parts.push(`t${desc.trial_index}`);

  return parts.join("__");

}


