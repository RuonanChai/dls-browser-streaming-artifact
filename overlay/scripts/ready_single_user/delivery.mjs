import fs from "node:fs/promises";

import path from "node:path";

import { fileURLToPath } from "node:url";

import {

  loadDeliveryProfilesConfig,

  resolveDeliveryProfile,

} from "../lib/distributed_network/delivery_profiles.mjs";

import { DEFAULT_EDGE_URL, DEFAULT_GCS_URL, REMOTE_PROFILE_ID } from "./constants.mjs";

import { normalizeDeliveryKey } from "./delivery_metadata.mjs";



const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");



export async function loadMatrix() {

  const p = path.join(root, "config", "ready_single_user", "experiment_matrix.json");

  return JSON.parse(await fs.readFile(p, "utf8"));

}



export { normalizeDeliveryKey };



export async function resolveDelivery(deliveryKey, matrix) {

  const norm = normalizeDeliveryKey(deliveryKey);

  const storageKey = norm.storage_key;

  const d = matrix.deliveries[storageKey] ?? matrix.deliveries[deliveryKey];

  if (!d && storageKey !== "local_disk") {

    throw new Error(`Unknown delivery key: ${deliveryKey} (${storageKey})`);

  }



  if (storageKey === "edge_server" || deliveryKey === "origin_server") {

    const asset_url = d?.asset_url || matrix.deliveries?.origin_server?.asset_url || DEFAULT_EDGE_URL;

    return {

      delivery_key: storageKey,

      delivery_role: "edge",

      profile_id: "edge_server",

      display_name: "LAN edge server",

      asset_url,

      asset_base: new URL(asset_url).origin,

      useLocalMonitoredServer: false,

      useProxy: true,

      upstream_url: asset_url,

      curl_check_url: asset_url,

      is_lan_edge: true,

      is_remote: false,

      is_local: false,

    };

  }



  if (storageKey === "local_disk") {

    return {

      delivery_key: "local_disk",

      delivery_role: "local",

      profile_id: "local_disk",

      display_name: "local ceiling",

      asset_url: null,

      asset_base: null,

      useLocalMonitoredServer: true,

      useProxy: false,

      curl_check_url: null,

      is_lan_edge: false,

      is_remote: false,

      is_local: true,

    };

  }



  if (storageKey === "remote_server") {

    const profilesDoc = await loadDeliveryProfilesConfig(null, { preferLab: true });

    const resolved = resolveDeliveryProfile(d.use_profile || REMOTE_PROFILE_ID, profilesDoc);

    return {

      delivery_key: "remote_server",

      delivery_role: "remote",

      profile_id: resolved.profileId,

      display_name: "remote direct (CDN/storage)",

      asset_url: resolved.asset_url,

      asset_base: resolved.asset_base,

      useLocalMonitoredServer: false,

      useProxy: false,

      curl_check_url: resolved.asset_url,

      is_lan_edge: false,

      is_remote: true,

      is_local: false,

      no_fallback: true,

    };

  }



  if (storageKey === "remote_gcs") {

    const gcsUrl = process.env.VRC_CDN2_ASSET_URL || d?.asset_url || DEFAULT_GCS_URL;

    return {

      delivery_key: "remote_gcs",

      delivery_role: "remote",

      profile_id: "cdn2_gcs",

      display_name: "remote GCS (public object storage)",

      asset_url: gcsUrl,

      asset_base: gcsUrl ? new URL(gcsUrl).origin : null,

      useLocalMonitoredServer: false,

      useProxy: false,

      curl_check_url: gcsUrl,

      is_lan_edge: false,

      is_remote: true,

      is_local: false,

      no_fallback: true,

      cdn_label: "gcs",

    };

  }

  if (storageKey === "remote_cos" || storageKey === "remote_cos_server") {

    const cosUrl = process.env.VRC_COS_ASSET_URL || d?.asset_url || "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com/coit-40m-sh1-lod.rad";

    return {

      delivery_key: "remote_cos",

      delivery_role: "remote",

      profile_id: "cdn3_cos",

      display_name: "remote COS (Tencent Cloud, Guangzhou)",

      asset_url: cosUrl,

      asset_base: cosUrl ? new URL(cosUrl).origin : null,

      useLocalMonitoredServer: false,

      useProxy: false,

      curl_check_url: cosUrl,

      is_lan_edge: false,

      is_remote: true,

      is_local: false,

      no_fallback: true,

      cdn_label: "cos",

    };

  }



  throw new Error(`Unhandled delivery: ${deliveryKey}`);

}



export function assetUrlWithRunId(baseUrl, runId) {

  if (!baseUrl) return baseUrl;

  const u = new URL(baseUrl);

  u.searchParams.set("run_id", runId);

  return u.toString();

}


