/**
 * Fast Range responses for large .rad assets (dev server + experiments).
 * Vite's default static handler is very slow on multi-MB Range reads on Windows.
 */
import { createReadStream, existsSync, openSync, readSync, closeSync, statSync } from "node:fs";

export function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader || !String(rangeHeader).startsWith("bytes=")) {
    return { start: 0, end: fileSize - 1, valid: false };
  }
  const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
  if (!m) return { start: 0, end: fileSize - 1, valid: false };
  let start = m[1] === "" ? Math.max(0, fileSize - 1) : Number.parseInt(m[1], 10);
  let end = m[2] === "" ? fileSize - 1 : Number.parseInt(m[2], 10);
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end) || end >= fileSize) end = fileSize - 1;
  if (start > end) [start, end] = [end, start];
  return { start, end, valid: true };
}

const defaultCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Origin, Range, Content-Type, Accept",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
};

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} diskPath
 * @param {{ cors?: Record<string, string> }} [opts]
 * @returns {boolean} true if handled
 */
export function serveFileWithRange(req, res, diskPath, opts = {}) {
  const cors = { ...defaultCors, ...opts.cors };

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...cors,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    });
    res.end();
    return true;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  if (!existsSync(diskPath) || !statSync(diskPath).isFile()) {
    res.writeHead(404, cors);
    res.end("not found");
    return true;
  }

  const fileSize = statSync(diskPath).size;
  const rangeHdr = req.headers.range || req.headers["Range"] || "";
  const parsed = parseRangeHeader(rangeHdr, fileSize);
  const hasRange = parsed.valid && rangeHdr;
  let start = 0;
  let end = fileSize - 1;
  if (hasRange) {
    start = parsed.start;
    end = parsed.end;
  }

  const contentType = "application/octet-stream";
  if (hasRange) {
    const contentRange = `bytes ${start}-${end}/${fileSize}`;
    res.writeHead(206, {
      ...cors,
      "Content-Type": contentType,
      "Content-Length": String(end - start + 1),
      "Content-Range": contentRange,
      "Accept-Ranges": "bytes",
    });
  } else {
    res.writeHead(200, {
      ...cors,
      "Content-Type": contentType,
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
    });
  }

  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  const len = end - start + 1;
  if (opts.bufferRead && len <= (opts.bufferReadMaxBytes ?? 8 * 1024 * 1024)) {
    const fd = openSync(diskPath, "r");
    try {
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      res.end(buf);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  createReadStream(diskPath, { start, end }).pipe(res);
  return true;
}
