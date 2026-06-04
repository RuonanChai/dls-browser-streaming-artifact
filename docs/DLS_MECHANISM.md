# DLS Mechanism Reference

This document describes **Demand Lookahead Scheduling (DLS)** as implemented in this artifact: how Spark 2.0 browser streaming uses idle fetcher slots to prefetch upcoming chunks **without preempting** visible demand for the current frame.

---

## 1. Problem background

**Spark-OD** (on-demand) issues HTTP Range requests only for **currently visible** LOD chunks each frame. Under fast camera motion, fetch → parse → GPU upload starts after a chunk becomes visible, so first-frame quality and ramp-up are limited by **critical-path network wait**.

**DLS** appends up to K **sequential** lookahead chunks at the **tail** of the fetch queue during moments when fetchers are idle and no demand is pending. The key constraint is the **strict gate**: lookahead must never compete with normal demand for fetcher slots.

---

## 2. Code map

| Component | File | Role |
|-----------|------|------|
| Queue rebuild | `src/SparkRenderer.ts` | Rebuild `pager.fetchPriority` each frame from frustum/LOD |
| Schedule + gate | `src/SplatPager.ts` → `driveFetchers()` | Lookahead enqueue, start fetchers, completion callbacks |
| Runtime K | `window.__sparkSdlK` | 0 = Spark-OD; 4 = paper DLS |
| Trial injection | `scripts/lib/local_stutter_ablation_cell.mjs` | Playwright `addInitScript` sets `__sparkSdlK` |
| Chunk timeline | `scripts/lib/proactive_chunk_probe.js` | Records demand/fetch/parse/upload events |
| Network audit | `vrc-paper/experiments/cdp_network_audit.mjs` | Per-request timing (incl. `download_ms`) |

---

## 3. Data structures

### 3.1 `fetchPriority`

```typescript
fetchPriority: { splats: PagedSplats; chunk: number }[]
```

Ordered list; **index 0 is highest priority**. `driveFetchers()` walks from the head and starts fetchers for entries not yet in-flight, up to `numFetchers` parallel HTTP fetchers (Spark default: 3).

### 3.2 Runtime knobs

```javascript
window.__sparkSdlK = 4;   // lookahead depth K
window.__sdlStats = {     // optional diagnostics
  lookahead_enqueued, lookahead_gated_off, drive_calls, ...
};
```

Harness injection by baseline:

| baseline | `sdl_k` |
|----------|---------|
| spark_od | 0 |
| dls | 4 |
| dls_l | 2 |
| dls_a | 8 |

---

## 4. Per-frame demand path (SparkRenderer)

Each render frame (simplified):

1. Walk paged splat meshes; collect **visible** chunks → build a new `fetchPriority`.
2. Call `pager.driveFetchers()`.

**Important:** `fetchPriority` is **fully replaced** each frame, not incrementally updated. Therefore:

- All visible demand for the current frame sits at the queue head.
- Lookahead enqueued on a prior frame is dropped if those chunks are no longer visible (possible waste; counted in `__sdlStats.lookahead_wasted`).

---

## 5. `driveFetchers()` algorithm (SplatPager)

### 5.1 Phase A — Gated lookahead enqueue

When `sdlK > 0`:

```
normalDemandCount = fetchPriority.length
activeFetchers    = fetchers.length   // started but not finished
pipelineIdle      = (activeFetchers === 0) AND (normalDemandCount === 0)
```

**Strict gate:** append lookahead only when `pipelineIdle === true`.

When idle, for each `{splats, chunk}` context, extend with chunks `c+1 … c+K`:

- Read byte ranges from RAD metadata.
- Skip chunks already loaded, queued, or in-flight.
- **`push` new entries to the tail** of `fetchPriority`.
- Total bounded by `min(sdlK, availableSlots)`.

When the gate is closed (pending demand or in-flight fetches):

- No lookahead is appended.
- `__sdlStats.lookahead_gated_off++`.

### 5.2 Phase B — Start fetchers

Scan `fetchPriority` in order:

- For each `{splats, chunk}` not loaded and not in-flight, create a fetcher.
- Stop when in-flight count reaches `numFetchers` or the queue is exhausted.

