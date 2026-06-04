/**
 * Server monitor summary + client/server alignment.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeAuditCsv } from "../../vrc-paper/experiments/audit_io.mjs";

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function stats(values) {
  const xs = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!xs.length) return { p50: 0, p95: 0, p99: 0, mean: 0, count: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    p99: percentile(xs, 0.99),
    mean,
    count: xs.length,
  };
}

function normRange(h) {
  if (!h) return "";
  return String(h).trim().replace(/\s+/g, "");
}

function requestKey(url, range) {
  try {
    const u = new URL(url, "http://127.0.0.1");
    return `${u.pathname}::${normRange(range)}`;
  } catch {
    return `${url}::${normRange(range)}`;
  }
}

export function buildServerMonitorSummary({
  serverRows,
  processRows,
  windowsRows,
  sessionDurationMs,
  clientNetP95,
}) {
  const rad = serverRows.filter((r) => r.is_rad && r.status_code && r.status_code < 400);
  const totals = stats(rad.map((r) => Number(r.server_total_ms)));
  const ttfb = stats(rad.map((r) => Number(r.server_ttfb_ms)));
  const streamRead = stats(rad.map((r) => Number(r.stream_read_ms || r.stream_end_ms)));
  const bytes = rad.reduce((s, r) => s + Number(r.bytes_sent || 0), 0);
  const durSec = Math.max(0.001, (sessionDurationMs || 1) / 1000);
  const procCpu = stats(processRows.map((r) => Number(r.node_process_cpu_percent)));
  const procElP95 = stats(processRows.map((r) => Number(r.event_loop_delay_p95_ms)));
  const procElMax = Math.max(0, ...processRows.map((r) => Number(r.event_loop_delay_max_ms) || 0));
  const procRssPeak = Math.max(0, ...processRows.map((r) => Number(r.node_process_rss_mb) || 0));
  const procHeapPeak = Math.max(0, ...processRows.map((r) => Number(r.node_process_heap_used_mb) || 0));

  const winCpu = stats(windowsRows.map((r) => Number(r.total_cpu_percent)).filter(Number.isFinite));
  const winDiskRead = windowsRows
    .map((r) => Number(r.disk_read_bytes_per_sec))
    .filter((x) => Number.isFinite(x) && x >= 0)
    .map((b) => b / (1024 * 1024));
  const diskReadStats = stats(winDiskRead);
  const diskQueue = stats(windowsRows.map((r) => Number(r.disk_queue_length)).filter(Number.isFinite));
  const diskActive = stats(windowsRows.map((r) => Number(r.disk_active_time_percent)).filter(Number.isFinite));
  const availMemMin = Math.min(
    ...windowsRows.map((r) => Number(r.available_memory_mb)).filter(Number.isFinite),
    Infinity,
  );

  const nodeCpuP95 = procCpu.p95;
  const serverP95 = totals.p95;
  const elP95 = procElP95.p95;

  let server_cpu_bottleneck = "unknown";
  let disk_io_bottleneck = "unknown";
  let event_loop_bottleneck = "unknown";
  let server_side_likely_bottleneck = "unknown";
  const reasons = [];

  if (processRows.length < 3 || rad.length < 5) {
    reasons.push("insufficient_monitor_samples");
  } else {
    if (serverP95 > 0 && clientNetP95 > 0 && nodeCpuP95 > 80 && serverP95 >= clientNetP95 * 0.7) {
      server_cpu_bottleneck = true;
      reasons.push("server_p95_high_and_node_cpu_p95>80");
    } else if (nodeCpuP95 <= 50 && serverP95 < 80) {
      server_cpu_bottleneck = false;
    } else {
      server_cpu_bottleneck = false;
    }

    if (diskQueue.p95 > 2 || diskActive.p95 > 80) {
      disk_io_bottleneck = streamRead.p95 > 30 ? true : "unknown";
      reasons.push(`disk_queue_p95=${diskQueue.p95}`, `disk_active_p95=${diskActive.p95}`);
    } else {
      disk_io_bottleneck = false;
    }

    if (elP95 > 50 || procElMax > 200) {
      event_loop_bottleneck = true;
      reasons.push(`event_loop_delay_p95=${elP95}`, `max=${procElMax}`);
    } else {
      event_loop_bottleneck = false;
    }

    if (serverP95 < 80 && nodeCpuP95 < 60 && diskQueue.p95 < 2 && clientNetP95 < 120) {
      server_side_likely_bottleneck = false;
      reasons.push("server_fast_vs_client_stalls");
    } else if (server_cpu_bottleneck === true || disk_io_bottleneck === true) {
      server_side_likely_bottleneck = true;
    } else {
      server_side_likely_bottleneck = false;
    }
  }

  return {
    request_level: {
      total_rad_requests: rad.length,
      total_bytes_sent: bytes,
      status_206_count: rad.filter((r) => r.status_code === 206).length,
      status_200_count: rad.filter((r) => r.status_code === 200).length,
      status_error_count: serverRows.filter((r) => r.is_rad && r.status_code >= 400).length,
      server_total_p50_ms: totals.p50,
      server_total_p95_ms: totals.p95,
      server_total_p99_ms: totals.p99,
      server_ttfb_p50_ms: ttfb.p50,
      server_ttfb_p95_ms: ttfb.p95,
      stream_read_p50_ms: streamRead.p50,
      stream_read_p95_ms: streamRead.p95,
      bytes_per_request_mean: rad.length ? bytes / rad.length : 0,
      throughput_session_mbps: (bytes * 8) / durSec / 1e6,
      server_errors: serverRows.filter((r) => r.error_message || r.stream_error).length,
    },
    process_level: {
      node_cpu_mean_percent: procCpu.mean,
      node_cpu_p95_percent: procCpu.p95,
      node_rss_peak_mb: procRssPeak === Infinity ? 0 : procRssPeak,
      node_heap_peak_mb: procHeapPeak,
      event_loop_delay_p95_ms: elP95,
      event_loop_delay_max_ms: procElMax,
      sample_count: processRows.length,
      note: "node_process_cpu_percent is single-process % (can exceed 100% on multi-core)",
    },
    system_level: {
      total_cpu_mean_percent: winCpu.mean,
      total_cpu_p95_percent: winCpu.p95,
      disk_read_mbps_mean: diskReadStats.mean,
      disk_read_mbps_p95: diskReadStats.p95,
      disk_queue_length_p95: diskQueue.p95,
      disk_active_time_p95: diskActive.p95,
      available_memory_min_mb: availMemMin === Infinity ? null : availMemMin,
      sample_count: windowsRows.length,
    },
    bottleneck: {
      server_cpu_bottleneck,
      disk_io_bottleneck,
      event_loop_bottleneck,
      server_side_likely_bottleneck,
      reason: reasons.join(";"),
    },
  };
}

export function buildClientServerAlignment(cdpRows, serverRows) {
  const clientRad = cdpRows.filter((r) => /\.(rad|spz|splat)(\?|#|$)/i.test(r.url) && r.completed);
  const serverRad = serverRows.filter((r) => r.is_rad && r.status_code && r.status_code < 400);

  const serverByKey = new Map();
  for (const s of serverRad) {
    const key = requestKey(s.url, s.range_header);
    if (!serverByKey.has(key)) serverByKey.set(key, []);
    serverByKey.get(key).push(s);
  }

  const alignment = [];
  for (const c of clientRad) {
    const key = requestKey(c.url, c.range_header);
    const pool = serverByKey.get(key) || [];
    const s = pool.shift();
    const clientTotal = Number(c.network_total_ms);
    const serverTotal = s ? Number(s.server_total_ms) : null;
    alignment.push({
      request_key: key,
      url: c.url,
      range_header: c.range_header || "",
      client_request_ts: c.requestWillBeSent,
      client_response_ts: c.responseReceived,
      client_finish_ts: c.loadingFinished,
      client_ttfb_ms: c.ttfb_ms,
      client_download_ms: c.download_ms,
      client_network_total_ms: clientTotal,
      server_start_ts: s?.ts_start_iso ?? "",
      server_headers_written_ts: s ? s.ts_start_iso : "",
      server_end_ts: s?.ts_end_iso ?? "",
      server_ttfb_ms: s?.server_ttfb_ms ?? "",
      server_total_ms: serverTotal ?? "",
      bytes_client: c.encodedDataLength,
      bytes_server: s?.bytes_sent ?? "",
      status_client: c.status,
      status_server: s?.status_code ?? "",
      delta_client_total_minus_server_total_ms:
        serverTotal != null && Number.isFinite(clientTotal)
          ? Math.round((clientTotal - serverTotal) * 100) / 100
          : "",
    });
  }

  return alignment;
}

export async function writeServerMonitorArtifacts(runDir, summaryDir, {
  serverRows,
  processRows,
  windowsRows,
  cdpRows,
  sessionDurationMs,
  clientNetP95,
}) {
  const summary = buildServerMonitorSummary({
    serverRows,
    processRows,
    windowsRows,
    sessionDurationMs,
    clientNetP95,
  });
  const alignment = buildClientServerAlignment(cdpRows, serverRows);

  const jsonPath = path.join(summaryDir, "server_monitor_summary.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const rad = serverRows.filter((r) => r.is_rad);
  const csvRows = rad.map((r) => ({
    ts_end_iso: r.ts_end_iso,
    url: r.url,
    range_header: r.range_header,
    status_code: r.status_code,
    bytes_sent: r.bytes_sent,
    server_total_ms: r.server_total_ms,
    server_ttfb_ms: r.server_ttfb_ms,
    stream_read_ms: r.stream_read_ms,
  }));
  writeAuditCsv(
    csvRows,
    path.join(runDir, "server_monitor", "server_request_summary.csv"),
  );
  writeAuditCsv(alignment, path.join(summaryDir, "client_server_latency_alignment.csv"));

  const b = summary.bottleneck;
  const rl = summary.request_level;
  const pl = summary.process_level;
  const sl = summary.system_level;

  const md = [
    "# Server-side Monitor Summary",
    "",
    "## Request-level",
    "",
    `| metric | value |`,
    `|--------|-------|`,
    `| total_rad_requests | ${rl.total_rad_requests} |`,
    `| total_bytes_sent | ${(rl.total_bytes_sent / 1e6).toFixed(1)} MB |`,
    `| status_206 | ${rl.status_206_count} |`,
    `| server_total P50/P95/P99 | ${rl.server_total_p50_ms.toFixed(1)} / ${rl.server_total_p95_ms.toFixed(1)} / ${rl.server_total_p99_ms.toFixed(1)} ms |`,
    `| server_ttfb P50/P95 | ${rl.server_ttfb_p50_ms.toFixed(1)} / ${rl.server_ttfb_p95_ms.toFixed(1)} ms |`,
    `| stream_read P50/P95 | ${rl.stream_read_p50_ms.toFixed(1)} / ${rl.stream_read_p95_ms.toFixed(1)} ms |`,
    `| throughput (session) | ${rl.throughput_session_mbps.toFixed(1)} Mbps |`,
    "",
    "## Process-level (Node single-process)",
    "",
    `| node CPU mean/P95 | ${pl.node_cpu_mean_percent.toFixed(1)}% / ${pl.node_cpu_p95_percent.toFixed(1)}% |`,
    `| RSS peak | ${pl.node_rss_peak_mb.toFixed(1)} MB |`,
    `| event loop delay P95/max | ${pl.event_loop_delay_p95_ms} / ${pl.event_loop_delay_max_ms} ms |`,
    "",
    "## System-level (Windows)",
    "",
    `| total CPU mean/P95 | ${sl.total_cpu_mean_percent.toFixed(1)}% / ${sl.total_cpu_p95_percent.toFixed(1)}% |`,
    `| disk read mean/P95 | ${sl.disk_read_mbps_mean.toFixed(2)} / ${sl.disk_read_mbps_p95.toFixed(2)} MB/s |`,
    `| disk queue P95 | ${sl.disk_queue_length_p95} |`,
    `| disk active P95 | ${sl.disk_active_time_p95}% |`,
    "",
    "## Bottleneck decision",
    "",
    `| check | value |`,
    `|-------|-------|`,
    `| server_cpu_bottleneck | ${b.server_cpu_bottleneck} |`,
    `| disk_io_bottleneck | ${b.disk_io_bottleneck} |`,
    `| event_loop_bottleneck | ${b.event_loop_bottleneck} |`,
    `| server_side_likely_bottleneck | ${b.server_side_likely_bottleneck} |`,
    `| reason | ${b.reason} |`,
    "",
    b.server_side_likely_bottleneck === false
      ? "> server-side file serving is unlikely to be the dominant bottleneck; the dominant visible stalls are client-side processing/rendering."
      : "> server-side local file serving contributes to the observed latency and must be optimized before claiming client-side bottleneck.",
    "",
  ].join("\n");

  await fs.writeFile(path.join(summaryDir, "server_monitor_summary.md"), md, "utf8");

  return { summary, alignment };
}
