/**
 * Phase 1: CDP Network audit — authoritative chunk HTTP timing (not Chrome Trace).
 */
import { isChunkAssetUrl, latencyStats } from "./audit_io.mjs";

function headerVal(headers, name) {
  if (!headers) return "";
  const n = String(name).toLowerCase();
  if (Array.isArray(headers)) {
    const h = headers.find((x) => String(x.name ?? "").toLowerCase() === n);
    return h?.value ?? "";
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === n) return String(v);
    }
  }
  return "";
}

function tsMs(ts) {
  if (ts == null) return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

export class CdpNetworkAuditor {
  /**
   * @param {import('playwright').CDPSession} cdp
   * @param {{ userId: string, sessionId: string, method: string, scenario: string, trial: number }} meta
   */
  constructor(cdp, meta) {
    this.cdp = cdp;
    this.meta = meta;
    /** @type {Map<string, object>} */
    this.byRequestId = new Map();
    /** @type {object[]} */
    this.rows = [];
    this._handlers = [];
    this.enabled = false;
  }

  async start() {
    await this.cdp.send("Network.enable", {
      maxResourceBufferSize: 0,
      maxPostDataSize: 0,
    });
    const on = (event, fn) => {
      const h = (params) => fn(params);
      this.cdp.on(event, h);
      this._handlers.push([event, h]);
    };

    on("Network.requestWillBeSent", (p) => {
      const url = p.request?.url ?? "";
      if (!isChunkAssetUrl(url)) return;
      const rid = p.requestId;
      const sent = tsMs(p.timestamp) ?? Date.now();
      this.byRequestId.set(rid, {
        user: this.meta.userId,
        session_id: this.meta.sessionId,
        method: this.meta.method,
        scenario: this.meta.scenario,
        trial: this.meta.trial,
        requestId: rid,
        url,
        range_header: headerVal(p.request?.headers, "Range") || headerVal(p.request?.headers, "range"),
        status: "",
        protocol: p.type ?? "",
        requestWillBeSent: sent,
        responseReceived: null,
        loadingFinished: null,
        loadingFailed: "",
        encodedDataLength: 0,
        fromDiskCache: false,
        fromPrefetchCache: false,
        ttfb_ms: null,
        download_ms: null,
        network_total_ms: null,
        completed: false,
        playwright_service_time_ms: null,
      });
    });

    on("Network.responseReceived", (p) => {
      const row = this.byRequestId.get(p.requestId);
      if (!row) return;
      const recv = tsMs(p.timestamp) ?? Date.now();
      row.responseReceived = recv;
      row.status = p.response?.status ?? "";
      row.protocol = p.response?.protocol ?? row.protocol;
      row.fromDiskCache = !!p.response?.fromDiskCache;
      row.fromPrefetchCache = !!p.response?.fromPrefetchCache;
      if (row.requestWillBeSent != null) {
        row.ttfb_ms = Math.max(0, recv - row.requestWillBeSent);
      }
    });

    on("Network.loadingFinished", (p) => {
      const row = this.byRequestId.get(p.requestId);
      if (!row) return;
      const fin = tsMs(p.timestamp) ?? Date.now();
      row.loadingFinished = fin;
      row.encodedDataLength = Number(p.encodedDataLength ?? 0);
      row.completed = true;
      if (row.requestWillBeSent != null) {
        row.network_total_ms = Math.max(0, fin - row.requestWillBeSent);
      }
      if (row.responseReceived != null && row.loadingFinished != null) {
        row.download_ms = Math.max(0, row.loadingFinished - row.responseReceived);
      }
      this.finalizeRow(p.requestId);
    });

    on("Network.loadingFailed", (p) => {
      const row = this.byRequestId.get(p.requestId);
      if (!row) return;
      row.loadingFailed = String(p.errorText ?? p.blockedReason ?? "loadingFailed");
      row.completed = false;
      this.finalizeRow(p.requestId);
    });

    this.enabled = true;
  }

  finalizeRow(requestId) {
    const row = this.byRequestId.get(requestId);
    if (!row || row._finalized) return;
    row._finalized = true;
    this.rows.push({ ...row });
  }

  /** Match Playwright page.on('response') service_time for discrepancy analysis. */
  notePlaywrightResponse(url, userId, serviceTimeMs, status) {
    if (!isChunkAssetUrl(url)) return;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (r.url === url && r.user === userId && r.playwright_service_time_ms == null) {
        r.playwright_service_time_ms = serviceTimeMs;
        r.playwright_status = status;
        break;
      }
    }
  }

  flushOpen() {
    for (const rid of [...this.byRequestId.keys()]) {
      const row = this.byRequestId.get(rid);
      if (row && !row._finalized) this.finalizeRow(rid);
    }
  }

  async stop() {
    this.flushOpen();
    for (const [event, h] of this._handlers) {
      try { this.cdp.off(event, h); } catch { /* */ }
    }
    this._handlers = [];
    this.enabled = false;
  }

  getCsvRows() {
    return this.rows.map((r) => ({
      user: r.user,
      requestId: r.requestId,
      url: r.url,
      range_header: r.range_header,
      status: r.status,
      protocol: r.protocol,
      requestWillBeSent: r.requestWillBeSent,
      responseReceived: r.responseReceived,
      loadingFinished: r.loadingFinished,
      loadingFailed: r.loadingFailed,
      encodedDataLength: r.encodedDataLength,
      fromDiskCache: r.fromDiskCache,
      fromPrefetchCache: r.fromPrefetchCache,
      ttfb_ms: r.ttfb_ms,
      download_ms: r.download_ms,
      network_total_ms: r.network_total_ms,
      completed: r.completed,
      playwright_service_time_ms: r.playwright_service_time_ms ?? "",
      playwright_status: r.playwright_status ?? "",
      service_time_delta_ms: (r.network_total_ms != null && r.playwright_service_time_ms != null)
        ? r.playwright_service_time_ms - r.network_total_ms
        : "",
    }));
  }
}