Fetcher completion callbacks call `driveFetchers()` again to refill slots from the queue head.

### 5.3 Priority semantics

| Type | Queue position | Preemption |
|------|----------------|------------|
| Visible demand | Head (rebuilt each frame) | — |
| Lookahead | Tail (after gate passes) | Never preempts demand |

---

## 6. Yield and in-flight lookahead

Fetcher parallelism is fixed at 3. If the gate opens and K=4 lookahead entries are enqueued, three start immediately and one waits. On the **next frame**, new visible demand rebuilds `fetchPriority` at the head, but **in-flight lookahead fetches cannot be cancelled**. New demand must wait for a slot → **DLS yield**.

Cases where DLS latency exceeds Spark-OD usually come from this mechanism, not from a broken gate.

---

## 7. Spark-OD baseline (K=0)

When `sdlK === 0`, `driveFetchers()` skips the entire lookahead branch and behaves like unpatched Spark on-demand (serve only visible chunks in `fetchPriority`).

---

## 8. Measurement harness flow

```
run.mjs
  └─ expandTrials(experiment_matrix)
  └─ trial_cell.mjs
       └─ runAblationCell (Playwright)
            ├─ addInitScript: __sparkSdlK
            ├─ ablation HTML + chunk probe + CDP auditor
            ├─ trace_replay (orbit / burst_turn / …)
            └─ writes cdp_network_audit.csv + probe snapshot
       └─ cdp_enrich.mjs: align CDP with chunk_states
       └─ per_trial_json/*.json
analyze.mjs → dls_summary.csv
```

### 8.1 Key metrics (trial JSON)

| Field | Meaning |
|-------|---------|
| `first_visible_splat_ms` | Cold start → first visible splat |
| `time_to_1M_visible_splats_ms` | Time to 1M visible splats |
| `miss100` / `miss50` | Fraction of chunks ready after demand (100ms / 50ms deadline) |
| `cdp_net_p50_ms` | CDP HTTP `download_ms` p50 (raw network, excludes queuing) |
| `fetch_p50_ms` | Same as above, or chunk_state delta fallback |
| `blank_ratio` | Fraction of time with zero visible splats |

### 8.2 Metric terminology (figure scripts live elsewhere)

- **~809 ms `T_fetch`**: demand-anchored fetch-complete median (includes fetcher queuing).
- **~189 ms `net_p50`**: CDP per-request `download_ms` p50.
- Bar-segment medians do not sum to FV/T1M; remote upload median can be lower than edge.

This artifact does **not** include gap-decomposition or demand-timeline plotting; only raw trial JSON + CDP CSV.

---

## 9. Experiment matrix (in this artifact)

`config/ready_single_user/experiment_matrix.json` contains:

- **Baselines:** `spark_od`, `dls`, `dls_l`, `dls_a`
- **Phases:** `dls-main-burst-cos-n5`, `dls-trace-robustness-gated`, `dls-safety-strict-gate`
- **Delivery:** default `remote_cos` via env var `REMOTE_COS_URL`

No PRoGS, SGSS, READY, Oracle, or failed-approaches phases.

---

## 10. Boundary vs READY / proactive prefetch

This artifact **deliberately excludes**:

- `proactive_prefetch_controller.js` and the READY module stack
- Oracle demand traces and reference generation
- `generate_paper_reports.mjs` and markdown/HTML report synthesis

`proactive_chunk_probe.js` keeps a historical filename; here it is a **chunk-level timing probe only** and does not drive any proactive download policy.

---

## 11. Reproduction checklist

1. After `npm run build`, confirm `dist/spark.module.js` contains the DLS gate in `driveFetchers`.
2. Smoke test: `run.mjs --phase=dls-main-burst-cos-n5 --trials=1 --methods=spark_od,dls`
3. Verify `sdl_k` in `per_trial_json` matches the baseline.
4. Verify `cdp_rad_206_count >= 3` and `hard_gate_passed: true`.
5. Compare Spark-OD vs DLS **within the same batch** for `first_visible_splat_ms` / `miss100` (absolute values vary across days; deltas matter).
