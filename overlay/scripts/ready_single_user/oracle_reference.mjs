/**
 * Oracle reference inputs: demand trace + visible ground truth (clairvoyant scheduling only).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRadRangeManifest, manifestForRadUrl } from "../lib/ablation_rad_range_manifest.mjs";
import { PAPER_MATERIALS_DIR } from "./constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORACLE_KEY_SCHEMA = "range_bytes";

export { ORACLE_KEY_SCHEMA };

export function oracleRangeKey(d) {
  const s = d?.range_header ?? d?.chunk_id ?? d?.range ?? "";
  const m = String(s).match(/bytes=\d+-\d+/);
  return m ? m[0] : null;
}

export function parseRangeBounds(rangeKey) {
  const m = String(rangeKey).match(/bytes=(\d+)-(\d+)/);
  if (!m) return { range_start: null, range_end: null };
  return { range_start: Number(m[1]), range_end: Number(m[2]) };
}

function normalizeDemandEntry(d, ctx = {}) {
  const rk = oracleRangeKey(d);
  if (!rk) return null;
  const { range_start, range_end } = parseRangeBounds(rk);
  const need = d.chunk_needed_time ?? d.chunk_needed_time_ms ?? d.needed_time ?? d.demand_time_ms;
  return {
    chunk_id: rk,
    object_key: d.object_key ?? rk,
    range_header: rk,
    range_start,
    range_end,
    chunk_needed_time: need,
    chunk_needed_time_ms: need,
    demand_time_ms: d.demand_time_ms ?? need,
    lod: d.lod ?? inferLod(range_start),
    delivery_role: ctx.delivery_role ?? d.delivery_role ?? null,
    phase: ctx.phase ?? d.phase ?? null,
    trace_id: ctx.trace_id ?? d.trace_id ?? "orbit",
    source: d.source ?? "reference",
  };
}

function inferLod(rangeStart) {
  if (rangeStart == null) return null;
  if (rangeStart < 65536) return "base";
  if (rangeStart < 1048576) return "low";
  return "high";
}

export function oraclePaths(batchDir, { phase = null, deliveryRole = "remote" } = {}) {
  const role = deliveryRole;
  const phaseTag = phase ? `phase_${phase.replace(/^phase_/, "")}` : null;
  const base = path.join(root, PAPER_MATERIALS_DIR);
  return {
    demandByRole: path.join(batchDir, `reference_demand_${role}.json`),
    demandByPhase: phaseTag
      ? path.join(batchDir, `reference_demand_${phaseTag}_${role}.json`)
      : null,
    visibleByRole: path.join(batchDir, `visible_ground_truth_${role}.json`),
    visibleByPhase: phaseTag
      ? path.join(batchDir, `visible_ground_truth_${phaseTag}_${role}.json`)
      : null,
    meta: phaseTag
      ? path.join(batchDir, `oracle_reference_meta_${phaseTag}_${role}.json`)
      : path.join(batchDir, `oracle_reference_meta_${role}.json`),
    paperCopyDemand: path.join(base, `reference_demand_${role}.json`),
    paperCopyVisible: path.join(base, `visible_ground_truth_${role}.json`),
  };
}

export async function loadJsonMaybe(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** Rebuild demand from Spark-OD trials in batch (or spark_od baseline_id). */
export async function rebuildReferenceDemandFromSpark(batchDir, {
  deliveryRole = "remote",
  deliveryKey = null,
  phase = null,
} = {}) {
  const dir = path.join(batchDir, "per_trial_json");
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }

  const byRange = new Map();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const t = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
    const isSpark =
      t.baseline_id === "spark_od"
      || t.baseline_id === "B0_on_demand"
      || t.baseline_name === "Spark-OD";
    if (!isSpark || t.hard_gate_passed === false) continue;
    if (deliveryRole && t.delivery_role && t.delivery_role !== deliveryRole) continue;
    if (phase && t.phase && t.phase !== phase) continue;
    if (deliveryKey && t.delivery_key && t.delivery_key !== deliveryKey) continue;

    const trace = t.proactive_snapshot?.demand_trace || [];
    for (const d of trace) {
      const norm = normalizeDemandEntry(d, {
        delivery_role: t.delivery_role,
        phase: t.phase,
        trace_id: t.trace,
        source: "spark_od_median",
      });
      if (!norm || norm.chunk_needed_time_ms == null) continue;
      if (!byRange.has(norm.chunk_id)) byRange.set(norm.chunk_id, []);
      byRange.get(norm.chunk_id).push(norm.chunk_needed_time_ms);
    }
  }
  if (!byRange.size) return null;

  const merged = [];
  for (const [rk, times] of byRange) {
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)];
    const bounds = parseRangeBounds(rk);
    merged.push({
      chunk_id: rk,
      object_key: rk,
      range_header: rk,
      ...bounds,
      chunk_needed_time: med,
      chunk_needed_time_ms: med,
      demand_time_ms: med,
      lod: inferLod(bounds.range_start),
      delivery_role: deliveryRole,
      phase,
      trace_id: "orbit",
      source: "spark_od_median",
    });
  }
  merged.sort((a, b) => a.chunk_needed_time_ms - b.chunk_needed_time_ms);
  return merged;
}

