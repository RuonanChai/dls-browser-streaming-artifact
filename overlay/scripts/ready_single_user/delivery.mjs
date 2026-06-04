import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EDGE_URL, DEFAULT_REMOTE_COS_URL, DEFAULT_REMOTE_CDN_URL } from "./constants.mjs";
import { normalizeDeliveryKey } from "./delivery_metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function loadMatrix() {
  const p = path.join(root, "config", "ready_single_user", "experiment_matrix.json");
  return JSON.parse(await fs.readFile(p, "utf8"));
}

export { normalizeDeliveryKey };

function resolveUrl(matrixEntry, envName, fallback) {
  const fromEnv = envName ? String(process.env[envName] ?? "").trim() : "";
  return fromEnv || matrixEntry?.asset_url || fallback;
}

export async function resolveDelivery(deliveryKey, matrix) {
  const norm = normalizeDeliveryKey(deliveryKey);
  const storageKey = norm.storage_key;
  const d = matrix.deliveries?.[storageKey] ?? matrix.deliveries?.[deliveryKey];

  if (storageKey === "local_disk") {
    return {
      delivery_key: "local_disk",
      delivery_role: "local",
      profile_id: "local_disk",
      display_name: "local ceiling",
      asset_url: null,
      asset_base: null,
      useLocalMonitoredServer: true,
      curl_check_url: null,
      no_fallback: false,
    };
  }

  if (storageKey === "edge_server") {
    const asset_url = resolveUrl(d, "EDGE_ASSET_URL", DEFAULT_EDGE_URL);
    return {
      delivery_key: "edge_server",
      delivery_role: "edge",
      profile_id: "edge_server",
      display_name: "LAN edge server",
      asset_url,
      asset_base: new URL(asset_url).origin,
      useLocalMonitoredServer: false,
      curl_check_url: asset_url,
      no_fallback: false,
    };
  }

  if (storageKey === "remote_server") {
    const asset_url = resolveUrl(d, "REMOTE_CDN_URL", DEFAULT_REMOTE_CDN_URL);
    return {
      delivery_key: "remote_server",
      delivery_role: "remote",
      profile_id: "remote_cdn",
      display_name: "remote CDN",
      asset_url,
      asset_base: new URL(asset_url).origin,
      useLocalMonitoredServer: false,
      curl_check_url: asset_url,
      no_fallback: true,
    };
  }

  if (storageKey === "remote_cos") {
    const asset_url = resolveUrl(d, "REMOTE_COS_URL", DEFAULT_REMOTE_COS_URL);
    return {
      delivery_key: "remote_cos",
      delivery_role: "remote",
      profile_id: "remote_cos",
      display_name: "remote object storage (COS)",
      asset_url,
      asset_base: new URL(asset_url).origin,
      useLocalMonitoredServer: false,
      curl_check_url: asset_url,
      no_fallback: true,
    };
  }

  throw new Error(`Unknown delivery key: ${deliveryKey}`);
}

export function assetUrlWithRunId(baseUrl, runId) {
  if (!baseUrl) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set("run_id", runId);
  return u.toString();
}
