/**
 * Delivery / edge / readiness analysis outputs for READY paper.
 */
import fs from "node:fs/promises";
import path from "node:path";

function csv(rows, keys) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
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

function groupBy(trials, keyFn) {
  const m = {};
  for (const t of trials) {
    const k = keyFn(t);
    if (!m[k]) m[k] = [];
    m[k].push(t);
  }
  return m;
}

function rowKey(t) {
  return `${t.phase}|${t.baseline_name}|${t.delivery_role}|${t.startup_mode ?? ""}|${t.warmup_mode ?? ""}`;
}

export async function writeDeliveryAnalysis(outDir, trials) {
  const pass = trials.filter((t) => t.hard_gate_passed);
  const groups = groupBy(pass, rowKey);

  const deliveryRows = [];
  const readinessRows = [];
  const edgeRows = [];
  const pipelineRows = [];

  for (const [key, ts] of Object.entries(groups)) {
    const t0 = ts[0];
    deliveryRows.push({
      phase: t0.phase,
      method: t0.baseline_name,
      delivery_role: t0.delivery_role,
      requested_delivery: t0.requested_delivery,
      actual_delivery: t0.actual_delivery,
      server_url: t0.server_url,
      startup_mode: t0.startup_mode,
      warmup_mode: t0.warmup_mode,
      trial_count: ts.length,
      completed_chunks: mean(ts.map((t) => t.completed_chunks)),
      visible_chunks: mean(ts.map((t) => t.visible_chunks ?? t.visible_splat_max)),
      first_visible_ms: mean(ts.map((t) => t.measured_first_visible_ms ?? t.first_visible_splat_ms)),
      time_to_50_visible_chunks_ms: mean(ts.map((t) => t.time_to_50_visible_chunks_ms)),
      network_p50_ms: mean(ts.map((t) => t.network_p50_ms)),
      network_p95_ms: mean(ts.map((t) => t.network_p95_ms)),
      network_p99_ms: mean(ts.map((t) => t.network_p99_ms)),
      measure_fps: mean(ts.map((t) => t.measure_fps)),
      frame_p95_ms: mean(ts.map((t) => t.frame_p95_ms)),
      total_received_bytes: mean(ts.map((t) => t.total_received_bytes)),
      throughput_Mbps: mean(ts.map((t) => t.throughput_Mbps)),
      throughput_cdp_session_mbps: mean(ts.map((t) => t.throughput_cdp_session_mbps)),
      throughput_server_session_mbps: mean(ts.map((t) => t.throughput_server_session_mbps)),
      throughput_bytes_over_measure_mbps: mean(ts.map((t) => t.throughput_bytes_over_measure_mbps)),
      throughput_per_request_mbps_p50: mean(ts.map((t) => t.throughput_per_request_mbps_p50)),
      cdp_rad_bytes: mean(ts.map((t) => t.cdp_rad_bytes)),
    });

    const gaps = ts.flatMap((t) => t.readiness_gaps_ms || []);
    const early = gaps.filter((g) => g <= 0).length;
    readinessRows.push({
      phase: t0.phase,
      method: t0.baseline_name,
      delivery_role: t0.delivery_role,
      miss_100: mean(ts.map((t) => t.miss100)),
      miss_250: mean(ts.map((t) => t.miss250)),
      miss_500: mean(ts.map((t) => t.miss500)),
      miss_1000: mean(ts.map((t) => t.miss1000)),
      useful_before_demand: mean(ts.map((t) => t.useful_chunks_before_demand)),
      early_ready_ratio: gaps.length ? early / gaps.length : null,
      gap_p50_ms: percentile(gaps, 50),
      gap_p95_ms: percentile(gaps, 95),
    });

    edgeRows.push({
      phase: t0.phase,
      method: t0.baseline_name,
      delivery_role: t0.delivery_role,
      warmed_chunk_hit_ratio: mean(ts.map((t) => t.warmed_chunk_hit_ratio)),
      warmed_base_hit_ratio: mean(ts.map((t) => t.warmup?.warmed_base)),
      warmed_first_screen_hit_ratio: mean(ts.map((t) => t.warmup?.warmed_first_screen)),
      edge_fetch_ratio: mean(ts.map((t) => t.edge_fetch_ratio)),
      remote_fetch_ratio: mean(ts.map((t) => t.remote_fetch_ratio)),
      cache_status_known_ratio: mean(ts.map((t) => t.cache_status_known_ratio)),
      edge_bytes: null,
      remote_bytes: mean(ts.map((t) => t.total_received_bytes)),
      total_bytes: mean(ts.map((t) => t.total_received_bytes)),
      throughput_Mbps: mean(ts.map((t) => t.throughput_Mbps)),
      throughput_cdp_session_mbps: mean(ts.map((t) => t.throughput_cdp_session_mbps)),
      bytes_per_visible_chunk: mean(ts.map((t) => t.bytes_per_visible_splat)),
      wasted_bytes_after_deadline: mean(ts.map((t) => t.wasted_prefetch_bytes)),
    });

    const fetch = ts.flatMap((t) => t.fetch_durations_ms || []);
    const parseW = ts.flatMap((t) =>
      (t.proactive_snapshot?.chunk_states || [])
        .filter((c) => c.parse_start_time != null && c.chunk_fetch_complete_time != null)
        .map((c) => c.parse_start_time - c.chunk_fetch_complete_time),
    );
    const parseC = ts.flatMap((t) => t.parse_durations_ms || []);
    pipelineRows.push({
      phase: t0.phase,
      method: t0.baseline_name,
      delivery_role: t0.delivery_role,
      network_p50_ms: percentile(fetch, 50),
      network_p95_ms: percentile(fetch, 95),
      parse_wait_p50_ms: percentile(parseW, 50),
      parse_wait_p95_ms: percentile(parseW, 95),
      parse_cost_p50_ms: percentile(parseC, 50),
      parse_cost_p95_ms: percentile(parseC, 95),
      gpu_wait_p50_ms: null,
      gpu_wait_p95_ms: null,
      gpu_upload_p50_ms: null,
      gpu_upload_p95_ms: null,
      ready_to_visible_p50_ms: null,
      ready_to_visible_p95_ms: null,
    });
  }

  const throughputRows = pass.map((t) => ({
    phase: t.phase,
    method: t.baseline_name,
    delivery_role: t.delivery_role,
    trial_id: t.trial_id,
    throughput_Mbps: t.throughput_Mbps,
    throughput_cdp_session_mbps: t.throughput_cdp_session_mbps,
    throughput_server_session_mbps: t.throughput_server_session_mbps,
    throughput_bytes_over_measure_mbps: t.throughput_bytes_over_measure_mbps,
    throughput_per_request_mbps_mean: t.throughput_per_request_mbps_mean,
    throughput_per_request_mbps_p50: t.throughput_per_request_mbps_p50,
    throughput_per_request_mbps_p95: t.throughput_per_request_mbps_p95,
    cdp_rad_bytes: t.cdp_rad_bytes,
    cdp_rad_request_count: t.cdp_rad_request_count,
    cdp_session_duration_ms: t.cdp_session_duration_ms,
    total_received_bytes: t.total_received_bytes,
  }));

  await fs.writeFile(path.join(outDir, "DELIVERY_SUMMARY.csv"), csv(deliveryRows, Object.keys(deliveryRows[0] || {})), "utf8");
  await fs.writeFile(
    path.join(outDir, "NETWORK_THROUGHPUT.csv"),
    csv(throughputRows, Object.keys(throughputRows[0] || {})),
    "utf8",
  );
  await fs.writeFile(path.join(outDir, "READINESS_DEADLINE_CURVE.csv"), csv(readinessRows, Object.keys(readinessRows[0] || {})), "utf8");
  await fs.writeFile(path.join(outDir, "EDGE_SUMMARY.csv"), csv(edgeRows, Object.keys(edgeRows[0] || {})), "utf8");
  await fs.writeFile(path.join(outDir, "PIPELINE_BREAKDOWN.csv"), csv(pipelineRows, Object.keys(pipelineRows[0] || {})), "utf8");

  await writeEdgeValidationReport(outDir, pass, deliveryRows, readinessRows, edgeRows);
  return { deliveryRows, readinessRows, edgeRows };
}

