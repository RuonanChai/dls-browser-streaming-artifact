/**
 * Load worker / HPC / dual-CDN endpoints from vrc-paper/experiments/distributed_lab.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");

const COIT_FLAT_KEY = "streaming-lod/coit-40m-sh1-lod.rad";

export async function loadLabInfrastructure(labPath) {
  const p =
    labPath || path.join(projectRoot, "vrc-paper", "experiments", "distributed_lab.json");
  const lab = JSON.parse(await fs.readFile(p, "utf8"));

  const hpcBase = String(lab.hpc_asset_base ?? "http://10.120.17.176:8090/examples").replace(
    /\/+$/,
    "",
  );
  const cdn1Base = String(lab.cdn_asset_base ?? "").replace(/\/+$/, "");
  const cdn2Base = String(lab.cdn2_asset_base ?? "https://storage.googleapis.com/forge-dev-public").replace(
    /\/+$/,
    "",
  );
  const cdn2Path = String(lab.cdn2_object_path ?? "asundqui/rad/260217/coit-40m-sh1-lod.rad").replace(
    /^\/+/,
    "",
  );

  const controllerHost = String(lab.controller_host ?? "10.4.158.143");
  const worker2Host = String(lab.ssh_host ?? "10.4.146.68");
  const vitePort = Number(lab.vite_port ?? 9200);

  return {
    lab_path: p,
    workers: {
      worker1: {
        worker_id: "worker1",
        role: "controller",
        host_ip: controllerHost,
        vite_port: vitePort,
        machine_id: controllerHost,
      },
      worker2: {
        worker_id: "worker2",
        role: "remote_chrome",
        host_ip: worker2Host,
        ssh_user: lab.ssh_user,
        ssh_port: lab.ssh_port ?? 22,
        machine_id: worker2Host,
      },
    },
    assets: {
      coit_flat_key: COIT_FLAT_KEY,
      hpc_asset_url: `${hpcBase}/${COIT_FLAT_KEY}`,
      cdn1_r2_asset_url: cdn1Base ? `${cdn1Base}/${COIT_FLAT_KEY}` : null,
      cdn2_gcs_asset_url: `${cdn2Base}/${cdn2Path}`,
      lan_controller_asset_url: `http://${controllerHost}:9210/examples/${COIT_FLAT_KEY}`,
    },
    raw: lab,
  };
}

/** Merge lab URLs into delivery profile definitions. */
export function buildDeliveryProfilesFromLab(infra) {
  const { assets } = infra;
  return {
    version: 2,
    source: "vrc-paper/experiments/distributed_lab.json",
    profiles: {
      local_loopback: {
        description: "127.0.0.1 MonitoredAssetServer — client ceiling only (NOT WAN)",
        asset_host: "127.0.0.1",
        asset_port: 0,
        asset_path: `/examples/${assets.coit_flat_key}`,
        use_local_monitored_server: true,
        throttle: null,
      },
      hpc_server: {
        description: "HPC origin HTTP Range server",
        asset_url: assets.hpc_asset_url,
        use_local_monitored_server: false,
        cdn_label: "hpc",
        throttle: null,
      },
      cdn1_r2: {
        description: "CDN-A Cloudflare R2 public bucket",
        asset_url: assets.cdn1_r2_asset_url,
        use_local_monitored_server: false,
        cdn_label: "cdn1",
        throttle: null,
      },
      cdn2_gcs: {
        description: "CDN-B GCS forge-dev-public object path",
        asset_url: assets.cdn2_gcs_asset_url,
        use_local_monitored_server: false,
        cdn_label: "cdn2",
        throttle: null,
      },
      lan_controller: {
        description: "LAN Vite on controller (worker1)",
        asset_url: assets.lan_controller_asset_url,
        use_local_monitored_server: false,
        cdn_label: "lan",
        throttle: null,
      },
      cdn1_r2_throttled_50mbps_100ms: {
        extends: "cdn1_r2",
        throttle: { bandwidth_mbps: 50, rtt_ms: 100, packet_loss_pct: 0 },
        throttle_note: "External shaper required; Chrome DevTools throttle is best-effort",
      },
      cdn1_r2_throttled_10mbps_100ms: {
        extends: "cdn1_r2",
        throttle: { bandwidth_mbps: 10, rtt_ms: 100, packet_loss_pct: 0 },
      },
    },
  };
}

export async function loadDeliveryProfilesWithLab() {
  const infra = await loadLabInfrastructure();
  const doc = buildDeliveryProfilesFromLab(infra);
  const profiles = { ...doc.profiles };
  for (const [id, prof] of Object.entries({ ...profiles })) {
    if (prof.extends && profiles[prof.extends]) {
      profiles[id] = { ...profiles[prof.extends], ...prof, id };
    } else {
      profiles[id] = { ...prof, id };
    }
  }
  return { infra, profilesDoc: { ...doc, profiles } };
}
