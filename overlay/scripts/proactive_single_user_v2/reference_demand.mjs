/**
 * Build unified B0 reference demand trace (median chunk_needed_time per range).
 */
import fs from "node:fs/promises";
import path from "node:path";

function rangeKey(d) {
  const s = d.range_header || d.chunk_id || "";
  const m = String(s).match(/bytes=\d+-\d+/);
  return m ? m[0] : s;
}

export async function loadReferenceDemand(batchDir, deliveryKey) {
  const p = path.join(batchDir, `reference_demand_${deliveryKey}.json`);
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export async function rebuildReferenceFromB0(batchDir, deliveryKey) {
  const dir = path.join(batchDir, "per_trial_json");
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }

  const byRange = new Map();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const t = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
    if (t.baseline_id !== "B0_on_demand" || t.delivery_key !== deliveryKey || !t.hard_gate_passed) continue;
    for (const d of t.proactive_snapshot?.demand_trace || []) {
      const rk = rangeKey(d);
      if (!rk || d.chunk_needed_time == null) continue;
      if (!byRange.has(rk)) byRange.set(rk, []);
      byRange.get(rk).push(d.chunk_needed_time);
    }
  }
  if (!byRange.size) return null;

  const merged = [];
  for (const [rk, times] of byRange) {
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)];
    merged.push({
      chunk_id: rk,
      range_header: rk,
      chunk_needed_time: med,
      source: "b0_median_reference",
    });
  }
  merged.sort((a, b) => a.chunk_needed_time - b.chunk_needed_time);

  const out = path.join(batchDir, `reference_demand_${deliveryKey}.json`);
  await fs.writeFile(out, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}
