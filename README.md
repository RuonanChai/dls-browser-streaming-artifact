# DLS Browser Streaming — Experiment Artifact

This repository contains the **Demand Lookahead Scheduling (DLS)** browser implementation and a minimal measurement harness for reproducing experiments on **Spark 2.0**.

It includes **measurement code only** — no figure plotting scripts, READY/Oracle prefetch stack, or report generators such as `generate_paper_reports.mjs`.

For a full description of the DLS mechanism, see [`docs/DLS_MECHANISM.md`](docs/DLS_MECHANISM.md).

---

## Repository layout

```
overlay/
  src/
    SplatPager.ts          # DLS gate + lookahead enqueue (driveFetchers)
    SparkRenderer.ts       # Per-frame fetchPriority rebuild (visible chunks first)
  config/ready_single_user/
    experiment_matrix.json # DLS-only phases (Spark-OD + DLS variants)
  scripts/ready_single_user/
    run.mjs                # Batch trial scheduler
    trial_cell.mjs         # Single trial (Playwright + CDP)
    analyze.mjs            # Aggregate per_trial_json → dls_summary.csv
    constants.mjs          # Baselines: spark_od, dls, dls_l, dls_a
    delivery.mjs           # Asset URL resolution (env vars / matrix)
    cdp_enrich.mjs         # Align CDP rows with chunk probe states
    matrix.mjs, gates.mjs, trace_replay.mjs, ...
  scripts/lib/
    local_stutter_ablation_cell.mjs   # Browser ablation main loop
    local_stutter_ablation_html.mjs   # Inject chunk timing probe (no READY stack)
    proactive_chunk_probe.js          # Per-chunk fetch/parse/upload timeline
    ablation_*.js, local_stutter_*.mjs
  vrc-paper/experiments/
    cdp_network_audit.mjs, audit_io.mjs
install_overlay.sh         # Copy overlay onto a Spark checkout
docs/DLS_MECHANISM.md      # Full DLS mechanism reference
```

**Not included:** LaTeX sources, `plot_*.py` figure scripts, screenshot composers, or raw `paper_materials/` trial outputs (generated locally when you run experiments).

