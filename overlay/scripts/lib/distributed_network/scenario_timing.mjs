/** Per-scenario warmup / startup_mode — cold_start always warmup_ms=0. */

export function isColdStartScenario(scenario) {
  return (
    scenario === "cold_start_single_user" || String(scenario ?? "").startsWith("cold_start_")
  );
}

/**
 * @param {object} matrix
 * @param {string} scenario
 * @returns {{ warmup_ms: number, move_ms: number, startup_mode: string }}
 */
export function resolveTrialTiming(matrix, scenario) {
  const moveDefault = matrix.move_ms ?? 40_000;
  if (isColdStartScenario(scenario)) {
    const cs = matrix.cold_start ?? {};
    return {
      warmup_ms: cs.warmup_ms ?? 0,
      move_ms: cs.move_ms ?? moveDefault,
      startup_mode: "cold_start",
    };
  }
  const o = matrix.scenario_timing?.[scenario];
  return {
    warmup_ms: o?.warmup_ms ?? matrix.warmup_ms ?? 20_000,
    move_ms: o?.move_ms ?? moveDefault,
    startup_mode: o?.startup_mode ?? "steady_state",
  };
}
