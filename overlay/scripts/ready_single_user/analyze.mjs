#!/usr/bin/env node
/** Aggregate per-trial JSON into baseline summary CSV (no paper report generation). */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  let batchDir = null;
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) batchDir = path.resolve(a.slice(11));
  }
  if (!batchDir) throw new Error("--batchDir required");
  return { batchDir };
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function percentile(xs, p) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1);
  return v[Math.max(0, idx)];
}

async function main() {
  const { batchDir } = parseArgs(process.argv.slice(2));
  const dir = path.join(batchDir, "per_trial_json");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const trials = await Promise.all(
    files.map((f) => fs.readFile(path.join(dir, f), "utf8").then(JSON.parse)),
  );

  const groups = {};
  for (const t of trials) {
    const k = `${t.phase}|${t.baseline_id}|${t.trace ?? ""}|${t.network_profile ?? ""}`;
    (groups[k] ??= []).push(t);
  }

  const rows = [];
  for (const [key, ts] of Object.entries(groups)) {
    const [phase, baseline_id] = key.split("|");
    rows.push({
      phase,
      baseline_id,
      baseline_name: ts[0]?.baseline_name,
      n: ts.length,
      fv_mean_ms: mean(ts.map((t) => t.first_visible_splat_ms)),
      fv_p50_ms: percentile(ts.map((t) => t.first_visible_splat_ms), 50),
      t1m_mean_ms: mean(ts.map((t) => t.time_to_1M_visible_splats_ms)),
      miss100_mean: mean(ts.map((t) => t.miss100)),
      net_p50_mean: mean(ts.map((t) => t.cdp_net_p50_ms)),
      blank_ratio_mean: mean(ts.map((t) => t.blank_ratio)),
    });
  }

  const header = Object.keys(rows[0] ?? { phase: "", baseline_id: "", n: 0 });
  const csv = [
    header.join(","),
    ...rows.map((r) => header.map((h) => r[h] ?? "").join(",")),
  ].join("\n") + "\n";

  const out = path.join(batchDir, "dls_summary.csv");
  await fs.writeFile(out, csv, "utf8");
  console.log(`[dls] Wrote ${out} (${trials.length} trials)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