/**
 * Visible GT: manifest ranges + early demand + low-byte first-screen heuristic.
 */
export function buildVisibleGroundTruth(manifest, demandEntries = [], ctx = {}) {
  const demandByRange = new Map();
  for (const d of demandEntries) {
    const rk = oracleRangeKey(d);
    if (!rk) continue;
    const t = d.chunk_needed_time_ms ?? d.chunk_needed_time ?? 1e9;
    if (!demandByRange.has(rk) || t < demandByRange.get(rk)) {
      demandByRange.set(rk, t);
    }
  }

  const entries = [];
  const keys = new Set();
  for (const ent of manifest) {
    const rk = oracleRangeKey(ent);
    if (!rk) continue;
    const { range_start, range_end } = parseRangeBounds(rk);
    const demandT = demandByRange.get(rk);
    const isFirstScreen = range_start != null && range_start < 262144;
    const earlyDemand = demandT != null && demandT < 4000;
    const perceptualWeight = isFirstScreen ? 1.0 : earlyDemand ? 0.7 : 0.2;
    if (perceptualWeight < 0.25 && demandT == null) continue;

    const firstVisible =
      demandT != null
        ? demandT
        : isFirstScreen
          ? 200 + (range_start / 262144) * 800
          : 5000 + (range_start ?? 0) / 65536;

    entries.push({
      chunk_id: rk,
      object_key: rk,
      range_start,
      range_end,
      first_visible_time_ms: firstVisible,
      visible_duration_ms: 10_000,
      screen_space_score: perceptualWeight,
      perceptual_weight: perceptualWeight,
      is_first_screen: isFirstScreen,
      is_base_or_low_lod: range_start != null && range_start < 1048576,
      delivery_role: ctx.delivery_role ?? null,
      phase: ctx.phase ?? null,
    });
    keys.add(rk);
  }

  entries.sort((a, b) => a.first_visible_time_ms - b.first_visible_time_ms);
  return {
    oracle_key_schema: ORACLE_KEY_SCHEMA,
    entries,
    keys: [...keys],
  };
}

