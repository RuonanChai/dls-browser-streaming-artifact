import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDeliveryProfilesConfig,
  resolveDeliveryProfile,
} from "../lib/distributed_network/delivery_profiles.mjs";
import { DEFAULT_ORIGIN_URL, REMOTE_PROFILE_ID } from "./constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function loadMatrix() {
  const p = path.join(root, "config", "proactive_single_user_v2", "experiment_matrix.json");
  return JSON.parse(await fs.readFile(p, "utf8"));
}

export async function resolveProactiveDelivery(deliveryKey, matrix) {
  const d = matrix.deliveries[deliveryKey];
  if (!d) throw new Error(`Unknown delivery key: ${deliveryKey}`);

  if (deliveryKey === "origin_server") {
    return {
      delivery_key: deliveryKey,
      profile_id: "origin_server",
      asset_url: d.asset_url || DEFAULT_ORIGIN_URL,
      asset_base: new URL(d.asset_url || DEFAULT_ORIGIN_URL).origin,
      useLocalMonitoredServer: false,
      curl_check_url: d.asset_url || DEFAULT_ORIGIN_URL,
    };
  }

  if (deliveryKey === "local_disk") {
    // Fallback when HPC origin :8090 is down. Uses the local rad file via the
    // cell's MonitoredAssetServer (same workload as origin_server but served
    // from local Node http stream of disk file). Audit must annotate the
    // substitution.
    return {
      delivery_key: deliveryKey,
      profile_id: "local_disk",
      asset_url: null,
      asset_base: null,
      useLocalMonitoredServer: true,
      curl_check_url: null,
      delivery_note: "local_disk_substitute_for_hpc_origin_when_offline",
    };
  }

  if (deliveryKey === "remote_server") {
    const profilesDoc = await loadDeliveryProfilesConfig(null, { preferLab: true });
    const resolved = resolveDeliveryProfile(d.use_profile || REMOTE_PROFILE_ID, profilesDoc);
    return {
      delivery_key: deliveryKey,
      profile_id: resolved.profileId,
      asset_url: resolved.asset_url,
      asset_base: resolved.asset_base,
      useLocalMonitoredServer: false,
      curl_check_url: resolved.asset_url,
    };
  }

  throw new Error(`Unhandled delivery: ${deliveryKey}`);
}
