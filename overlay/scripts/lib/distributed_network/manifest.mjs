import fs from "node:fs/promises";
import path from "node:path";

export function trialKey(t) {
  return [
    t.delivery_profile,
    t.scenario,
    t.arm_id,
    t.measurement_mode,
    t.trial_index,
    t.client_id ?? "c0",
  ].join("|");
}

export async function loadManifest(batchDir) {
  const p = path.join(batchDir, "manifest.json");
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return { trials: [], updated_at: null };
  }
}

export async function saveManifest(batchDir, manifest) {
  manifest.updated_at = new Date().toISOString();
  const p = path.join(batchDir, "manifest.json");
  await fs.writeFile(p, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return p;
}

export function upsertTrial(manifest, trial) {
  const key = trialKey(trial);
  const idx = manifest.trials.findIndex((t) => trialKey(t) === key);
  const entry = { ...trial, trial_key: key, updated_at: new Date().toISOString() };
  if (idx >= 0) manifest.trials[idx] = entry;
  else manifest.trials.push(entry);
  return entry;
}

export function pendingTrials(manifest, { retryFailed = true } = {}) {
  return manifest.trials.filter((t) => {
    if (t.status === "completed") return false;
    if (t.status === "failed" && retryFailed) return true;
    return t.status === "pending" || t.status === "running" || !t.status;
  });
}
