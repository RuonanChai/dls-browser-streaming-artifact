# Trial output layout

After `run.mjs` completes a phase:

```
paper_materials/ready_single_user_v1/runs/<phase>/
  manifest.json                 # trial list + status
  per_trial_json/
    <trial_id>.json             # aggregated metrics (q5s, t1m, fv, timelines, …)
  per_trial_runs/<trial_id>/
    cdp_network_audit.csv       # CDP Network.* events for .rad Range requests
    summary/
      experiment_summary.json
      probe_frame_times.json
    proactive_snapshot.json     # chunk state + demand trace (when proactive enabled)
```

Trial ID pattern: `{delivery}__{baseline}__{phase}__t{n}`.

Key JSON fields for paper tables:

- `q5s_med` path: max visible splats ≤ 5 s from navigation
- `first_visible_splat_ms` / `t1m_med`
- `demanded_med` — unique chunk fetches
- `net_p50_med` — CDP response median (distinct from fetch-stage wait in decomposition)

Do not commit large `paper_materials/` trees to the anonymous artifact repo.
