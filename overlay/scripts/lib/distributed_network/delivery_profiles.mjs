import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");

export async function loadDeliveryProfilesConfig(configPath, { preferLab = true } = {}) {
  if (preferLab && !configPath) {
    try {
      const { loadDeliveryProfilesWithLab } = await import("./load_lab_infrastructure.mjs");
      const { profilesDoc } = await loadDeliveryProfilesWithLab();
      return profilesDoc;
    } catch (e) {
      console.warn(`[delivery] lab profiles fallback: ${e?.message || e}`);
    }
  }
  const p =
    configPath ||
    path.join(projectRoot, "config", "distributed_network", "delivery_profiles.json");
  const raw = JSON.parse(await fs.readFile(p, "utf8"));
  const profiles = { ...raw.profiles };
  for (const [id, prof] of Object.entries({ ...profiles })) {
    if (prof.extends && profiles[prof.extends]) {
      profiles[id] = { ...profiles[prof.extends], ...prof, id };
    } else {
      profiles[id] = { ...prof, id };
    }
  }
  return { ...raw, profiles };
}

/**
 * Resolve asset base URL for a delivery profile.
 * @returns {{ profileId: string, asset_url: string, asset_base: string, useLocalMonitoredServer: boolean, throttle: object|null }}
 */
/** Legacy names from early batches / delivery_profiles.json v1 */
const PROFILE_ALIASES = {
  lan_server: "lan_controller",
  remote_cdn: "cdn1_r2",
  remote_cdn_throttled_50mbps_100ms: "cdn1_r2_throttled_50mbps_100ms",
  remote_cdn_throttled_10mbps_100ms: "cdn1_r2_throttled_10mbps_100ms",
};

export function resolveDeliveryProfile(profileId, profilesDoc) {
  const resolvedId = PROFILE_ALIASES[profileId] ?? profileId;
  const prof = profilesDoc.profiles[resolvedId];
  if (!prof) throw new Error(`Unknown delivery profile: ${profileId}`);
  profileId = resolvedId;

  process.env.VRC_DELIVERY_PROFILE = profileId;

  if (prof.use_local_monitored_server) {
    return {
      profileId,
      asset_base: null,
      asset_url: null,
      asset_path: prof.asset_path,
      useLocalMonitoredServer: true,
      throttle: prof.throttle ?? null,
    };
  }

  if (prof.asset_url) {
    const assetUrl = String(prof.asset_url).trim();
    const u = new URL(assetUrl);
    return {
      profileId,
      asset_base: `${u.protocol}//${u.host}`,
      asset_url: assetUrl,
      asset_path: u.pathname,
      useLocalMonitoredServer: false,
      throttle: prof.throttle ?? null,
      cdn_label: prof.cdn_label ?? null,
    };
  }

  if (prof.asset_url_env) {
    const assetUrl = String(process.env[prof.asset_url_env] ?? "").trim();
    if (!assetUrl) {
      throw new Error(
        `Profile ${profileId} requires env ${prof.asset_url_env} (HTTPS URL with Range support)`,
      );
    }
    const u = new URL(assetUrl);
    return {
      profileId,
      asset_base: `${u.protocol}//${u.host}`,
      asset_url: assetUrl,
      asset_path: u.pathname,
      useLocalMonitoredServer: false,
      throttle: prof.throttle ?? null,
      cdn_label: prof.cdn_label ?? null,
    };
  }

  const host =
    (prof.asset_host_env && process.env[prof.asset_host_env]) ||
    prof.asset_host ||
    "127.0.0.1";
  const port = Number(
    (prof.asset_port_env && process.env[prof.asset_port_env]) || prof.asset_port || 9200,
  );
  const assetPath = prof.asset_path || "/examples/streaming-lod/coit-40m-sh1-lod.rad";
  const assetBase = `http://${host}:${port}`;
  const assetUrl = `${assetBase}${assetPath}`;

  return {
    profileId,
    asset_base: assetBase,
    asset_url: assetUrl,
    asset_path: assetPath,
    useLocalMonitoredServer: false,
    throttle: prof.throttle ?? null,
    cdn_label: prof.cdn_label ?? null,
  };
}
