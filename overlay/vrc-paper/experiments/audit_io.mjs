/**
 * Shared helpers for VRC latency audit CSV/JSONL output.
 */
import fs from "node:fs";
import path from "node:path";

const CHUNK_URL_RE = /\.(rad|spz|splat)(\?|#|$)/i;

export function isChunkAssetUrl(url) {
  return CHUNK_URL_RE.test(String(url ?? ""));
}

export function writeAuditCsv(rows, file) {
  if (!rows?.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    return;
  }
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null || v === "") return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export function latencyStats(values) {
  const xs = values.filter((x) => Number.isFinite(x) && x >= 0 && x < 600000).sort((a, b) => a - b);
  if (!xs.length) {
    return { p50: 0, p95: 0, count: 0 };
  }
  return {
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    count: xs.length,
  };
}
