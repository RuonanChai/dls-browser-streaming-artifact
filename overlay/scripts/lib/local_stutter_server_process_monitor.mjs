/**
 * Node process monitor (same process as asset server + diag orchestrator).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

function isoNow() {
  return new Date().toISOString();
}

function cpuUsageToMs(usage) {
  return (usage.user + usage.system) / 1000;
}

export class ServerProcessMonitor {
  constructor(runDir, { intervalMs = 500, serverPid = process.pid } = {}) {
    this.csvPath = path.join(runDir, "server_monitor", "server_process_monitor.csv");
    this.intervalMs = intervalMs;
    this.serverPid = serverPid;
    this.t0 = performance.now();
    this.timer = null;
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.prevCpu = process.cpuUsage();
    this.prevWall = performance.now();
    this.rows = [];
    this.header =
      "timestamp_iso,elapsed_ms,server_pid,node_process_cpu_percent,node_process_rss_mb,node_process_heap_used_mb,node_process_heap_total_mb,node_process_external_mb,node_process_array_buffers_mb,process_uptime_s,event_loop_delay_mean_ms,event_loop_delay_p95_ms,event_loop_delay_max_ms,active_handles_count,active_requests_count\n";
  }

  async start() {
    await fs.mkdir(path.dirname(this.csvPath), { recursive: true });
    await fs.writeFile(this.csvPath, this.header, "utf8");
    this.loopDelay.enable();
    this.timer = setInterval(() => this._sample(), this.intervalMs);
  }

  _sample() {
    const nowWall = performance.now();
    const cpuNow = process.cpuUsage();
    const cpuDeltaMs = cpuUsageToMs({
      user: cpuNow.user - this.prevCpu.user,
      system: cpuNow.system - this.prevCpu.system,
    });
    const wallDeltaMs = nowWall - this.prevWall;
    const cpuPercent =
      wallDeltaMs > 0 ? Math.round((100 * (cpuDeltaMs / wallDeltaMs)) * 100) / 100 : 0;
    this.prevCpu = cpuNow;
    this.prevWall = nowWall;

    const mem = process.memoryUsage();
    const el = this.loopDelay;
    el.disable();
    const row = {
      timestamp_iso: isoNow(),
      elapsed_ms: Math.round(nowWall - this.t0),
      server_pid: this.serverPid,
      node_process_cpu_percent: cpuPercent,
      node_process_rss_mb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      node_process_heap_used_mb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      node_process_heap_total_mb: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      node_process_external_mb: Math.round((mem.external / 1024 / 1024) * 100) / 100,
      node_process_array_buffers_mb: Math.round(((mem.arrayBuffers ?? 0) / 1024 / 1024) * 100) / 100,
      process_uptime_s: Math.round(process.uptime() * 10) / 10,
      event_loop_delay_mean_ms: Math.round((el.mean / 1e6) * 1000) / 1000,
      event_loop_delay_p95_ms: Math.round((el.percentile(95) / 1e6) * 1000) / 1000,
      event_loop_delay_max_ms: Math.round((el.max / 1e6) * 1000) / 1000,
      active_handles_count: typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : "",
      active_requests_count: typeof process._getActiveRequests === "function" ? process._getActiveRequests().length : "",
    };
    el.reset();
    el.enable();
    this.rows.push(row);
    const line = `${row.timestamp_iso},${row.elapsed_ms},${row.server_pid},${row.node_process_cpu_percent},${row.node_process_rss_mb},${row.node_process_heap_used_mb},${row.node_process_heap_total_mb},${row.node_process_external_mb},${row.node_process_array_buffers_mb},${row.process_uptime_s},${row.event_loop_delay_mean_ms},${row.event_loop_delay_p95_ms},${row.event_loop_delay_max_ms},${row.active_handles_count},${row.active_requests_count}\n`;
    fs.appendFile(this.csvPath, line, "utf8").catch(() => {});
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.loopDelay.disable();
    return this.rows;
  }
}
