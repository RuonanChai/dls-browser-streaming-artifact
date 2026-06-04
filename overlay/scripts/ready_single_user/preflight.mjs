#!/usr/bin/env node
/**
 * READY single-user preflight: verify edge + remote RAD URLs (Range / 206).
 *
 *   node scripts/ready_single_user/preflight.mjs
 *   node scripts/ready_single_user/preflight.mjs --export-env
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CANONICAL_ENDPOINTS, DEFAULT_EDGE_URL, DEFAULT_REMOTE_URL } from "./constants.mjs";
import { loadMatrix, resolveDelivery } from "./delivery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  return { exportEnv: argv.includes("--export-env") };
}

function curlHead(url) {
  const r = spawnSync(
    "curl.exe",
    ["-sI", "--connect-timeout", "15", "-H", "Range: bytes=0-1023", url],
    { encoding: "utf8", windowsHide: true },
  );
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const status = out.match(/^HTTP\/\S+\s+(\d+)/m)?.[1] ?? "?";
  const ok = status === "206" || status === "200";
  return { ok, status, firstLine: out.split("\n")[0] || "" };
}

async function main() {
  const { exportEnv } = parseArgs(process.argv.slice(2));
  spawnSync("node", ["scripts/ready_single_user/port_cleanup.mjs"], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  const matrix = await loadMatrix();
  const remoteResolved = await resolveDelivery("remote", matrix);
  const edgeUrl = matrix.deliveries?.edge_server?.asset_url || DEFAULT_EDGE_URL;
  const remoteUrl = remoteResolved.asset_url || DEFAULT_REMOTE_URL;

  const checks = [
    { name: "edge", url: edgeUrl, expected: "${EDGE_SERVER_HOST}:8090" },
    { name: "remote", url: remoteUrl, expected: "pub-0429777a95db48e192b4c665413f8eb2.r2.dev" },
  ];

  let allOk = true;
  console.log("[preflight] READY single-user endpoints\n");
  for (const c of checks) {
    const { ok, status, firstLine } = curlHead(c.url);
    if (!c.url.includes(c.expected.split(":")[0])) {
      console.warn(`[preflight] WARN ${c.name} URL may not match canonical host: ${c.url}`);
    }
    console.log(`${ok ? "PASS" : "FAIL"} ${c.name} HTTP ${status}`);
    console.log(`  ${c.url}`);
    console.log(`  ${firstLine}`);
    if (!ok) allOk = false;
  }

  console.log("\n[preflight] Canonical (constants.mjs)");
  console.log(`  edge:   ${CANONICAL_ENDPOINTS.edge_asset_url}`);
  console.log(`  remote: ${CANONICAL_ENDPOINTS.remote_asset_url}`);

  const manifestEnv = process.env.VRC_RAD_MANIFEST_CSV;
  const manifestPath = manifestEnv
    ? path.isAbsolute(manifestEnv)
      ? manifestEnv
      : path.join(root, manifestEnv)
    : null;
  let manifestOk = false;
  if (manifestPath) {
    try {
      await fs.access(manifestPath);
      manifestOk = true;
      console.log(`PASS manifest exists\n  ${manifestPath}`);
    } catch {
      console.log(`FAIL manifest missing\n  ${manifestPath}`);
      allOk = false;
    }
  } else {
    console.log("FAIL VRC_RAD_MANIFEST_CSV not set");
    allOk = false;
  }

  if (edgeUrl !== DEFAULT_EDGE_URL && edgeUrl !== CANONICAL_ENDPOINTS.edge_asset_url) {
    console.warn(`[preflight] WARN edge URL differs from canonical:\n  got: ${edgeUrl}\n  exp: ${DEFAULT_EDGE_URL}`);
  }
  if (remoteUrl !== DEFAULT_REMOTE_URL) {
    console.warn(`[preflight] WARN remote URL differs from canonical:\n  got: ${remoteUrl}\n  exp: ${DEFAULT_REMOTE_URL}`);
  }

  if (exportEnv && allOk) {
    console.log("\n[preflight] Export for PowerShell:");
    console.log(`$env:VRC_REMOTE_CDN_ASSET_URL = "${remoteUrl}"`);
    console.log(
      `$env:VRC_RAD_MANIFEST_CSV = "paper_materials/ready_single_user/runs/2026-05-25T07-34-55/per_trial_runs/origin_server__spark_od__phaseB_mini__t0/cdp_network_audit.csv"`,
    );
  }

  if (!allOk) {
    console.error("\n[preflight] BLOCKED — fix edge/remote before mini.");
    process.exit(1);
  }
  console.log("\n[preflight] OK — safe to run mini.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