---

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| Node.js | ≥ 18 |
| Spark 2.0 | Public repo at [sparkjs.dev](https://sparkjs.dev/); `npm install && npm run build` must succeed |
| Playwright | Installed via Spark dependencies |
| GPU | NVIDIA + physical Chrome recommended (harness tuned for RTX-class laptops) |
| Remote asset | `.rad` URL with HTTP Range (206) support (default: Coit Tower 40M LOD) |
| Optional | `VRC_RAD_MANIFEST_CSV` — byte-range manifest for CDP ↔ chunk alignment |

---

## Quick start

### 1. Clone Spark and this artifact

```bash
git clone https://github.com/sparkjsdev/spark.git spark-dls-eval
git clone <ARTIFACT_REPO_URL> dls-artifact
```

Use the artifact URL provided in the paper (e.g. an Anonymous GitHub mirror).

### 2. Install overlay

```bash
bash dls-artifact/install_overlay.sh spark-dls-eval
cd spark-dls-eval
npm install
npm run build
```

This overwrites `src/SplatPager.ts` and `src/SparkRenderer.ts` in Spark and installs harness scripts under `scripts/ready_single_user/` and `scripts/lib/`.

### 3. Configure delivery URLs

Set environment variables (recommended) or edit `config/ready_single_user/experiment_matrix.json`:

```bash
# Remote object storage (main paper experiments)
export REMOTE_COS_URL="https://your-bucket.cos.ap-region.myqcloud.com/coit-40m-sh1-lod.rad"

# Optional: LAN edge (safety phase or local comparison)
export EDGE_SERVER_HOST="10.x.x.x"
export EDGE_ASSET_URL="http://${EDGE_SERVER_HOST}:8090/examples/streaming-lod/coit-40m-sh1-lod.rad"

# Public smoke-test asset (no author-specific bucket required):
# export REMOTE_COS_URL="https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/coit-40m-sh1-lod.rad"

# Chunk byte-range manifest (CDP alignment)
export VRC_RAD_MANIFEST_CSV="/path/to/rad_manifest.csv"
```

**Do not commit real COS URLs or lab IPs.** The repository uses placeholders; inject secrets at runtime via env vars.

### 4. Run an experiment batch

From the Spark repo root:

```bash
# Main result: burst_turn trace, n=5, Spark-OD vs DLS / DLS-L / DLS-A
node scripts/ready_single_user/run.mjs --phase=dls-main-burst-cos-n5 --trials=5

# Spark-OD vs DLS (K=4) only
node scripts/ready_single_user/run.mjs --phase=dls-main-burst-cos-n5 --trials=5 --methods=spark_od,dls

# Trace robustness (4 traces × 2 baselines × n=3)
node scripts/ready_single_user/run.mjs --phase=dls-trace-robustness-gated --trials=3

# Safety: gated DLS under low-latency / native COS conditions
node scripts/ready_single_user/run.mjs --phase=dls-safety-strict-gate --trials=3
```

Default output: `paper_materials/dls_eval_v1/runs/<phase>/`

Each trial produces:

- `per_trial_json/<trial_id>.json` — aggregated metrics
- `per_trial_runs/<trial_id>/cdp_network_audit.csv` — per-request CDP network audit
- `per_trial_runs/<trial_id>/` — Playwright trace, probe snapshots, etc.

### 5. Aggregate metrics (CSV only)

```bash
node scripts/ready_single_user/analyze.mjs \
  --batchDir=paper_materials/dls_eval_v1/runs/dls-main-burst-cos-n5
```

Writes `dls_summary.csv` with per-phase × baseline aggregates (first-visible, T1M, miss100, CDP net_p50, …).

---

## Baselines and runtime knobs

| baseline_id | Name | `window.__sparkSdlK` | Description |
|-------------|------|----------------------|-------------|
| `spark_od` | Spark-OD | 0 | Native Spark on-demand; no lookahead |
| `dls` | DLS | 4 | Paper configuration (gated lookahead) |
| `dls_l` | DLS-L | 2 | K ablation (shallow lookahead) |
| `dls_a` | DLS-A | 8 | K ablation (deep lookahead) |

The harness injects `window.__sparkSdlK` via Playwright `addInitScript` in `local_stutter_ablation_cell.mjs`. READY, Oracle, and proactive prefetch controllers are **not** used.

---

## Experiment phases

| Phase key | Description |
|-----------|-------------|
| `dls-main-burst-cos-n5` | Main result: remote COS, `burst_turn`, 5 trials × 4 baselines |
| `dls-trace-robustness-gated` | 4 camera traces, Spark-OD vs DLS, 3 trials each |
| `dls-safety-strict-gate` | `LAN-like` / `No-Throttle` profiles; gated DLS safety check |

---

## DLS implementation (summary)

See [`docs/DLS_MECHANISM.md`](docs/DLS_MECHANISM.md) for the full reference.

1. **Per-frame demand rebuild** (`SparkRenderer.ts`): rebuild `fetchPriority` from current frustum visibility; visible chunks at queue head.
2. **Strict-gate lookahead** (`SplatPager.driveFetchers()`): append up to K sequential chunks (c+1…c+K) at queue tail only when `activeFetchers === 0` and `fetchPriority.length === 0`.
3. **No demand preemption**: lookahead always at tail; in-flight lookahead can fill all 3 fetcher slots and delay new demand (DLS yield).
4. **Measurement**: chunk probe timestamps for demand/fetch/parse/upload; CDP records raw HTTP `download_ms` (net_p50).

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `No 206/rad activity` | Asset URL reachable and Range-capable; `curl -I` returns 206/200 |
| Empty CDP audit | `VRC_TRACE_CHROME` not set to `0`; Chrome launches successfully |
| Poor chunk alignment | Set `VRC_RAD_MANIFEST_CSV` |
| SwiftShader gate failure | Use physical GPU + non-headless Chrome |
| Port conflicts | Restart or kill stale Chrome / local proxy processes |

---

## Reproducing paper numbers

1. Match phase ID and trial count `n` from the paper tables.
2. Compare **within-batch** Spark-OD vs DLS deltas (absolute Q5 varies across days/sessions).
3. Gap decomposition and demand-timeline figures are derived offline in a separate writing repo; this artifact provides raw trial JSON + CDP CSV only.

---

## License

MIT — see [LICENSE](LICENSE). Spark is licensed separately by its upstream authors.
