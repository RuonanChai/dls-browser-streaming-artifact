# Baseline implementation parameters

Values below match `overlay/scripts/ready_single_user/constants.mjs` and `proactive_prefetch_controller.js` at artifact export time.

## Shared Spark substrate

| Parameter | Value |
|-----------|--------|
| Fetcher slots (`numFetchers`) | 3 |
| Viewport | 1280 × 720, pixel ratio 1.0 |
| Trace duration | 40 s (`move_ms=40000`) |
| Proactive byte budget (default) | 128 MB (remote trials capped to **40 MB** in runner) |
| Parse token bucket | 24 chunks/s |
| Default prediction horizon | 2000 ms |
| Proactive HTTP parallelism | maxParallel = 2 (separate from Spark fetchers) |

## Methods

### Spark-OD (`spark_od`, B0)

On-demand only. `__sparkSdlK=0`, `__sparkCoalesceK=1`, no proactive controller.

### Seq-P (`seq_pf`, B1)

One-shot at scene start: prefetch first **32** manifest chunks in byte order (Naive-PF path).

### PRoGS (`progs`, B2)

One-shot: rank all manifest entries by `progsScore`, prefetch top **40**.

### SGSS (`sgss`)

One-shot: rank by `viewScore` at current pose, prefetch top **36**.

### View-P (`view_pf`, failed-approaches batch)

Maps to **READY full** controller in code: boot set (≤**48** chunks on remote), motion prediction, **200 ms** rescheduling tick on remote, pre-decode enabled, multi-horizon prediction (1/2/4 s on remote). Paper text describes viewport extrapolation at 2 s; see code for full mechanism stack.

### Dec-A (`dec_ahead`, READY-DS)

Demand-frontier prefetch **+8** manifest chunks on each new demand; **pre-decode** on completed fetches; no boot set / no continuous viewport tick.

### Range-F (`range_fuse`)

Spark-OD + **`__sparkCoalesceK=4`** (merge up to 4 adjacent manifest chunks per Range request).

### DLS (`dls`)

Gated lookahead in `SplatPager.driveFetchers()`:

- `__sparkSdlK=4` (default main config)
- Gate opens only when `fetchPriority` empty **and** all fetcher slots idle
- Appends manifest indices `c+1…c+K` at **tail** of queue; visible demand rebuilt **at front** each frame
- No cancel of in-flight lookahead HTTP

Ablations: `dls_l` → K=2, `dls_a` → K=8.

## Camera traces (procedural)

Implemented in `overlay/scripts/ready_single_user/trace_replay.mjs`:

| Trace | Behavior |
|-------|----------|
| orbit | Radius 6 m, elevation 2.2 m, full rotation |
| stop_go | 2 s move / 2 s hold alternation |
| burst_turn | Periodic bursts (sin envelope) + faster angular sweep |
| random_walk | Deterministic pseudo-random heading changes |

## Metrics exported per trial

Written under `paper_materials/ready_single_user_v1/runs/<batch>/` by the runner:

- `per_trial_json/*.json` — Q5, T1M, FV, demanded, timelines
- `per_trial_runs/*/cdp_network_audit.csv` — CDP HTTP timing
- `per_trial_runs/*/summary/experiment_summary.json`

Aggregate tables: run `node scripts/ready_single_user/analyze.mjs --batchDir=...` (no figure generation).
