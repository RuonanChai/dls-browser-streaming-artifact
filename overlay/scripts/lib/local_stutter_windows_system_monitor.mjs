/**
 * Windows system monitor via PowerShell Get-Counter (fallback Get-Process).
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const PS_SCRIPT = String.raw`
param(
  [string]$OutCsv,
  [int]$IntervalMs = 1000,
  [int]$NodePid = 0
)
$ErrorActionPreference = 'SilentlyContinue'
$header = 'timestamp_iso,elapsed_ms,total_cpu_percent,available_memory_mb,disk_read_bytes_per_sec,disk_write_bytes_per_sec,disk_queue_length,disk_active_time_percent,node_process_id,node_cpu_percent_if_available,chrome_cpu_percent_if_available'
Set-Content -Path $OutCsv -Value $header -Encoding UTF8
$t0 = Get-Date
$useCounter = $true
try {
  $null = Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 1
} catch { $useCounter = $false }
while ($true) {
  $now = Get-Date
  $elapsed = [int](($now - $t0).TotalMilliseconds)
  $iso = $now.ToString('o')
  if ($useCounter) {
    $c = Get-Counter @(
      '\Processor(_Total)\% Processor Time',
      '\Memory\Available MBytes',
      '\PhysicalDisk(_Total)\Disk Read Bytes/sec',
      '\PhysicalDisk(_Total)\Disk Write Bytes/sec',
      '\PhysicalDisk(_Total)\Current Disk Queue Length',
      '\PhysicalDisk(_Total)\% Disk Time'
    ) -SampleInterval 1 -MaxSamples 1
    $s = $c.CounterSamples
    $cpu = [math]::Round(($s | Where-Object { $_.Path -like '*Processor*' }).CookedValue, 2)
    $mem = [math]::Round(($s | Where-Object { $_.Path -like '*Available MBytes*' }).CookedValue, 2)
    $dr = [math]::Round(($s | Where-Object { $_.Path -like '*Disk Read Bytes*' }).CookedValue, 2)
    $dw = [math]::Round(($s | Where-Object { $_.Path -like '*Disk Write Bytes*' }).CookedValue, 2)
    $dq = [math]::Round(($s | Where-Object { $_.Path -like '*Disk Queue*' }).CookedValue, 4)
    $da = [math]::Round(($s | Where-Object { $_.Path -like '*Disk Time*' }).CookedValue, 2)
  } else {
    $cpu = ''; $mem = ''; $dr = ''; $dw = ''; $dq = ''; $da = ''
  }
  $nodeCpu = ''
  $chromeCpu = ''
  if ($NodePid -gt 0) {
    $np = Get-Process -Id $NodePid -ErrorAction SilentlyContinue
    if ($np) { $nodeCpu = [math]::Round($np.CPU, 2) }
  }
  $cp = Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object CPU -Sum
  if ($cp) { $chromeCpu = [math]::Round($cp.Sum, 2) }
  $line = "$iso,$elapsed,$cpu,$mem,$dr,$dw,$dq,$da,$NodePid,$nodeCpu,$chromeCpu"
  Add-Content -Path $OutCsv -Value $line -Encoding UTF8
  Start-Sleep -Milliseconds $IntervalMs
}
`;

export class WindowsSystemMonitor {
  constructor(runDir, { intervalMs = 1000, nodePid = process.pid } = {}) {
    this.csvPath = path.join(runDir, "server_monitor", "windows_system_monitor.csv");
    this.psPath = path.join(runDir, "server_monitor", "windows_monitor.ps1");
    this.intervalMs = intervalMs;
    this.nodePid = nodePid;
    this.child = null;
  }

  async start() {
    await fs.mkdir(path.dirname(this.csvPath), { recursive: true });
    await fs.writeFile(this.psPath, PS_SCRIPT, "utf8");
    this.child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.psPath,
        "-OutCsv",
        this.csvPath,
        "-IntervalMs",
        String(this.intervalMs),
        "-NodePid",
        String(this.nodePid),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    await new Promise((r) => setTimeout(r, 1500));
  }

  async stop() {
    if (!this.child) return;
    try {
      this.child.kill("SIGTERM");
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 800));
    try {
      if (!this.child.killed) this.child.kill("SIGKILL");
    } catch { /* */ }
    this.child = null;
  }
}
