/**
 * Local proxy that forwards each HTTP request to an upstream origin (e.g. HPC
 * ${EDGE_SERVER_HOST}:8090) and logs full server-side timings per request.
 *
 * Produces the same `server_monitor/server_request_log.jsonl` row schema as
 * MonitoredAssetServer so downstream summarizers (local_stutter_server_summary)
 * can align with `cdp_network_audit.csv` 1:1.
 *
 * Each row records:
 * - request_start (when local proxy receives client request)
 * - upstream_request_ms (time from receiving until upstream socket connect/send)
 * - upstream_response_ms (TTFB from upstream)
 * - first_chunk_sent_ms (first byte forwarded to client)
 * - stream_end_ms (last byte forwarded)
 * - status_code / content_range / bytes_sent / range_header
 */
import { createServer, request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { URL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const CHUNK_ASSET = /\.(rad|spz|splat)(\?|#|$)/i;

function isoNow() {
  return new Date().toISOString();
}

function msSince(t0) {
  return Math.round((performance.now() - t0) * 100) / 100;
}

function appendJsonl(file, obj) {
  return fs.appendFile(file, `${JSON.stringify(obj)}\n`, "utf8");
}

export class ProxyAssetServer {
  /**
   * @param {{ upstreamBase: string; port: number; runDir: string; runId: string; host?: string }} opts
   */
  constructor(opts) {
    this.upstream = new URL(opts.upstreamBase);
    this.port = opts.port;
    this.host = opts.host ?? "127.0.0.1";
    this.runId = opts.runId;
    this.monitorDir = path.join(opts.runDir, "server_monitor");
    this.requestLogPath = path.join(this.monitorDir, "server_request_log.jsonl");
    this.summaryCsvPath = path.join(this.monitorDir, "server_request_summary.csv");
    this.server = null;
    this.requestRows = [];
    this._writeChain = Promise.resolve();
    this._upstreamRequest = this.upstream.protocol === "https:" ? httpsRequest : httpRequest;
    this._upstreamAgent = this.upstream.protocol === "https:"
      ? new HttpsAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, timeout: 120_000 })
      : new HttpAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, timeout: 120_000 });
  }

  async start() {
    await fs.mkdir(this.monitorDir, { recursive: true });
    await fs.writeFile(this.requestLogPath, "", "utf8");
    await fs.writeFile(
      path.join(this.monitorDir, "proxy_meta.json"),
      JSON.stringify(
        {
          mode: "proxy_to_upstream",
          upstream: this.upstream.toString(),
          run_id: this.runId,
          started_at: isoNow(),
        },
        null,
        2,
      ),
      "utf8",
    );

    this.server = createServer((req, res) => {
      this._handle(req, res).catch((e) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
        }
        try {
          res.end(`proxy_error: ${String(e?.message || e)}`);
        } catch { /* ignore */ }
      });
    });

    this.server.keepAliveTimeout = 120_000;
    this.server.headersTimeout = 130_000;

    let lastErr = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          const onErr = (e) => {
            this.server.removeListener("error", onErr);
            reject(e);
          };
          this.server.once("error", onErr);
          this.server.listen(this.port, this.host, () => {
            this.server.removeListener("error", onErr);
            resolve();
          });
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (e?.code === "EADDRINUSE") {
          this.port += 7; // step away from random collision range
          continue;
        }
        throw e;
      }
    }
    if (lastErr) throw lastErr;

    return {
      port: this.port,
      host: this.host,
      base: `http://${this.host}:${this.port}`,
      pid: process.pid,
      requestLogPath: this.requestLogPath,
      upstream: this.upstream.toString(),
    };
  }

  async _handle(clientReq, clientRes) {
    const tRequest = performance.now();
    const tsStart = isoNow();
    const targetUrl = new URL(clientReq.url || "/", this.upstream);
    targetUrl.host = this.upstream.host;
    targetUrl.protocol = this.upstream.protocol;
    if (this.upstream.pathname && this.upstream.pathname !== "/") {
      // Prepend upstream path prefix if any (rare for HPC).
      targetUrl.pathname = path.posix.join(this.upstream.pathname, targetUrl.pathname).replace(/\\/g, "/");
    }

    const pathname = targetUrl.pathname;
    const row = {
      run_id: this.runId,
      ts_start_iso: tsStart,
      ts_end_iso: null,
      mode: "proxy_to_upstream",
      method: clientReq.method || "GET",
      url: clientReq.url || "",
      upstream_url: targetUrl.toString(),
      pathname,
      is_rad: CHUNK_ASSET.test(pathname),
      range_header: clientReq.headers.range || clientReq.headers["Range"] || "",
      range_start: null,
      range_end: null,
      requested_bytes: null,
      status_code: null,
      content_range: null,
      bytes_sent: 0,
      client_ip: clientReq.socket?.remoteAddress || "",
      user_agent: clientReq.headers["user-agent"] || "",
      request_start_ms: 0,
      headers_written_ms: null,
      first_chunk_read_ms: null,
      first_chunk_sent_ms: null,
      stream_end_ms: null,
      server_total_ms: null,
      server_ttfb_ms: null,
      upstream_connect_ms: null,
      upstream_socket_close_ms: null,
      upstream_response_ms: null,
      upstream_status: null,
      error_message: "",
    };
    if (row.range_header) {
      const m = String(row.range_header).match(/bytes=(\d+)-(\d+)?/);
      if (m) {
        row.range_start = Number(m[1]);
        row.range_end = m[2] ? Number(m[2]) : null;
        if (row.range_end != null) row.requested_bytes = row.range_end - row.range_start + 1;
      }
    }

    if (clientReq.method === "OPTIONS") {
      clientRes.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Origin, Range, Content-Type, Accept",
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      });
      clientRes.end();
      row.status_code = 204;
      row.server_total_ms = msSince(tRequest);
      row.ts_end_iso = isoNow();
      await this._finalize(row);
      return;
    }

    const upstreamHeaders = { ...clientReq.headers };
    delete upstreamHeaders["host"];
    delete upstreamHeaders["connection"];
    upstreamHeaders["host"] = this.upstream.host;

    const tUpstreamSend = performance.now();
    const upstreamReq = this._upstreamRequest(
      {
        agent: this._upstreamAgent,
        method: clientReq.method,
        protocol: this.upstream.protocol,
        hostname: this.upstream.hostname,
        port: this.upstream.port || (this.upstream.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        headers: upstreamHeaders,
        timeout: 120_000,
      },
      (upstreamRes) => {
        const tUpstreamResp = performance.now();
        row.upstream_response_ms = Math.round((tUpstreamResp - tUpstreamSend) * 100) / 100;
        row.upstream_status = upstreamRes.statusCode;
        row.status_code = upstreamRes.statusCode;
        row.content_range = upstreamRes.headers["content-range"] || null;
        const respHeaders = { ...upstreamRes.headers };
        // ensure CORS for browser
        respHeaders["access-control-allow-origin"] = respHeaders["access-control-allow-origin"] || "*";
        respHeaders["access-control-expose-headers"] = respHeaders["access-control-expose-headers"] || "Content-Range, Accept-Ranges, Content-Length";

        clientRes.writeHead(upstreamRes.statusCode || 502, respHeaders);
        row.headers_written_ms = msSince(tRequest);
        row.server_ttfb_ms = msSince(tRequest);

        let firstRead = true;
        let bytesSent = 0;
        upstreamRes.on("data", (chunk) => {
          if (firstRead) {
            row.first_chunk_read_ms = msSince(tRequest);
            row.first_chunk_sent_ms = row.first_chunk_read_ms;
            firstRead = false;
          }
          bytesSent += chunk.length;
        });
        upstreamRes.on("end", () => {
          row.stream_end_ms = msSince(tRequest);
        });
        upstreamRes.on("error", (e) => {
          row.error_message = `upstream_stream_error: ${e?.message || e}`;
        });

        clientRes.on("close", async () => {
          if (row.ts_end_iso == null) {
            row.bytes_sent = bytesSent;
            row.server_total_ms = msSince(tRequest);
            row.ts_end_iso = isoNow();
            await this._finalize(row);
          }
        });
        clientRes.on("finish", async () => {
          row.bytes_sent = bytesSent;
          row.server_total_ms = msSince(tRequest);
          row.ts_end_iso = isoNow();
          await this._finalize(row);
        });

        upstreamRes.pipe(clientRes);
      },
    );

    upstreamReq.on("socket", (socket) => {
      // Keep-alive reuses sockets; the connect/close events already fired
      // before this listener. Only record connect for fresh sockets to avoid
      // MaxListeners leak across reused sockets.
      if (socket.connecting && socket.listenerCount("connect") < 8) {
        socket.once("connect", () => {
          row.upstream_connect_ms = msSince(tRequest);
        });
      }
    });
    upstreamReq.on("error", async (err) => {
      row.error_message = `upstream_req_error: ${err?.message || err}`;
      if (!clientRes.headersSent) {
        try {
          clientRes.writeHead(502, { "Content-Type": "text/plain" });
        } catch { /* */ }
      }
      try {
        clientRes.end(row.error_message);
      } catch { /* */ }
      row.status_code = row.status_code ?? 502;
      row.server_total_ms = msSince(tRequest);
      row.ts_end_iso = isoNow();
      await this._finalize(row);
    });
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("upstream_timeout"));
    });

    clientReq.on("aborted", () => {
      try {
        upstreamReq.destroy(new Error("client_aborted"));
      } catch { /* */ }
    });
    clientReq.pipe(upstreamReq);
  }

  async _finalize(row) {
    row.request_start_ms = 0;
    this.requestRows.push(row);
    this._writeChain = this._writeChain.then(() => appendJsonl(this.requestLogPath, row));
    await this._writeChain;
  }

  async stop() {
    await this._writeChain;
    try {
      this._upstreamAgent?.destroy?.();
    } catch { /* */ }
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      // closeAllConnections so listen() can reuse port immediately
      try { this.server.closeAllConnections?.(); } catch { /* */ }
      this.server.close(() => resolve());
    });
    return this.requestRows;
  }

  getAssetRows() {
    return this.requestRows.filter((r) => r.is_rad && r.status_code && r.status_code < 400);
  }
}

export async function probeProxyServer(base, samplePath, maxWaitMs = 30_000) {
  const probeUrl = `${base}${samplePath.startsWith("/") ? "" : "/"}${samplePath}`;
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < maxWaitMs) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(probeUrl, {
        method: "GET",
        headers: { Range: "bytes=0-1023" },
        signal: ac.signal,
      });
      clearTimeout(t);
      if (r.status === 206 || r.status === 200) {
        return { ok: true, status: r.status };
      }
      lastErr = `status_${r.status}`;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return { ok: false, error: lastErr || "probe_timeout" };
}
