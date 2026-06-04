/**
 * Pass criteria loader and evaluator.
 * Reads pass_criteria.json and evaluates each rule against batch metrics.
 *
 * Returns:
 *   {
 *     phase: string,
 *     all_pass: boolean,
 *     hard_failures: [{check_id, expected, actual, auto_fix}],   // claim gate, blocking
 *     soft_failures: [{...}],                                     // can auto-fix
 *     passed: [check_id, ...]
 *   }
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASS_CRITERIA_PATH = path.resolve(
  __dirname,
  "../../paper_materials/ready_single_user_v1/supervisor/pass_criteria.json",
);

let _cache = null;

export async function loadPassCriteria() {
  if (_cache) return _cache;
  const raw = await fs.readFile(PASS_CRITERIA_PATH, "utf8");
  _cache = JSON.parse(raw);
  return _cache;
}

/** Compute median of a numeric array, ignoring null/NaN. */
function median(arr) {
  const v = (arr || [])
    .filter((x) => x != null && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.floor(v.length / 2)];
}

/** Compute mean. */
function mean(arr) {
  const v = (arr || []).filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/** Aggregate per-baseline median metrics from raw trial JSONs. */
export function aggregateBaselines(trials) {
  const grouped = {};
  for (const t of trials) {
    const b = t.baseline_name || t.baseline_id || "unknown";
    if (!grouped[b]) grouped[b] = [];
    grouped[b].push(t);
  }
  const stats = {};
  for (const [b, ts] of Object.entries(grouped)) {
    stats[b] = {
      n: ts.length,
      q5s_median: median(ts.map((t) => t.quality_at_5s)),
      q10s_median: median(ts.map((t) => t.quality_at_10s)),
      t1m_median: median(ts.map((t) => t.time_to_1M_visible_splats_ms)),
      blank_ratio_median: median(ts.map((t) => t.blank_ratio)),
      first_visible_median: median(ts.map((t) => t.first_visible_splat_ms)),
      throughput_median: median(ts.map((t) => t.throughput_Mbps)),
      fps_median: median(ts.map((t) => t.measure_fps)),
      completed_chunks_median: median(ts.map((t) => t.completed_chunks)),
      decoded_hit_pct_median: median(ts.map((t) => t.cache_hit_breakdown?.decoded_hit_pct)),
      raw_hit_pct_median: median(ts.map((t) => t.cache_hit_breakdown?.raw_hit_pct)),
      network_fallthrough_pct_median: median(ts.map((t) => t.cache_hit_breakdown?.network_fallthrough_pct)),
      continuous_tick_count_median: median(ts.map((t) => t.continuous_tick_count)),
      session_prior_used: ts.some((t) => t.session_prior_used === true),
      ready_lead_time_median: median(ts.map((t) => t.ready_lead_time_ms_p50)),
      fetch_lead_time_median: median(ts.map((t) => t.fetch_lead_time_ms_p50)),
      critical_network_wait_median: median(ts.map((t) => t.critical_network_wait_ms_p50)),
      critical_parse_wait_median: median(ts.map((t) => t.critical_parse_wait_ms_p50)),
      demand_to_visible_median: median(ts.map((t) => t.demand_to_visible_ms_p50)),
    };
  }
  return stats;
}

/** Resolve dotted path: "READY.q5s_median" -> stats["READY"].q5s_median.
 *  Handles baseline names containing hyphens like "Spark-OD" or "READY-P". */
function resolveDotted(stats, dotted) {
  // Split only at the LAST dot to allow hyphens in baseline names
  const lastDot = dotted.lastIndexOf(".");
  if (lastDot < 0) {
    return stats[dotted];
  }
  const baseline = dotted.slice(0, lastDot);
  const field = dotted.slice(lastDot + 1);
  const obj = stats[baseline];
  if (obj == null) return null;
  return obj[field];
}

/**
 * Evaluate a single check rule.
 * Rules are simple expressions parsed at runtime. Supported forms:
 *   "READY.q5s_median >= 1.10 * Spark-OD.q5s_median"
 *   "READY-P.decoded_hit_pct == 0 AND READY-P.continuous_tick_count_median <= 1"
 *   "all_baselines.measure_fps > 30"
 *   "exactly_8_main_baselines"  (named rules, evaluated specially)
 */
function evaluateCheck(check, stats, expectedTable) {
  const rule = check.rule || "";

  // Named rules
  if (rule === "exactly_8_main_baselines") {
    const expected = check.expected || [];
    const actual = Object.keys(stats);
    const missing = expected.filter((e) => !actual.includes(e));
    const extra = actual.filter((a) => !expected.includes(a) && a !== "Oracle" && a !== "Upper Bound");
    return {
      pass: missing.length === 0,
      detail: `expected ${expected.length}, got ${actual.length}, missing=[${missing.join(",")}] extra=[${extra.join(",")}]`,
    };
  }

  if (rule === "baseline_config_audit_csv_matches_todolist") {
    // Caller supplies expectedTable; check against stats.config_audit
    return { pass: null, detail: "deferred to baseline_config_audit step" };
  }

  if (rule === "diff(actual_config, expected_config) == empty") {
    const exp = check.expected_table || {};
    const actual = stats.config_audit || {};
    const mismatches = [];
    for (const [b, fields] of Object.entries(exp)) {
      const got = actual[b];
      if (!got) {
        mismatches.push(`${b}: missing from audit`);
        continue;
      }
      for (const [k, v] of Object.entries(fields)) {
        if (got[k] !== v) {
          mismatches.push(`${b}.${k}: expected=${v} actual=${got[k]}`);
        }
      }
    }
    return {
      pass: mismatches.length === 0,
      detail: mismatches.length === 0 ? "all match" : mismatches.join("; "),
    };
  }

  // P0-2 instrumentation: timestamp coverage check
  if (rule === "non_null_rate_of_each_timestamp >= 0.95") {
    const fields = check.fields || [];
    const trials = stats._all_trials || [];
    if (!trials.length) {
      return { pass: null, detail: "no trial data available for coverage check" };
    }
    const coverage = {};
    for (const f of fields) {
      let nonNull = 0;
      for (const t of trials) {
        const ch = t.proactive_snapshot?.chunk_states || [];
        for (const c of ch) {
          if (c[f] != null) nonNull += 1;
        }
      }
      const total = trials.reduce((s, t) => s + (t.proactive_snapshot?.chunk_states?.length || 0), 0);
      coverage[f] = total > 0 ? nonNull / total : 0;
    }
    const failing = Object.entries(coverage).filter(([_, v]) => v < 0.95);
    return {
      pass: failing.length === 0,
      detail: failing.length === 0
        ? `all ${fields.length} fields >= 95% coverage`
        : `low coverage: ${failing.map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`).join(", ")}`,
    };
  }

  // P0-2 derived metrics presence
  if (rule === "all_present_per_trial") {
    const fields = check.fields || [];
    const trials = stats._all_trials || [];
    if (!trials.length) {
      return { pass: null, detail: "no trial data available" };
    }
    const missing = {};
    for (const f of fields) {
      const nullCount = trials.filter((t) => t[f] == null).length;
      if (nullCount > 0) missing[f] = nullCount;
    }
    return {
      pass: Object.keys(missing).length === 0,
      detail: Object.keys(missing).length === 0
        ? `all ${fields.length} derived metrics present`
        : `missing: ${Object.entries(missing).map(([k, v]) => `${k}(${v} trials)`).join(", ")}`,
    };
  }

  // P0-2 cache hit breakdown sums to 100
  if (rule === "abs(decoded_hit_pct + raw_hit_pct + network_fallthrough_pct - 100) < 1.0") {
    const trials = stats._all_trials || [];
    if (!trials.length) return { pass: null, detail: "no trial data" };
    const errors = [];
    for (const t of trials) {
      const cb = t.cache_hit_breakdown;
      if (!cb) continue;
      const sum = (cb.decoded_hit_pct || 0) + (cb.raw_hit_pct || 0) + (cb.network_fallthrough_pct || 0);
      if (Math.abs(sum - 100) > 1.0) {
        errors.push(`${t.baseline_name}: sum=${sum.toFixed(1)}`);
      }
    }
    return {
      pass: errors.length === 0,
      detail: errors.length === 0 ? "all sums within 1pp of 100" : errors.join(", "),
    };
  }

  // Simple comparison: "X.field >= 1.10 * Y.field"
  const cmpMatch = rule.match(
    /^([\w\-\.]+)\s*(>=|<=|>|<|==|!=)\s*([\d.]+)\s*\*\s*([\w\-\.]+)$/,
  );
  if (cmpMatch) {
    const [, lhs, op, factor, rhs] = cmpMatch;
    const lv = resolveDotted(stats, lhs);
    const rv = resolveDotted(stats, rhs);
    const f = Number(factor);
    if (lv == null || rv == null) {
      return { pass: false, detail: `null operand: lhs=${lhs}=${lv}, rhs=${rhs}=${rv}` };
    }
    const target = f * rv;
    let pass = false;
    if (op === ">=") pass = lv >= target;
    else if (op === "<=") pass = lv <= target;
    else if (op === ">") pass = lv > target;
    else if (op === "<") pass = lv < target;
    else if (op === "==") pass = Math.abs(lv - target) < 1e-6;
    return {
      pass,
      detail: `${lhs}=${formatNum(lv)} ${op} ${factor}*${rhs}=${formatNum(target)} -> ${pass ? "PASS" : "FAIL"}`,
    };
  }

  // Direct baseline-to-baseline (no factor): "X.field >= Y.field"
  const baselineCmpMatch = rule.match(
    /^([\w\-]+\.[\w_]+)\s*(>=|<=|>|<|==|!=)\s*([\w\-]+\.[\w_]+)$/,
  );
  if (baselineCmpMatch) {
    const [, lhs, op, rhs] = baselineCmpMatch;
    const lv = resolveDotted(stats, lhs);
    const rv = resolveDotted(stats, rhs);
    if (lv == null || rv == null) {
      return { pass: false, detail: `null operand: lhs=${lhs}=${lv}, rhs=${rhs}=${rv}` };
    }
    let pass = false;
    if (op === ">=") pass = lv >= rv;
    else if (op === "<=") pass = lv <= rv;
    else if (op === ">") pass = lv > rv;
    else if (op === "<") pass = lv < rv;
    else if (op === "==") pass = Math.abs(lv - rv) < 1e-6;
    return {
      pass,
      detail: `${lhs}=${formatNum(lv)} ${op} ${rhs}=${formatNum(rv)} -> ${pass ? "PASS" : "FAIL"}`,
    };
  }

  // Direct comparison: "X.field >= 30"
  const directMatch = rule.match(
    /^([\w\-\.]+)\s*(>=|<=|>|<|==|!=)\s*([\d.]+)$/,
  );
  if (directMatch) {
    const [, lhs, op, val] = directMatch;
    const lv = resolveDotted(stats, lhs);
    const v = Number(val);
    if (lv == null) return { pass: false, detail: `null lhs ${lhs}` };
    let pass = false;
    if (op === ">=") pass = lv >= v;
    else if (op === "<=") pass = lv <= v;
    else if (op === ">") pass = lv > v;
    else if (op === "<") pass = lv < v;
    else if (op === "==") pass = Math.abs(lv - v) < 1e-6;
    return {
      pass,
      detail: `${lhs}=${formatNum(lv)} ${op} ${val} -> ${pass ? "PASS" : "FAIL"}`,
    };
  }

  // Boolean field check: "READY.session_prior_used == false"
  const boolMatch = rule.match(/^([\w\-\.]+)\s*==\s*(true|false)$/);
  if (boolMatch) {
    const [, lhs, valStr] = boolMatch;
    const lv = resolveDotted(stats, lhs);
    const v = valStr === "true";
    return {
      pass: lv === v,
      detail: `${lhs}=${lv} expected ${v}`,
    };
  }

  // AND-joined rules: "A AND B AND C"
  if (rule.includes(" AND ")) {
    const parts = rule.split(" AND ").map((s) => s.trim());
    const sub = parts.map((p) =>
      evaluateCheck({ ...check, rule: p }, stats, expectedTable),
    );
    return {
      pass: sub.every((s) => s.pass),
      detail: sub.map((s) => s.detail).join(" | "),
    };
  }

  // Fall-through: cannot evaluate
  return {
    pass: null,
    detail: `unsupported rule syntax: ${rule}`,
  };
}

function formatNum(x) {
  if (x == null) return "null";
  if (typeof x !== "number") return String(x);
  if (Math.abs(x) < 0.01) return x.toFixed(4);
  if (Math.abs(x) < 100) return x.toFixed(3);
  return x.toFixed(0);
}

/** Evaluate all checks for a given phase against measured stats. */
export async function evaluatePhase(phaseId, stats) {
  const criteria = await loadPassCriteria();
  const phaseSpec = criteria[phaseId];
  if (!phaseSpec) {
    return { phase: phaseId, all_pass: false, error: `phase ${phaseId} not found in pass_criteria.json` };
  }

  const checks = phaseSpec.checks || [];
  const results = checks.map((c) => {
    const r = evaluateCheck(c, stats);
    return {
      check_id: c.id,
      rule: c.rule,
      pass: r.pass,
      detail: r.detail,
      auto_fix: c.auto_fix,
      blocking: phaseSpec.blocking !== false,
      claim_gate: phaseSpec.claim_gate === true,
    };
  });

  const hard_failures = results.filter(
    (r) => r.pass === false && (r.auto_fix === null || r.claim_gate),
  );
  const soft_failures = results.filter(
    (r) => r.pass === false && r.auto_fix !== null && !r.claim_gate,
  );
  const unevaluable = results.filter((r) => r.pass === null);
  const passed = results.filter((r) => r.pass === true).map((r) => r.check_id);

  return {
    phase: phaseId,
    description: phaseSpec.description,
    all_pass: hard_failures.length === 0 && soft_failures.length === 0,
    hard_failures,
    soft_failures,
    unevaluable,
    passed,
    is_claim_gate: phaseSpec.claim_gate === true,
  };
}
