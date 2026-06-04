/**
 * shared-proxy.jsonl 约定（viewport-shared-edge-proxy 或等价实现应写入 proxy/shared-proxy.jsonl）。
 *
 * 单行 JSON，常见 event：
 * - shareable_client_request: { event, share_key, client_id, raw_url?, raw_range?, asset_ext?, ts_ms? }
 * - upstream_share_fetch_complete: { event, share_key, upstream_bytes?, waiter_count?, coalesced?, cache_hit_edge? }
 * - viewport_lockstep_overlap: { event, scenario?, pairwise_overlap_avg?, pairwise_overlap_min? }
 * - sharing_gain_estimate: { event, no_sharing_estimated_upstream_bytes?, actual_upstream_bytes_with_proxy?, sharing_gain_ratio? }
 */

/** 不计入 viewport 静态 3D 增益的文件扩展名（若出现在 shareable 事件中视为校验错误） */
export const NON_VIEWPORT_GAIN_EXT = new Set([
  "html",
  "htm",
  "js",
  "mjs",
  "cjs",
  "css",
  "json",
  "map",
  "ts",
  "tsx",
  "jsx",
]);

/** URL 中若仍携带下列查询键（规范化后仍存在于 raw_url），给出 cachebuster / 用户隔离告警 */
export const USER_OR_EPHEMERAL_QUERY_KEYS = [
  "user_id",
  "trace_id",
  "run_id",
  "session_id",
  "client_id",
  "ts",
  "t",
  "cachebuster",
  "cb",
  "_",
  "nonce",
];

export function extFromPathname(pathname) {
  const base = String(pathname || "").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase().split("?")[0] : "";
}

export function rawUrlHasEphemeralQuery(rawUrl) {
  const s = String(rawUrl || "");
  if (!s.includes("?")) return false;
  const q = s.includes("?") ? s.slice(s.indexOf("?")) : "";
  const lower = q.toLowerCase();
  return USER_OR_EPHEMERAL_QUERY_KEYS.some((k) => new RegExp(`[?&]${k}=`, "i").test(lower));
}

/** pathname 是否为 trace JSON（不应算作 viewport 资产增益） */
export function isTraceJsonPath(pathname) {
  const p = String(pathname || "").replace(/\\/g, "/").toLowerCase();
  return (
    p.includes("/scripts/traces/") ||
    p.endsWith(".json") && (p.includes("/trace") || p.includes("/traces/"))
  );
}
