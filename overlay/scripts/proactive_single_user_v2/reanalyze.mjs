#!/usr/bin/env node
/** Recompute v2 ready-aware deadline metrics for existing trials. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichProactiveFromCdp, loadCdpRows } from "./cdp_enrich.mjs";
import { loadReferenceDemand, rebuildReferenceFromB0 } from "./reference_demand.mjs";
import { evaluateProactiveTrialGate } from "./gates.mjs";

const _root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function main() {
  const batchDir = process.argv.find((a) => a.startsWith("--batchDir="))?.slice(11);
  if (!batchDir) throw new Error("--batchDir required");

  await rebuildReferenceFromB0(batchDir, "origin_server");
  await rebuildReferenceFromB0(batchDir, "remote_server");

  const dir = path.join(batchDir, "per_trial_json");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));

  for (const f of files) {
    const p = path.join(dir, f);
    const t = JSON.parse(await fs.readFile(p, "utf8"));
    const runDir = t.run_dir;
    if (!runDir) continue;

    const ref = await loadReferenceDemand(batchDir, t.delivery_key);
    const cdpRows = await loadCdpRows(runDir);
    const snap = enrichProactiveFromCdp(t.proactive_snapshot ?? {}, cdpRows, {
      assetUrlHint: t.asset_url,
      referenceDemand: ref,
      parseFallbackMs: t.parse_p95_ms ?? 0,
      readyEventPolicy: t.ready_event_policy ?? "parse_or_upload",
    });

    t.useful_chunks_before_demand = snap.useful_chunks_before_demand;
    t.demanded_chunks = snap.demanded_chunks;
    t.deadline_miss_ratio_50ms = snap.deadline_miss_ratio_50ms;
    t.deadline_miss_ratio_100ms = snap.deadline_miss_ratio_100ms;
    t.wasted_prefetch_bytes = snap.wasted_prefetch_bytes;
    t.wasted_prefetch_ratio = snap.wasted_prefetch_ratio;
    t.total_prefetch_bytes = snap.total_prefetch_bytes;
    t.total_received_bytes = snap.total_received_bytes;
    t.useful_bytes_ratio = snap.useful_bytes_ratio;
    t.normalized_useful_content_score = snap.normalized_useful_content_score;
    t.ready_event_used = snap.ready_event_used;
    t.ready_event_counts = snap.ready_event_counts;
    t.proactive_snapshot = snap;
    t.metrics_version = 3;
    t.used_b0_reference_demand = snap.used_b0_reference_demand;

    const gate = evaluateProactiveTrialGate(t);
    t.hard_gate_passed = gate.passed;
    t.hard_gate_failures = gate.failures;
    t.status = gate.passed ? "completed" : "failed";

    await fs.writeFile(p, `${JSON.stringify(t, null, 2)}\n`, "utf8");
    console.log(`[reanalyze v2] ${t.trial_id} miss100=${(t.deadline_miss_ratio_100ms * 100).toFixed(1)}% useful_before=${t.useful_chunks_before_demand} pass=${gate.passed}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
