#!/usr/bin/env node
/**
 * Release stale READY / ablation asset ports (19300–19499) on Windows.
 *   node scripts/ready_single_user/port_cleanup.mjs
 */
import { execSync } from "node:child_process";
import { cleanupStaleAblationProcesses } from "../lib/local_stutter_ablation_cell.mjs";

const PORT_MIN = 19300;
const PORT_MAX = 19499;

function listListenersWindows() {
  try {
    const out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
    const byPid = new Map();
    for (const line of out.split("\n")) {
      const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+LISTENING\s+(\d+)/);
      if (!m) continue;
      const port = Number(m[1]);
      const pid = Number(m[2]);
      if (port >= PORT_MIN && port <= PORT_MAX) {
        if (!byPid.has(pid)) byPid.set(pid, []);
        byPid.get(pid).push(port);
      }
    }
    return byPid;
  } catch {
    return new Map();
  }
}

function killPid(pid) {
  for (const args of [`/F /T /PID ${pid}`, `/F /PID ${pid}`]) {
    try {
      execSync(`taskkill ${args}`, { encoding: "utf8", windowsHide: true, stdio: "pipe" });
      return true;
    } catch {
      /* retry without tree */
    }
  }
  return false;
}

async function main() {
  console.log(`[port_cleanup] scanning ${PORT_MIN}-${PORT_MAX} on 127.0.0.1`);
  await cleanupStaleAblationProcesses();

  const byPid = listListenersWindows();
  if (!byPid.size) {
    console.log("[port_cleanup] OK — no stale listeners in range");
    return;
  }

  for (const [pid, ports] of byPid) {
    if (pid === process.pid) continue;
    const ok = killPid(pid);
    console.log(
      `${ok ? "killed" : "FAILED"} PID ${pid} ports ${ports.slice(0, 5).join(",")}${ports.length > 5 ? "..." : ""}`,
    );
  }

  await new Promise((r) => setTimeout(r, 1500));
  const remain = listListenersWindows();
  if (remain.size) {
    console.error("[port_cleanup] WARN — some listeners remain (taskkill Access denied?)");
    console.error("[port_cleanup] New READY runs use dynamic ports (assetPort:0); stale 19300+ may be ignored.");
    console.error("[port_cleanup] If needed: close the owning terminal or kill node.exe as Administrator.");
    process.exit(1);
  }
  console.log("[port_cleanup] OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
