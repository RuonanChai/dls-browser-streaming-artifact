/**
 * 与 viewport-shared-edge-proxy.mjs 对齐的 share_key / 可共享判定（用于 instrumented proxy.jsonl 基线统计）。
 */

/** @type {Set<string>} */
const SHAREABLE_EXT = new Set([
  "spz",
  "ply",
  "bin",
  "wasm",
  "glb",
  "gltf",
  "ktx2",
  "jpg",
  "jpeg",
  "png",
  "m4s",
  "mp4",
]);

/** @type {Set<string>} */
const STRIP_QUERY_KEYS = new Set([
  "user_id",
  "trace_id",
  "run_id",
  "session_id",
  "client_id",
  "ts",
  "t",
  "cachebuster",
  "cb",
  "nonce",
  "_",
]);

export function normalizeSearch(search) {
  const raw = String(search || "");
  const qs = raw.startsWith("?") ? raw.slice(1) : raw;
  const params = new URLSearchParams(qs);
  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (STRIP_QUERY_KEYS.has(k.toLowerCase())) continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const next = new URLSearchParams();
  for (const [k, v] of pairs) next.append(k, v);
  return next.toString();
}

export function buildShareKey(method, pathname, normalizedSearch, rawRangeHeaderOrNull) {
  const rng = rawRangeHeaderOrNull ? String(rawRangeHeaderOrNull).trim() : "(none)";
  const qs = normalizedSearch || "";
  return `${String(method || "GET").toUpperCase()}|${pathname || "/"}|${qs}|${rng}`;
}

export function extFromPath(pathname) {
  const seg = String(pathname || "").split("/").pop() || "";
  const dot = seg.lastIndexOf(".");
  return dot >= 0 ? seg.slice(dot + 1).split("?")[0].toLowerCase() : "";
}

export function isShareableRequest(method, pathname) {
  if (String(method || "").toUpperCase() !== "GET") return false;
  const ext = extFromPath(pathname);
  if (!SHAREABLE_EXT.has(ext)) return false;
  const lower = String(pathname || "").toLowerCase();
  if (lower.includes("/scripts/traces/")) return false;
  return true;
}

/**
 * @param {{ url?: string, pathname?: string, method?: string, raw_range?: string|null }} row instrumented request_complete
 */
export function shareKeyAndShareableFromInstrumentedRow(row) {
  const method = String(row.method || "GET");
  const rawUrl = String(row.url || "");
  let pathname = "/";
  let normSearch = "";
  try {
    const u = new URL(rawUrl, "http://placeholder.local");
    pathname = u.pathname || "/";
    normSearch = normalizeSearch(u.search || "");
  } catch {
    pathname = String(row.pathname || "/");
    normSearch = "";
  }
  const rawRange = row.raw_range != null && row.raw_range !== "" ? String(row.raw_range) : null;
  const shareKey = buildShareKey(method, pathname, normSearch, rawRange);
  const shareable = isShareableRequest(method, pathname);
  return { shareKey, shareable, pathname };
}
