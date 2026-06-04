/**
 * Proactive single-user v2 baselines (ready-aware VRC-Single).
 *
 * Codes B3R / B4R activate ready-cache mode in the page-side controller
 * (proactive_prefetch_controller.js): on Worker fetch_complete the controller
 * also fires noteParseComplete(cid) so chunk_ready_time advances to
 * "parse complete" (audit annotation: ready_event=parse_only).
 *
 * v2 fixes the v1 cid-mismatch bug: notePrefetchStart / noteFetchComplete are
 * now called with full ${url}::${range} cid so they collide correctly with
 * demand-side noteDemand cids — pre-parse can finally count as "useful before
 * demand".
 */

export const BASELINES = {
  B0_on_demand: {
    id: "B0_on_demand",
    label: "B0 On-demand",
    ablation_mode: "normal",
    proactive_baseline: "B0",
    use_oracle: false,
    ready_aware: false,
  },
  B3_ready: {
    id: "B3_ready",
    label: "B3-ready (VRC-Single v2)",
    ablation_mode: "normal",
    proactive_baseline: "B3R",
    use_oracle: false,
    ready_aware: true,
  },
  B4_ready_oracle: {
    id: "B4_ready_oracle",
    label: "B4-ready-oracle (upper bound)",
    ablation_mode: "normal",
    proactive_baseline: "B4R",
    use_oracle: true,
    ready_aware: true,
  },
};

export const DEFAULT_ORIGIN_URL =
  "http://${EDGE_SERVER_HOST}:8090/examples/streaming-lod/coit-40m-sh1-lod.rad";

export const REMOTE_PROFILE_ID = "cdn1_r2";

export const READY_EVENT_POLICY = "parse_or_upload";
export const DEFAULT_PREDICTION_HORIZON_MS = 2000;
