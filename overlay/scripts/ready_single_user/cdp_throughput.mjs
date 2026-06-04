/**
 * Aggregate download throughput from CDP network audit (+ optional local server monitor).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadCdpRows } from "../proactive_single_user_v2/cdp_enrich.mjs";

function percentile(xs, p) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1);
  return v[Math.max(0, idx)];
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function round2(x) {
  return x != null && Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}

/** Completed RAD Range GET rows from CDP audit CSV objects. */
export function filterRadCdpRows(cdpRows) {
  return (cdpRows || []).filter(
    (r) =>
      r.completed
      && /\.rad(\?|#|$)/i.test(r.url || "")
      && String(r.status) === "206"
      && Number(r.encodedDataLength) > 0,
  );
}

/**
 * @param {object[]} radRows - filterRadCdpRows output
 * @returns {object}
 */
export function summarizeCdpRadThroughput(radRows) {
  if (!radRows.length) {
    return {
      cdp_rad_request_count: 0,
      cdp_rad_bytes: 0,
      cdp_session_duration_ms: null,
      throughput_cdp_session_mbps: null,
      throughput_per_request_mbps_mean: null,
      throughput_per_request_mbps_p50: null,
      throughput_per_request_mbps_p95: null,
    };
  }

  const perRequestMbps = [];
  let totalBytes = 0;
  let tMin = Infinity;
  let tMax = -Infinity;

  for (const r of radRows) {
    const bytes = Number(r.encodedDataLength) || 0;
    totalBytes += bytes;
    const t0 = Number(r.requestWillBeSent);
    const t1 = Number(r.loadingFinished);
    if (Number.isFinite(t0)) tMin = Math.min(tMin, t0);
    if (Number.isFinite(t1)) tMax = Math.max(tMax, t1);
    const dlMs = Number(r.download_ms);
    if (Number.isFinite(dlMs) && dlMs > 0 && bytes > 0) {
      perRequestMbps.push((bytes * 8) / dlMs / 1000);
    }
  }

  const durMs =
    Number.isFinite(tMin) && Number.isFinite(tMax) && tMax > tMin ? tMax - tMin : null;
  const sessionMbps =
    durMs != null && durMs > 0 ? (totalBytes * 8) / durMs / 1000 : null;

  return {
    cdp_rad_request_count: radRows.length,
    cdp_rad_bytes: totalBytes,
    cdp_session_duration_ms: durMs != null ? Math.round(durMs) : null,
    throughput_cdp_session_mbps: round2(sessionMbps),
    throughput_per_request_mbps_mean: round2(mean(perRequestMbps)),
    throughput_per_request_mbps_p50: round2(percentile(perRequestMbps, 50)),
    throughput_per_request_mbps_p95: round2(percentile(perRequestMbps, 95)),
  };
}

/**
 * Goodput over the configured measure window (move_ms), using client byte counter.
 */
export function throughputFromBytesOverWindow(totalBytes, durationMs) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return round2((totalBytes * 8) / durationMs / 1000);
}

/**
 * Full throughput summary for one trial.
 *
 * @param {object} opts
 * @param {object[]} opts.cdpRows
 * @param {number|null} opts.totalReceivedBytes
 * @param {number} opts.measureDurationMs - typically desc.move_ms
 * @param {number} [opts.warmupDurationMs]
 * @param {object|null} [opts.serverRequestLevel] - server_monitor_summary.request_level
 */
export function summarizeTrialThroughput({
  cdpRows,
  totalReceivedBytes,
  measureDurationMs,
  warmupDurationMs = 0,
  serverRequestLevel = null,
}) {
  const rad = filterRadCdpRows(cdpRows);
  const cdp = summarizeCdpRadThroughput(rad);

  const serverMbps = serverRequestLevel?.throughput_session_mbps;
  const serverValid = Number.isFinite(serverMbps) && serverMbps > 0;

  const bytesOverMeasure = throughputFromBytesOverWindow(
    totalReceivedBytes,
    measureDurationMs,
  );
  const activeMs = (warmupDurationMs || 0) + (measureDurationMs || 0);
  const bytesOverActive = throughputFromBytesOverWindow(totalReceivedBytes, activeMs);

  /** Primary paper-facing field: CDP session for edge/remote; server for local when available. */
  const throughput_Mbps = serverValid
    ? round2(serverMbps)
    : cdp.throughput_cdp_session_mbps;

  return {
    throughput_Mbps,
    throughput_cdp_session_mbps: cdp.throughput_cdp_session_mbps,
    throughput_server_session_mbps: serverValid ? round2(serverMbps) : null,
    throughput_bytes_over_measure_mbps: bytesOverMeasure,
    throughput_bytes_over_active_mbps: bytesOverActive,
    throughput_per_request_mbps_mean: cdp.throughput_per_request_mbps_mean,
    throughput_per_request_mbps_p50: cdp.throughput_per_request_mbps_p50,
    throughput_per_request_mbps_p95: cdp.throughput_per_request_mbps_p95,
    cdp_rad_request_count: cdp.cdp_rad_request_count,
    cdp_rad_bytes: cdp.cdp_rad_bytes,
    cdp_session_duration_ms: cdp.cdp_session_duration_ms,
  };
}

/**
 * Fill throughput fields on an existing trial JSON (e.g. re-analyze old batches).
 */
export async function enrichTrialThroughput(trial) {
  if (trial.throughput_Mbps != null && trial.throughput_cdp_session_mbps != null) {
    return trial;
  }
  const runDir = trial.run_dir;
  if (!runDir) return trial;

  let cdpRows = [];
  try {
    cdpRows = await loadCdpRows(runDir);
  } catch {
    return trial;
  }

  let serverRequestLevel = null;
  try {
    const sm = JSON.parse(
      await fs.readFile(path.join(runDir, "summary", "server_monitor_summary.json"), "utf8"),
    );
    serverRequestLevel = sm.request_level ?? null;
  } catch { /* */ }

  const measureMs = trial.measure_duration_ms ?? 40_000;
  const warmupMs = trial.warmup?.warmup_duration_ms ?? 0;
  const tp = summarizeTrialThroughput({
    cdpRows,
    totalReceivedBytes: trial.total_received_bytes,
    measureDurationMs: measureMs,
    warmupDurationMs: warmupMs,
    serverRequestLevel,
  });

  return { ...trial, ...tp };
}