/** Per-user summary from CDP network audit rows. */
export function summarizeCdpNetworkAudit(rows, userId) {
  const urows = rows.filter((r) => r.user === userId && r.completed);
  const ttfb = urows.map((r) => Number(r.ttfb_ms)).filter(Number.isFinite);
  const dl = urows.map((r) => Number(r.download_ms)).filter(Number.isFinite);
  const tot = urows.map((r) => Number(r.network_total_ms)).filter(Number.isFinite);
  const bytes = urows.reduce((s, r) => s + Number(r.encodedDataLength ?? 0), 0);
  const failed = rows.filter((r) => r.user === userId && r.loadingFailed).length;
  const status206 = urows.filter((r) => String(r.status) === "206").length;
  const zeroBytesCompleted = urows.filter((r) => Number(r.encodedDataLength ?? 0) === 0).length;
  const ttfbS = latencyStats(ttfb);
  const dlS = latencyStats(dl);
  const totS = latencyStats(tot);
  return {
    net_completed_request_count: urows.length,
    net_ttfb_p50_ms: ttfbS.p50,
    net_ttfb_p95_ms: ttfbS.p95,
    net_download_p50_ms: dlS.p50,
    net_download_p95_ms: dlS.p95,
    net_total_p50_ms: totS.p50,
    net_total_p95_ms: totS.p95,
    net_bytes: bytes,
    net_loading_failed_count: failed,
    net_status_206_count: status206,
    net_zero_encoded_length_count: zeroBytesCompleted,
    cdp_network_audit_row_count: rows.filter((r) => r.user === userId).length,
  };
}

export async function attachCdpNetworkAuditor(page, meta) {
  const cdp = await page.context().newCDPSession(page);
  const auditor = new CdpNetworkAuditor(cdp, meta);
  await auditor.start();
  return auditor;
}
