/**
 * Reliable Chrome Trace collector for single-user local stutter diagnosis.
 * Waits for Tracing.tracingComplete + IO.read stream (fixes sync Tracing.end → no_stream).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseChromeTraceSummary } from "./local_stutter_trace_parser.mjs";

export const TRACE_CATEGORIES = [
  "devtools.timeline",
  "blink",
  "cc",
  "gpu",
  "loading",
  "netlog",
  "v8",
  "toplevel",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-gpu.service",
  "disabled-by-default-gpu.device",
  "disabled-by-default-cc.debug",
].join(",");

const MIN_TRACE_BYTES = 100 * 1024;

export class LocalStutterTraceCollector {
  /**
   * @param {import('playwright').CDPSession} cdp — dedicated trace session (not shared with Network.enable)
   * @param {{ userId: string, runDir: string, headless: boolean, chromeExecutable?: string }} opts
   */
  constructor(cdp, opts) {
    this.cdp = cdp;
    this.userId = opts.userId || "u0";
    this.runDir = opts.runDir;
    this.headless = !!opts.headless;
    this.chromeExecutable = opts.chromeExecutable ?? "";
    this.traceDir = path.join(opts.runDir, "trace", this.userId);
    this.tracePath = path.join(this.traceDir, "chrome_trace.json");
    this.metaPath = path.join(this.traceDir, "trace_meta.json");
    this.summaryPath = path.join(this.traceDir, "trace_summary.json");
    this.meta = {
      trace_enabled: false,
      tracing_start_ts: null,
      tracing_end_ts: null,
      tracing_complete_received: false,
      stream_read_bytes: 0,
      trace_file_path: this.tracePath,
      trace_file_size: 0,
      categories: TRACE_CATEGORIES,
      chrome_headless: this.headless,
      chrome_executable: this.chromeExecutable,
      gpu_status: null,
      parser_ok: false,
      parser_error: "",
    };
    this._tracingCompleteHandler = null;
    this._tracingCompletePromise = null;
    this._started = false;
  }

  async start() {
    await fs.mkdir(this.traceDir, { recursive: true });
    this._tracingCompletePromise = new Promise((resolve) => {
      this._tracingCompleteHandler = (params) => {
        this.meta.tracing_complete_received = true;
        resolve(params);
      };
      this.cdp.on("Tracing.tracingComplete", this._tracingCompleteHandler);
    });
    await this.cdp.send("Tracing.start", {
      categories: TRACE_CATEGORIES,
      options: "record-as-much-as-possible",
      transferMode: "ReturnAsStream",
    });
    this.meta.trace_enabled = true;
    this.meta.tracing_start_ts = Date.now();
    this._started = true;
  }

  /**
   * @param {{ flushMs?: number }} opts
   */
  async stop(opts = {}) {
    const flushMs = opts.flushMs ?? 3000;
    if (!this._started) {
      return this._fail("TRACE_NOT_STARTED");
    }
    this.meta.tracing_end_ts = Date.now();

    let completeParams = null;
    try {
      await new Promise((r) => setTimeout(r, flushMs));
      const [params] = await Promise.race([
        Promise.all([
          this._tracingCompletePromise,
          this.cdp.send("Tracing.end"),
        ]),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("TRACE_NO_TRACING_COMPLETE")), 120_000),
        ),
      ]);
      completeParams = params;
    } catch (e) {
      return this._fail(String(e?.message || e));
    } finally {
      if (this._tracingCompleteHandler) {
        try {
          this.cdp.off("Tracing.tracingComplete", this._tracingCompleteHandler);
        } catch { /* */ }
      }
    }

    const handle = completeParams?.stream;
    if (!handle) {
      return this._fail("TRACE_NO_TRACING_COMPLETE");
    }

    let body = "";
    try {
      let eof = false;
      while (!eof) {
        const chunk = await this.cdp.send("IO.read", { handle, size: 1_000_000 });
        if (chunk?.data) body += chunk.data;
        eof = !!chunk?.eof;
      }
      try {
        await this.cdp.send("IO.close", { handle });
      } catch { /* */ }
    } catch (e) {
      return this._fail(`TRACE_STREAM_READ_FAILED:${e?.message || e}`);
    }

    this.meta.stream_read_bytes = Buffer.byteLength(body, "utf8");
    await fs.writeFile(this.tracePath, body, "utf8");
    this.meta.trace_file_size = this.meta.stream_read_bytes;

    if (this.meta.trace_file_size < MIN_TRACE_BYTES) {
      return this._fail("TRACE_FILE_TOO_SMALL");
    }

    let summary;
    try {
      summary = parseChromeTraceSummary(this.tracePath);
      this.meta.parser_ok = !!summary.trace_ok;
      this.meta.parser_error = summary.parser_error || "";
      await fs.writeFile(this.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    } catch (e) {
      this.meta.parser_ok = false;
      this.meta.parser_error = String(e?.message || e);
      summary = {
        trace_ok: false,
        parser_error: this.meta.parser_error,
        trace_file_size: this.meta.trace_file_size,
      };
    }

    await fs.writeFile(this.metaPath, `${JSON.stringify(this.meta, null, 2)}\n`, "utf8");

    if (!summary.trace_ok) {
      return {
        ...summary,
        trace_path: this.tracePath,
        trace_meta: this.meta,
        trace_error: summary.parser_error || "TRACE_PARSER_FAILED",
      };
    }

    return {
      ...summary,
      trace_path: this.tracePath,
      trace_meta: this.meta,
      trace_error: "",
    };
  }

  async _fail(reason) {
    this.meta.parser_ok = false;
    this.meta.parser_error = reason;
    try {
      await fs.writeFile(this.metaPath, `${JSON.stringify(this.meta, null, 2)}\n`, "utf8");
    } catch { /* */ }
    return {
      trace_ok: false,
      trace_error: reason,
      trace_path: existsSync(this.tracePath) ? this.tracePath : "",
      trace_meta: this.meta,
      trace_main_script_ms: 0,
      trace_longtask_count: 0,
      trace_layout_paint_ms: 0,
      trace_raster_ms: 0,
      trace_composite_ms: 0,
      trace_gpu_ms: 0,
    };
  }
}

export async function attachLocalStutterTraceCollector(page, opts) {
  const cdp = await page.context().newCDPSession(page);
  const rec = new LocalStutterTraceCollector(cdp, opts);
  await rec.start();
  return rec;
}