export async function writeOracleReferenceArtifacts(batchDir, {
  phase,
  deliveryRole,
  deliveryKey,
  assetUrl,
  demand,
  visible,
}) {
  const paths = oraclePaths(batchDir, { phase, deliveryRole });
  const payload = {
    generated_at: new Date().toISOString(),
    phase,
    delivery_role: deliveryRole,
    delivery_key: deliveryKey,
    asset_url: assetUrl,
    oracle_key_schema: ORACLE_KEY_SCHEMA,
    demand_count: demand?.length ?? 0,
    visible_gt_count: visible?.keys?.length ?? 0,
  };

  await fs.mkdir(batchDir, { recursive: true });
  const demandJson = `${JSON.stringify(demand ?? [], null, 2)}\n`;
  await fs.writeFile(paths.demandByRole, demandJson, "utf8");
  if (paths.demandByPhase) await fs.writeFile(paths.demandByPhase, demandJson, "utf8");
  await fs.mkdir(path.dirname(paths.paperCopyDemand), { recursive: true });
  await fs.writeFile(paths.paperCopyDemand, demandJson, "utf8");

  const visPayload = {
    ...payload,
    entries: visible?.entries ?? [],
    keys: visible?.keys ?? [],
  };
  const visJson = `${JSON.stringify(visPayload, null, 2)}\n`;
  await fs.writeFile(paths.visibleByRole, visJson, "utf8");
  if (paths.visibleByPhase) await fs.writeFile(paths.visibleByPhase, visJson, "utf8");
  await fs.writeFile(paths.paperCopyVisible, visJson, "utf8");
  await fs.writeFile(paths.meta, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return paths;
}

export async function loadOracleInputs(batchDir, { phase, deliveryRole, assetUrl }) {
  const paths = oraclePaths(batchDir, { phase, deliveryRole });
  let demand =
    (paths.demandByPhase && (await loadJsonMaybe(paths.demandByPhase)))
    || (await loadJsonMaybe(paths.demandByRole))
    || (await loadJsonMaybe(paths.paperCopyDemand));
  if (!Array.isArray(demand)) demand = [];

  let visDoc =
    (paths.visibleByPhase && (await loadJsonMaybe(paths.visibleByPhase)))
    || (await loadJsonMaybe(paths.visibleByRole))
    || (await loadJsonMaybe(paths.paperCopyVisible));
  let visibleKeys = visDoc?.keys ?? visDoc?.entries?.map((e) => oracleRangeKey(e)).filter(Boolean) ?? [];

  if ((!demand.length || !visibleKeys.length) && assetUrl) {
    let csvPath = process.env.VRC_RAD_MANIFEST_CSV;
    if (!csvPath && batchDir) {
      csvPath = await findSparkCdpManifestInBatch(batchDir);
      if (csvPath) {
        console.warn(`[oracle_reference] Using Spark-OD CDP manifest from batch: ${csvPath}`);
      }
    }
    const raw = loadRadRangeManifest(csvPath);
    const manifest = manifestForRadUrl(raw, assetUrl);
    if (!demand.length) {
      demand = manifest.map((ent, idx) => {
        const rk = oracleRangeKey(ent);
        const { range_start } = parseRangeBounds(rk);
        return normalizeDemandEntry(
          {
            range_header: rk,
            chunk_needed_time_ms: 500 + idx * 120 + (range_start ?? 0) / 8192,
            source: "manifest_synthetic",
          },
          { delivery_role: deliveryRole, phase },
        );
      }).filter(Boolean);
    }
    if (!visibleKeys.length) {
      const vis = buildVisibleGroundTruth(manifest, demand, { delivery_role: deliveryRole, phase });
      visibleKeys = vis.keys;
      visDoc = vis;
    }
  }

  return {
    paths,
    demand,
    visibleKeys,
    visibleDoc: visDoc,
    oracle_key_schema: ORACLE_KEY_SCHEMA,
  };
}

export function validateOracleInputs({ demand, visibleKeys, manifestRanges, oracleAudit = null, oracleType = "perceptual_ready" }) {
  const manifestSet = new Set(manifestRanges || []);
  const demandKeys = (demand || []).map((d) => oracleRangeKey(d)).filter(Boolean);
  let overlap = 0;
  for (const k of demandKeys) {
    if (manifestSet.has(k)) overlap += 1;
  }
  const overlapRatio = demandKeys.length ? overlap / demandKeys.length : 0;

  const reasons = [];
  if (!demand?.length) reasons.push("empty_demand");
  if (oracleType === "perceptual_ready" && !(visibleKeys?.length > 0)) {
    reasons.push("empty_visible_gt");
  }
  if (overlapRatio < 0.8) reasons.push(`manifest_overlap_${(overlapRatio * 100).toFixed(0)}pct`);
  if (oracleAudit) {
    if ((oracleAudit.selected_count ?? 0) <= 0) reasons.push("zero_prefetch_selected");
    if (oracleType === "perceptual_ready" && (oracleAudit.visible_boost_count ?? 0) <= 0) {
      reasons.push("zero_perceptual_boost");
    }
  }

  const valid = reasons.length === 0;
  return {
    oracle_input_valid: valid,
    oracle_invalid_reason: valid ? null : reasons.join("; "),
    oracle_demand_count: demand?.length ?? 0,
    oracle_visible_gt_count: visibleKeys?.length ?? 0,
    oracle_manifest_overlap_count: overlap,
    oracle_manifest_overlap_ratio: overlapRatio,
    oracle_key_schema: ORACLE_KEY_SCHEMA,
    oracle_perceptual_boost_applied_count: oracleAudit?.visible_boost_count ?? null,
    oracle_prefetch_candidate_count: oracleAudit?.candidate_count ?? null,
    oracle_prefetch_selected_count: oracleAudit?.selected_count ?? null,
  };
}

export async function ensureOracleReference(batchDir, {
  phase,
  deliveryRole,
  deliveryKey,
  assetUrl,
  force = false,
}) {
  const paths = oraclePaths(batchDir, { phase, deliveryRole });
  if (!force) {
    const existing = await loadJsonMaybe(paths.demandByRole);
    const vis = await loadJsonMaybe(paths.visibleByRole);
    if (Array.isArray(existing) && existing.length > 0 && (vis?.keys?.length > 0 || vis?.entries?.length > 0)) {
      return { paths, demand: existing, visibleKeys: vis.keys ?? [], rebuilt: false };
    }
  }

  let demand = await rebuildReferenceDemandFromSpark(batchDir, {
    deliveryRole,
    deliveryKey,
    phase,
  });

  let csvPath = process.env.VRC_RAD_MANIFEST_CSV;
  if (!csvPath) {
    csvPath = await findSparkCdpManifestInBatch(batchDir);
    if (csvPath) {
      console.warn(`[oracle_reference] ensureOracleReference: CDP manifest ${csvPath}`);
    }
  }
  const raw = loadRadRangeManifest(csvPath);
  const manifest = manifestForRadUrl(raw, assetUrl);
  if (!demand?.length) {
    demand = manifest
      .map((ent, idx) => {
        const rk = oracleRangeKey(ent);
        const { range_start } = parseRangeBounds(rk);
        return normalizeDemandEntry(
          {
            range_header: rk,
            chunk_needed_time_ms: 400 + idx * 100 + (range_start ?? 0) / 16384,
            source: "manifest_fallback_no_spark",
          },
          { delivery_role: deliveryRole, phase },
        );
      })
      .filter(Boolean);
  }

  const visible = buildVisibleGroundTruth(manifest, demand, {
    delivery_role: deliveryRole,
    phase,
  });
  if (!demand?.length || !(visible?.keys?.length > 0)) {
    console.warn(
      "[oracle_reference] Refusing to write empty Oracle reference "
      + `(demand=${demand?.length ?? 0}, visible_gt=${visible?.keys?.length ?? 0}). `
      + "Run Spark-OD first and set VRC_RAD_MANIFEST_CSV to a trial cdp_network_audit.csv.",
    );
    return {
      paths,
      demand: demand ?? [],
      visibleKeys: visible?.keys ?? [],
      rebuilt: false,
      skipped_empty: true,
    };
  }

  await writeOracleReferenceArtifacts(batchDir, {
    phase,
    deliveryRole,
    deliveryKey,
    assetUrl,
    demand,
    visible,
  });
  return { paths, demand, visibleKeys: visible.keys, rebuilt: true };
}

/** Latest completed Spark-OD CDP audit in batch (for manifest / visible GT). */
export async function findSparkCdpManifestInBatch(batchDir) {
  const dir = path.join(batchDir, "per_trial_runs");
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.includes("spark_od")) continue;
    const csv = path.join(dir, ent.name, "cdp_network_audit.csv");
    try {
      const st = await fs.stat(csv);
      candidates.push({ csv, mtime: st.mtimeMs });
    } catch { /* */ }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].csv;
}

