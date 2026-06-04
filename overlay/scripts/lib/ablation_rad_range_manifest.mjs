/**
 * Load .rad Range manifest from baseline CDP audit for full replay.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const DEFAULT_BASELINE = path.join(
  projectRoot,
  "260506_local_diag",
  "single_user_stutter",
  "2026-05-19T05-05-46",
  "cdp_network_audit.csv",
);

/** Fallback: reuse CDP audit from a completed READY single-user Spark-OD trial.
 *  Picks the CSV with the MOST 206 rows (= most complete manifest). */
function findReadySingleUserManifestCsv() {
  let best = null;
  let bestLines = 0;
  for (const paperDir of ["ready_single_user_v1", "ready_single_user"]) {
    const runsRoot = path.join(projectRoot, "paper_materials", paperDir, "runs");
    if (!existsSync(runsRoot)) continue;
    const batches = readdirSync(runsRoot)
      .filter((d) => !d.startsWith("."))
      .sort()
      .reverse();
    for (const batch of batches) {
      const trialRoot = path.join(runsRoot, batch, "per_trial_runs");
      if (!existsSync(trialRoot)) continue;
      const sparkDirs = readdirSync(trialRoot)
        .filter((d) => d.includes("spark_od"))
        .sort()
        .reverse();
      for (const td of sparkDirs) {
        const candidate = path.join(trialRoot, td, "cdp_network_audit.csv");
        if (!existsSync(candidate)) continue;
        const size = statSync(candidate).size;
        // Quick line count proxy: file size / ~120 bytes per line
        // For accuracy, count actual lines only for top candidates
        if (size > bestLines * 100) {
          const text = readFileSync(candidate, "utf8");
          const lines = text.split("\n").filter((l) => l.includes(",206,")).length;
          if (lines > bestLines) {
            bestLines = lines;
            best = candidate;
          }
        }
      }
    }
  }
  return best;
}

export function loadRadRangeManifest(csvPath) {
  const envPath = process.env.VRC_RAD_MANIFEST_CSV;
  let resolved = csvPath || envPath || DEFAULT_BASELINE;
  if (!existsSync(resolved)) {
    const fallback = findReadySingleUserManifestCsv();
    if (fallback) {
      console.warn(`[rad-manifest] Using fallback CDP manifest: ${fallback}`);
      resolved = fallback;
    }
  }
  if (!existsSync(resolved)) {
    throw new Error(`RAD range manifest not found: ${resolved}`);
  }
  csvPath = resolved;
  const text = readFileSync(csvPath, "utf8").trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",");
  const idx = {
    url: header.indexOf("url"),
    range: header.indexOf("range_header"),
    bytes: header.indexOf("encodedDataLength"),
    status: header.indexOf("status"),
  };
  const seen = new Set();
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",");
    const url = cols[idx.url] ?? "";
    const range = cols[idx.range] ?? "";
    const status = cols[idx.status] ?? "";
    if (!url.includes(".rad") || status !== "206" || !range) continue;
    const key = range;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      range,
      encoded_bytes: Number(cols[idx.bytes]) || 0,
    });
  }
  return entries;
}

export function manifestForRadUrl(manifest, radUrl) {
  return manifest.map((e) => ({ url: radUrl, range: e.range, encoded_bytes: e.encoded_bytes }));
}
