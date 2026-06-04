# Experiment batches (DLS paper)

All batches use **Coit Tower 40M** `.rad` LOD asset, **1280×720** viewport, **40 s** camera trace, **cold start** (empty cache, fresh browser profile), **interleaved** trial order unless noted.

| Batch ID | n | Trace(s) | Methods | Purpose |
|----------|---|----------|---------|---------|
| `spark-3scenario-local-edge-cos` | 3 | orbit | spark_od | §2 motivation table (local / edge / remote) |
| `gap-decomposition-cos-n5` | 5 | orbit | spark_od | Per-chunk critical-path decomposition |
| `failed-approaches-cos-n5` | 5 | orbit | spark_od, seq_pf, view_pf, dec_ahead, range_fuse | §3 failed optimizations |
| `dls-main-burst-cos-n5` | 5 | burst_turn | spark_od, progs, sgss, dls, dls_l, dls_a | Main result + K ablation |
| `dls-trace-robustness-gated` | 3 | orbit, stop_go, burst_turn, random_walk | spark_od, dls | Trace robustness |
| `dls-safety-strict-gate` | 3 | burst_turn | spark_od, dls | Safety (LAN-like 20 ms RTT vs native COS) |

Network profiles for safety batch:

- `LAN-like`: RTT 20 ms, 500 Mbps (CDP throttle)
- `No-Throttle`: native path to configured remote object storage

See `docs/BASELINES.md` for per-method parameters.
