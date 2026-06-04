/**
 * Instrumented localhost asset server: Range via fs.createReadStream + per-request JSONL.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
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

function parseRangeHeader(rangeHeader, fileSize) {
  const t0 = performance.now();
  if (!rangeHeader || !String(rangeHeader).startsWith("bytes=")) {
    return { start: 0, end: fileSize - 1, parse_ms: msSince(t0), valid: false };
  }
  const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
  if (!m) return { start: 0, end: fileSize - 1, parse_ms: msSince(t0), valid: false };
  let start = m[1] === "" ? Math.max(0, fileSize - 1) : Number.parseInt(m[1], 10);
  let end = m[2] === "" ? fileSize - 1 : Number.parseInt(m[2], 10);
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end) || end >= fileSize) end = fileSize - 1;
  if (start > end) [start, end] = [end, start];
  return { start, end, parse_ms: msSince(t0), valid: true };
}

function appendJsonl(file, obj) {
  return fs.appendFile(file, `${JSON.stringify(obj)}\n`, "utf8");
}

export class MonitoredAssetServer {
  /**
   * @param {{ rootDir: string; port: number; runDir: string; runId: string; host?: string }} opts
   */
  constructor(opts) {
    this.rootDir = path.resolve(opts.rootDir);
    this.port = opts.port;
    this.host = opts.host ?? "127.0.0.1";
    this.runId = opts.runId;
    this.monitorDir = path.join(opts.runDir, "server_monitor");
    this.requestLogPath = path.join(this.monitorDir, "server_request_log.jsonl");
    this.summaryCsvPath = path.join(this.monitorDir, "server_request_summary.csv");
    this.server = null;
    this.requestRows = [];
    this._writeChain = Promise.resolve();
  }

  async start() {
    await fs.mkdir(this.monitorDir, { recursive: true });
    await fs.writeFile(this.requestLogPath, "", "utf8");

    this.server = createServer((req, res) => {
      this._handle(req, res).catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        res.end(String(e?.message || e));
      });
    });

    const listenPort = this.port > 0 ? this.port : 0;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(listenPort, this.host, () => resolve());
    });
    const addr = this.server.address();
    const actualPort = typeof addr === "object" && addr?.port ? addr.port : listenPort;
    this.port = actualPort;

    return {
      port: actualPort,
      host: this.host,
      base: `http://${this.host}:${actualPort}`,
      pid: process.pid,
      requestLogPath: this.requestLogPath,
    };
  }

  async _handle(req, res) {
    const tRequest = performance.now();
    const tsStart = isoNow();
    const u = new URL(req.url || "/", `http://${this.host}`);
    let pathname = decodeURIComponent(u.pathname);
    if (pathname.includes("..")) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    const diskPath = path.join(this.rootDir, pathname.replace(/^\//, "").replace(/\//g, path.sep));
    const row = {
      run_id: this.runId,
      ts_start_iso: tsStart,
      ts_end_iso: null,
      method: req.method || "GET",
      url: req.url || "",
      pathname,
      file_path: diskPath,
      is_rad: CHUNK_ASSET.test(pathname),
      range_header: req.headers.range || req.headers["Range"] || "",
      range_start: null,
      range_end: null,
      requested_bytes: null,
      status_code: null,
      content_range: null,
      bytes_sent: 0,
      client_ip: req.socket?.remoteAddress || "",
      user_agent: req.headers["user-agent"] || "",
      request_start_ms: 0,
      headers_written_ms: null,
      first_chunk_read_ms: null,
      first_chunk_sent_ms: null,
      stream_end_ms: null,
      server_total_ms: null,
      server_ttfb_ms: null,
      file_open_ms: null,
      range_parse_ms: null,
      stream_read_ms: null,
      stream_pipe_ms: null,
      stream_error: "",
      error_message: "",
    };

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Origin, Range, Content-Type, Accept",
      "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" });
      res.end();
      row.status_code = 204;
      row.server_total_ms = msSince(tRequest);
      row.ts_end_iso = isoNow();
      await this._finalize(row);
      return;
    }

    if (!existsSync(diskPath) || !statSync(diskPath).isFile()) {
      res.writeHead(404, cors);
      res.end("not found");
      row.status_code = 404;
      row.error_message = "file_not_found";
      row.server_total_ms = msSince(tRequest);
      row.ts_end_iso = isoNow();
      await this._finalize(row);
      return;
    }

    const tStat = performance.now();
    const st = statSync(diskPath);
    row.file_open_ms = Math.round((performance.now() - tStat) * 100) / 100;
    const fileSize = st.size;
    const rangeHdr = row.range_header;
    const parsed = parseRangeHeader(rangeHdr, fileSize);
    row.range_parse_ms = parsed.parse_ms;

    const hasRange = parsed.valid && rangeHdr;
    let start = 0;
    let end = fileSize - 1;
    if (hasRange) {
      start = parsed.start;
      end = parsed.end;
    }
    row.range_start = start;
    row.range_end = end;
    row.requested_bytes = end - start + 1;

    const contentType = pathname.endsWith(".rad")
      ? "application/octet-stream"
      : "application/octet-stream";

    const tHeaders = performance.now();
    if (hasRange) {
      const contentRange = `bytes ${start}-${end}/${fileSize}`;
      row.content_range = contentRange;
      res.writeHead(206, {
        ...cors,
        "Content-Type": contentType,
        "Content-Length": String(end - start + 1),
        "Content-Range": contentRange,
        "Accept-Ranges": "bytes",
      });
      row.status_code = 206;
    } else {
      res.writeHead(200, {
        ...cors,
        "Content-Type": contentType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
      });
      row.status_code = 200;
    }
    row.headers_written_ms = Math.round((performance.now() - tHeaders) * 100) / 100;
    row.server_ttfb_ms = Math.round((performance.now() - tRequest) * 100) / 100;

    if (req.method === "HEAD") {
      res.end();
      row.server_total_ms = msSince(tRequest);
      row.ts_end_iso = isoNow();
      await this._finalize(row);
      return;
    }

    const tStreamOpen = performance.now();
    const stream = createReadStream(diskPath, { start, end });
    row.stream_open_ms = Math.round((performance.now() - tStreamOpen) * 100) / 100;

    let firstRead = true;
    let tFirstRead = null;
    let tFirstSent = null;
    let bytesSent = 0;

    stream.on("data", (chunk) => {
      if (firstRead) {
        tFirstRead = performance.now();
        row.first_chunk_read_ms = Math.round((tFirstRead - tRequest) * 100) / 100;
        firstRead = false;
      }
      bytesSent += chunk.length;
    });

    stream.on("error", (err) => {
      row.stream_error = String(err?.message || err);
      if (!res.writableEnded) res.destroy(err);
    });

    stream.on("end", () => {
      row.stream_end_ms = msSince(tRequest);
      row.stream_read_ms = row.stream_end_ms;
    });

    res.on("pipe", () => {
      if (tFirstSent == null) {
        tFirstSent = performance.now();
        row.first_chunk_sent_ms = Math.round((tFirstSent - tRequest) * 100) / 100;
      }
    });

    const tPipe = performance.now();
    stream.pipe(res);
    row.stream_pipe_ms = Math.round((performance.now() - tPipe) * 100) / 100;

    res.on("finish", async () => {
      row.bytes_sent = bytesSent;
      row.server_total_ms = msSince(tRequest);
      row.ts_end_iso = isoNow();
      await this._finalize(row);
    });

    res.on("error", async (err) => {
      row.stream_error = row.stream_error || String(err?.message || err);
      row.error_message = String(err?.message || err);
      row.server_total_ms = msSince(tRequest);
      row.ts_end_iso = isoNow();
      await this._finalize(row);
    });
  }

  async _finalize(row) {
    row.request_start_ms = 0;
    this.requestRows.push(row);
    this._writeChain = this._writeChain.then(() => appendJsonl(this.requestLogPath, row));
    await this._writeChain;
  }

  async stop() {
    await this._writeChain;
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    return this.requestRows;
  }

  getAssetRows() {
    return this.requestRows.filter((r) => r.is_rad && r.status_code && r.status_code < 400);
  }
}

export async function probeMonitoredServer(base, maxWaitMs = 90_000) {
  const probeUrl = `${base}/examples/streaming-lod/coit-40m-sh1-lod.rad`;
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < maxWaitMs) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(probeUrl, {
        method: "GET",
        headers: { Range: "bytes=0-64" },
        signal: ac.signal,
      });
      clearTimeout(t);
      if (r.status === 206 || r.status === 200) return;
      lastErr = new Error(`status=${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`monitored asset server probe failed: ${lastErr?.message ?? lastErr}`);
}