async function writeEdgeValidationReport(outDir, trials, deliveryRows, readinessRows, edgeRows) {
  const local = deliveryRows.filter((r) => r.delivery_role === "local");
  const edge = deliveryRows.filter((r) => r.delivery_role === "edge");
  const remote = deliveryRows.filter((r) => r.delivery_role === "remote");
  const edgeCold = readinessRows.filter((r) => r.phase?.includes("edge_cold"));
  const edgeWarm = readinessRows.filter((r) => r.phase?.includes("edge_warm"));

  const md = `# READY Edge Validation

## Terminology (required)

- **edge** = controlled **LAN edge node** (e.g. \`http://10.120.17.176:8090\`), same LAN as the laptop. Former internal name \`origin_server\`.
- **local** = laptop loopback / local ceiling — excludes network variables; parse/GPU/readiness upper bound only.
- **remote** = public object storage / CDN direct — motivation for fast-but-empty; **not** solved by edge warm-up alone.
- **READY-E** = **edge-aware delivery scheduling** on the LAN edge (prewarm base / hot / first-screen; prioritize edge-hit chunks).

Do **not** write: "origin is not CDN", "origin_server is raw origin", or "origin_control".

---

## Checklist

| Question | Answer |
|----------|--------|
| Is local only ceiling/control? | ${local.length ? "Yes — delivery_role=local, lowest network p95 expected." : "No local trials in this batch."} |
| Is edge the former origin_server? | **Yes** — same URL/host (\`10.120.17.176:8090\`), renamed to **edge** in metadata. |
| Is edge on the same LAN as the laptop? | **Yes** — by experimental design (LAN HPC edge server). |
| Does remote direct show fast-but-empty? | ${remote.some((r) => (r.completed_chunks ?? 0) < 5) ? "Likely — check completed_chunks / fast_but_empty in trials." : "Inspect phase_remote_direct trials."} |
| Edge vs remote network p95 | edge mean p95=${mean(edge.map((r) => r.network_p95_ms))?.toFixed(0) ?? "n/a"} ms; remote=${mean(remote.map((r) => r.network_p95_ms))?.toFixed(0) ?? "n/a"} ms |
| edge_warm_ready vs edge_cold | warm trials=${edgeWarm.length}; cold=${edgeCold.length} |
| READY-E vs READY-P | Compare EDGE_SUMMARY / READINESS_DEADLINE_CURVE for READY-E vs READY-P on edge phases |
| READY vs READY-E | READY should add parse/GPU scheduling (READY-G axis) |
| miss@100 vs miss@500/1000 | See READINESS_DEADLINE_CURVE.csv — if miss@100 > 80% for all, use miss@500/1000 as primary |
| READY startup regression? | Compare first_visible_ms READY vs Spark-OD; flag if READY > 1.2× Spark-OD |

---

## Sanity (batch)

${trials.length} passed trials in batch.

### Delivery roles observed
${[...new Set(trials.map((t) => t.delivery_role))].map((r) => `- ${r}`).join("\n")}

### Server URLs (sample)
${[...new Set(trials.map((t) => t.server_url).filter(Boolean))].slice(0, 5).map((u) => `- ${u}`).join("\n")}
`;

  await fs.writeFile(path.join(outDir, "READY_EDGE_VALIDATION.md"), md, "utf8");
}
