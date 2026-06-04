/**
 * LAN edge warm-up protocol (phase_edge_warm_ready).
 * Pre-measurement warm-up is logged separately from measured_first_visible_ms.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { classifyWarmupTargets } from "./warmup_targets.mjs";

export async function runEdgeWarmup({ assetUrl, manifest, runDir, useNodeFetch = true }) {
  const started = Date.now();
  const targets = classifyWarmupTargets(manifest || []);
  const results = [];
  let success = 0;
  let fail = 0;
  let bytes = 0;

  if (useNodeFetch && assetUrl) {
    for (const t of targets) {
      const range = t.range;
      const url = t.url || assetUrl;
      try {
        const rangeHdr = range.startsWith("bytes=") ? range : `bytes=${range}`;
        const res = await fetch(url, {
          headers: { Range: rangeHdr },
        });
        const buf = await res.arrayBuffer();
        const ok = res.status === 206 || res.status === 200;
        if (ok) {
          success += 1;
          bytes += buf.byteLength;
        } else fail += 1;
        results.push({
          range,
          ok,
          status: res.status,
          bytes: buf.byteLength,
          warmed_first_screen: t.warmed_first_screen,
          warmed_base: t.warmed_base,
          warmed_hot: t.warmed_hot,
        });
      } catch (e) {
        fail += 1;
        results.push({ range, ok: false, error: String(e?.message || e) });
      }
    }
  }

  const finished = Date.now();
  const summary = {
    warmup_started_at: new Date(started).toISOString(),
    warmup_finished_at: new Date(finished).toISOString(),
    warmup_duration_ms: finished - started,
    warmup_chunk_count: targets.length,
    warmup_success_count: success,
    warmup_fail_count: fail,
    warmup_bytes: bytes,
    warmup_location: useNodeFetch ? "edge_only" : "browser_and_edge",
    warmed_first_screen: results.filter((r) => r.warmed_first_screen && r.ok).length,
    warmed_base: results.filter((r) => r.warmed_base && r.ok).length,
    warmed_hot: results.filter((r) => r.warmed_hot && r.ok).length,
  };

  const warmDir = path.join(runDir, "warmup");
  await fs.mkdir(warmDir, { recursive: true });
  await fs.writeFile(path.join(warmDir, "warmup_targets.jsonl"), `${results.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  const csvHdr = "range,ok,status,bytes,warmed_first_screen,warmed_base,warmed_hot\n";
  const csvBody = results
    .map((r) =>
      [
        r.range,
        r.ok,
        r.status ?? "",
        r.bytes ?? 0,
        r.warmed_first_screen ? 1 : 0,
        r.warmed_base ? 1 : 0,
        r.warmed_hot ? 1 : 0,
      ].join(","),
    )
    .join("\n");
  await fs.writeFile(path.join(warmDir, "warmup_targets.csv"), csvHdr + csvBody + "\n", "utf8");
  await fs.writeFile(path.join(warmDir, "warmup_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return { summary, results, targets };
}
