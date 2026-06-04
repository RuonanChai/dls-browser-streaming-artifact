/**
 * Merge CDP + browser probe; unified B0 reference demand; parse-aware ready
 * (v2 ready_event_policy: prefer browser-side parse/upload complete time when
 * the ready-aware controller has populated it for prefetched chunks).
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseCsvLine(line, headers) {
  const cols = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === "," && !inQ) {
      cols.push(cur);
      cur = "";
    } else cur += c;
  }
  cols.push(cur);
  const row = {};
  headers.forEach((h, i) => {
    row[h] = cols[i] ?? "";
  });
  return row;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => parseCsvLine(line, headers));
}

export async function loadCdpRows(runDir) {
  const p = path.join(runDir, "cdp_network_audit.csv");
  try {
    return parseCsv(await fs.readFile(p, "utf8"));
  } catch {
    return [];
  }
}

export function rangeKey(chunkId) {
  if (!chunkId) return "";
  const m = String(chunkId).match(/bytes=\d+-\d+/);
  if (m) return m[0];
  if (String(chunkId).startsWith("bytes=")) return chunkId;
  return "";
}

function browserByRange(proactiveSnap) {
  const m = new Map();
  for (const ch of proactiveSnap.chunk_states || []) {
    const rk = rangeKey(ch.chunk_id) || rangeKey(ch.range_header);
    if (!rk) continue;
    const prev = m.get(rk);
    // Prefer entries with parse_complete or upload_complete > 0
    const score = (ch.chunk_upload_complete_time != null ? 4 : 0)
      + (ch.chunk_parse_complete_time != null ? 2 : 0)
      + (ch.chunk_fetch_complete_time != null ? 1 : 0);
    const prevScore = !prev ? -1 : (prev.chunk_upload_complete_time != null ? 4 : 0)
      + (prev.chunk_parse_complete_time != null ? 2 : 0)
      + (prev.chunk_fetch_complete_time != null ? 1 : 0);
    if (score >= prevScore) m.set(rk, ch);
  }
  return m;
}

function readyTimeForChunk(ch, policy = "parse_or_upload", parseFallbackMs = 0) {
  // Spec §3.1: prefer parse + upload complete; secondary parse complete.
  if (policy === "upload_only") {
    if (ch.chunk_upload_complete_time != null) return { t: ch.chunk_upload_complete_time, ev: "upload" };
  }
  if (ch.chunk_upload_complete_time != null) return { t: ch.chunk_upload_complete_time, ev: "upload" };
  if (ch.chunk_parse_complete_time != null) return { t: ch.chunk_parse_complete_time, ev: "parse_only" };
  if (ch.chunk_ready_time != null) return { t: ch.chunk_ready_time, ev: "ready_field" };
  if (ch.chunk_fetch_complete_time != null && parseFallbackMs > 0) {
    return { t: ch.chunk_fetch_complete_time + parseFallbackMs, ev: "fetch_plus_estimate" };
  }
  return { t: null, ev: null };
}

export function enrichProactiveFromCdp(proactiveSnap, cdpRows, opts = {}) {
  const {
    referenceDemand = null,
    assetUrlHint = "",
    parseFallbackMs = 0,
    readyEventPolicy = "parse_or_upload",
  } = opts;
  const rad = cdpRows.filter(
    (r) =>
      /\.rad(\?|#|$)/i.test(r.url || "")
      && (r.range_header || "").startsWith("bytes=")
      && Number(r.status) === 206,
  );

  const refByRange = new Map();
  if (referenceDemand?.length) {
    for (const d of referenceDemand) {
      const rk = rangeKey(d.range_header || d.chunk_id);
      if (rk && d.chunk_needed_time != null) refByRange.set(rk, d.chunk_needed_time);
    }
  }

  const browser = browserByRange(proactiveSnap);

  if (!rad.length) {
    // No CDP rows — synthesize chunk states from browser snapshot alone.
    const chunks = [];
    let useful_before = 0;
    let miss50 = 0;
    let miss100 = 0;
    let wasted_bytes = 0;
    let total_received = 0;
    let useful_bytes = 0;
    const demand = proactiveSnap.demand_trace || [];
    const demandSet = new Set(demand.map((d) => rangeKey(d.range_header || d.chunk_id)));
    const readyEventCounts = {};
    for (const [rk, ch] of browser) {
      if (ch.bytes > 0) total_received += ch.bytes;
      const needed = ch.chunk_needed_time;
      const { t: ready, ev } = readyTimeForChunk(ch, readyEventPolicy, parseFallbackMs);
      if (ev) readyEventCounts[ev] = (readyEventCounts[ev] || 0) + 1;
      if (needed != null && ready != null) {
        if (ready <= needed) {
          useful_before += 1;
          if (ch.bytes > 0) useful_bytes += ch.bytes;
        }
        if (ready > needed + 50) miss50 += 1;
        if (ready > needed + 100) miss100 += 1;
      } else if (ch.chunk_prefetch_start_time != null && !demandSet.has(rk) && ch.bytes > 0) {
        wasted_bytes += ch.bytes;
      }
      chunks.push({ ...ch, chunk_ready_time: ready });
    }
    const demanded = demand.length;
    return {
      ...proactiveSnap,
      chunk_states: chunks,
      demanded_chunks: demanded,
      useful_chunks_before_demand: useful_before,
      deadline_miss_ratio_50ms: demanded ? miss50 / demanded : 0,
      deadline_miss_ratio_100ms: demanded ? miss100 / demanded : 0,
      wasted_prefetch_bytes: wasted_bytes,
      total_received_bytes: total_received,
      useful_bytes_ratio: total_received > 0 ? useful_bytes / total_received : 0,
      normalized_useful_content_score: demanded ? useful_before / demanded : 0,
      cdp_enriched: false,
      ready_event_counts: readyEventCounts,
      ready_event_used: Object.keys(readyEventCounts).sort((a, b) => readyEventCounts[b] - readyEventCounts[a])[0] || null,
      metrics_version: 3,
    };
  }

  const t0 = Math.min(...rad.map((r) => Number(r.requestWillBeSent)).filter(Number.isFinite));
  const demandByRange = new Map();

  for (const r of rad.sort((a, b) => Number(a.requestWillBeSent) - Number(b.requestWillBeSent))) {
    const rk = r.range_header;
    const url = r.url || assetUrlHint;
    const cid = `${url}::${rk}`;
    if (demandByRange.has(rk)) continue;
    const neededMs = refByRange.has(rk)
      ? refByRange.get(rk)
      : Number(r.requestWillBeSent) - t0;
    demandByRange.set(rk, {
      chunk_id: cid,
      chunk_needed_time: neededMs,
      url,
      range_header: rk,
      source: refByRange.has(rk) ? "b0_reference_demand" : "trial_first_request",
      encoded_bytes: Number(r.encodedDataLength) || 0,
    });
  }

  const demand_trace = [...demandByRange.values()];
  const chunk_states = new Map();
  const readyEventCounts = {};

  for (const d of demand_trace) {
    const rk = rangeKey(d.range_header);
    const br = browser.get(rk) || {};
    const netMs = rad
      .filter((r) => r.range_header === rk)
      .map((r) => Number(r.loadingFinished) - t0)
      .find(Number.isFinite);
    chunk_states.set(rk, {
      chunk_id: d.chunk_id,
      chunk_needed_time: d.chunk_needed_time,
      chunk_prefetch_start_time: br.chunk_prefetch_start_time ?? null,
      chunk_fetch_complete_time: br.chunk_fetch_complete_time ?? netMs ?? null,
      chunk_parse_complete_time: br.chunk_parse_complete_time ?? null,
      chunk_upload_complete_time: br.chunk_upload_complete_time ?? null,
      chunk_ready_time: null,
      bytes: br.bytes || d.encoded_bytes || 0,
      source: d.source,
    });
  }

  for (const [rk, ch] of chunk_states) {
    const br = browser.get(rk);
    const { t: ready, ev } = readyTimeForChunk({ ...ch, ...br }, readyEventPolicy, parseFallbackMs);
    let adjReady = ready;
    if (
      adjReady != null
      && ch.chunk_fetch_complete_time != null
      && adjReady < ch.chunk_fetch_complete_time
      && !(br?.chunk_prefetch_start_time != null && (br?.chunk_parse_complete_time != null))
    ) {
      // Only inflate when there's no real pre-parse evidence — preserves
      // ready-aware advantage for pre-parsed chunks.
      adjReady = ch.chunk_fetch_complete_time + parseFallbackMs * 0.5;
    }
    ch.chunk_ready_time = adjReady;
    ch.ready_event = ev;
    if (ev) readyEventCounts[ev] = (readyEventCounts[ev] || 0) + 1;
    if (ch.chunk_parse_complete_time == null && br?.chunk_parse_complete_time != null) {
      ch.chunk_parse_complete_time = br.chunk_parse_complete_time;
    }
  }

  const chunks = [...chunk_states.values()];
  const demandSet = new Set(demand_trace.map((d) => rangeKey(d.range_header)));
  let useful_before = 0;
  let miss50 = 0;
  let miss100 = 0;
  let wasted_bytes = 0;
  let total_received = 0;
  let useful_bytes = 0;
  let on_time_bytes = 0;

  for (const ch of chunks) {
    if (ch.bytes > 0) total_received += ch.bytes;
    const needed = ch.chunk_needed_time;
    const ready = ch.chunk_ready_time;
    const rk = rangeKey(ch.chunk_id);
    if (needed != null && ready != null && demandSet.has(rk)) {
      if (ready <= needed) {
        useful_before += 1;
        if (ch.bytes > 0) on_time_bytes += ch.bytes;
      }
      if (ready > needed + 50) miss50 += 1;
      if (ready > needed + 100) miss100 += 1;
      if (ch.bytes > 0) useful_bytes += ch.bytes;
    }
  }

  for (const [rk, br] of browser) {
    if (
      br.chunk_prefetch_start_time != null
      && !demandSet.has(rk)
      && (br.bytes > 0 || br.chunk_fetch_complete_time != null)
    ) {
      wasted_bytes += br.bytes || 0;
    }
  }

  const demanded = demand_trace.length;
  const totalPrefetch = (proactiveSnap.prefetch_trace || []).filter((e) => e.event === "fetch_complete").reduce((a, e) => a + (e.bytes || 0), 0);
  const wastedRatio = totalPrefetch > 0 ? wasted_bytes / totalPrefetch : 0;

  return {
    ...proactiveSnap,
    demand_trace,
    chunk_states: chunks,
    demanded_chunks: demanded,
    useful_chunks_before_demand: useful_before,
    deadline_miss_ratio_50ms: demanded ? miss50 / demanded : 0,
    deadline_miss_ratio_100ms: demanded ? miss100 / demanded : 0,
    wasted_prefetch_bytes: wasted_bytes,
    total_prefetch_bytes: totalPrefetch,
    wasted_prefetch_ratio: wastedRatio,
    total_received_bytes: total_received,
    useful_bytes_ratio: total_received > 0 ? on_time_bytes / total_received : 0,
    normalized_useful_content_score: demanded ? useful_before / demanded : 0,
    cdp_enriched: true,
    used_b0_reference_demand: refByRange.size > 0,
    ready_event_counts: readyEventCounts,
    ready_event_used: Object.keys(readyEventCounts).sort((a, b) => readyEventCounts[b] - readyEventCounts[a])[0] || null,
    metrics_version: 3,
  };
}

export function cdpRad206Count(cdpRows) {
  return cdpRows.filter(
    (r) => /\.rad(\?|#|$)/i.test(r.url || "") && Number(r.status) === 206 && r.range_header,
  ).length;
}
