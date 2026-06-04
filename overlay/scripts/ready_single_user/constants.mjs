/**

 * READY single-user paper — baseline names and delivery roles.

 * User-facing: local | edge (LAN HPC edge) | remote (public CDN/storage).

 * Internal storage keys: local_disk | edge_server | remote_server (origin_server → edge_server).

 */



export const PAPER_TITLE =

  "READY: Readiness-Aware Delivery for Interactive 3D Gaussian Splatting";

/**
 * READY must beat each configured peer by at least this factor on primary axes.
 * 1.10 = 10% margin (lower-is-better: ready ≤ peer/1.10; higher-is-better: ready ≥ peer×1.10).
 */
export const READY_PEER_WIN_MARGIN = 1.1;



/** LAN edge server (same subnet as laptop). Formerly called origin_server in code. */

export const DEFAULT_EDGE_URL =

  "http://${EDGE_SERVER_HOST}:8090/examples/streaming-lod/coit-40m-sh1-lod.rad";



/** Public CDN (Cloudflare R2) — must match distributed_lab.json cdn_asset_base + coit path. */

export const DEFAULT_REMOTE_URL =

  "https://${REMOTE_CDN_URL}/coit-40m-sh1-lod.rad";



/** @deprecated Use DEFAULT_EDGE_URL — alias for legacy imports */

export const DEFAULT_ORIGIN_URL = DEFAULT_EDGE_URL;



export const REMOTE_PROFILE_ID = "cdn1_r2";

/** Google Cloud Storage — public remote object storage path. */
export const DEFAULT_GCS_URL =
  "https://${REMOTE_GCS_URL}/coit-40m-sh1-lod.rad";

export const GCS_PROFILE_ID = "cdn2_gcs";



/** Canonical endpoints for runbook / preflight (do not rename in reports). */

export const CANONICAL_ENDPOINTS = {

  edge_host: "${EDGE_SERVER_HOST}",

  edge_port: 8090,

  edge_asset_url: DEFAULT_EDGE_URL,

  remote_asset_url: DEFAULT_REMOTE_URL,

};

export const READY_EVENT_POLICY = "parse_or_upload";

export const DEFAULT_PREDICTION_HORIZON_MS = 2000;

export const PAPER_MATERIALS_DIR = "paper_materials/ready_single_user_v1";



export const DELIVERY_ROLE_BY_KEY = {

  local_disk: "local",

  local: "local",

  edge_server: "edge",

  edge: "edge",

  origin_server: "edge",

  remote_server: "remote",

  remote: "remote",

  remote_gcs: "remote",

  gcs: "remote",

};



/** Deprecated phase names → canonical phase (runner prints warning). */

export const PHASE_ALIASES = {

  phase_origin_control: "phase_edge_cold",

  phaseC_ablation: "phase_ready_ablation_on_edge",

  phaseB_mini: "phase_edge_cold",

  phaseB_main: "phase_edge_cold",

  phaseA_sanity: "phase_edge_cold",

  phaseD_network: "phase_edge_cold",

  phaseE_trace: "phase_edge_cold",

  phase_remote_direct: "phase_remote_direct_cold",

};



export const BASELINES = {

  spark_od: {

    id: "spark_od",

    name: "Spark-OD",

    proactive_baseline: "B0",

    ready_aware: false,

    use_oracle: false,

  },

  naive_pf: {

    id: "naive_pf",

    name: "Naive-PF",

    proactive_baseline: "B1",

    ready_aware: true,

    use_oracle: false,

  },

  progs: {

    id: "progs",

    name: "PRoGS",

    proactive_baseline: "B2",

    ready_aware: true,

    use_oracle: false,

  },

  sgss: {

    id: "sgss",

    name: "SGSS",

    proactive_baseline: "SGSS",

    ready_aware: true,

    use_oracle: false,

  },

  ready_p: {

    id: "ready_p",

    name: "READY-P",

    proactive_baseline: "READY-P",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "prediction_only",

  },

  ready_b: {

    id: "ready_b",

    name: "READY-B",

    proactive_baseline: "READY-B",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "boot_predecode_oneshot",

  },

  ready_c: {

    id: "ready_c",

    name: "READY-C",

    proactive_baseline: "READY-C",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "predict_continuous_no_predecode",

  },

  ready_r: {

    id: "ready_r",

    name: "READY-R",

    proactive_baseline: "READY-R",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "predict_predecode_oneshot",

  },

  ready_s: {

    id: "ready_s",

    name: "READY-S",

    proactive_baseline: "READY-S",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "ready_full_with_session_prior",

  },

  ready_e: {

    id: "ready_e",

    name: "READY-E",

    proactive_baseline: "READY-E",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "edge_delivery",

  },

  ready_g: {

    id: "ready_g",

    name: "READY-G",

    proactive_baseline: "READY-G",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "parse_gpu_scheduling",

  },

  ready: {

    id: "ready",

    name: "READY",

    proactive_baseline: "READY",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "full",

  },

  ready_ds: {

    id: "ready_ds",

    name: "READY-DS",

    proactive_baseline: "READY-DS",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "demand_safe",

  },

  coalesce_2: {

    id: "coalesce_2",

    name: "Coalesce-2",

    proactive_baseline: "B0",

    ready_aware: false,

    use_oracle: false,

    coalesce_k: 2,

  },

  coalesce_4: {

    id: "coalesce_4",

    name: "Coalesce-4",

    proactive_baseline: "B0",

    ready_aware: false,

    use_oracle: false,

    coalesce_k: 4,

  },

  sdl_2: {

    id: "sdl_2",

    name: "SDL-2",

    proactive_baseline: "B0",

    ready_aware: false,

    use_oracle: false,

    sdl_k: 2,

  },

  sdl_4: {

    id: "sdl_4",

    name: "SDL-4",

    proactive_baseline: "B0",

    ready_aware: false,

    use_oracle: false,

    sdl_k: 4,

  },

  sdl_8: {

    id: "sdl_8",

    name: "SDL-8",

    proactive_baseline: "B0",

    ready_aware: false,

    use_oracle: false,

    sdl_k: 8,

  },

  oracle: {

    id: "oracle",

    name: "Oracle",

    proactive_baseline: "Oracle",

    ready_aware: true,

    use_oracle: true,

    oracle_type: "perceptual_ready",

  },

  demand_oracle: {

    id: "demand_oracle",

    name: "Demand-Time Oracle",

    proactive_baseline: "DemandOracle",

    ready_aware: true,

    use_oracle: true,

    oracle_type: "demand_time",

  },

  oracle_predecode: {

    id: "oracle_predecode",

    name: "Upper Bound",

    proactive_baseline: "OraclePD",

    ready_aware: true,

    use_oracle: true,

    oracle_type: "perceptual_ready",

    predecode: true,

  },

  ready_v: {

    id: "ready_v",

    name: "READY-V",

    proactive_baseline: "READY-V",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "legacy_view",

  },

  ready_i: {

    id: "ready_i",

    name: "READY-I",

    proactive_baseline: "READY-I",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "legacy_parse_gpu",

  },

  ready_d: {

    id: "ready_d",

    name: "READY-D",

    proactive_baseline: "READY-D",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "legacy_delivery",

  },

  ready_b: {

    id: "ready_b",

    name: "READY-B",

    proactive_baseline: "READY-B",

    ready_aware: true,

    use_oracle: false,

    ready_variant: "boot_predecode_oneshot",

  },

  // ===== Paper-facing baselines (DLS paper) =====

  dls: {
    id: "dls",
    name: "DLS",
    proactive_baseline: "B0",
    ready_aware: false,
    use_oracle: false,
    sdl_k: 4,
  },

  dls_l: {
    id: "dls_l",
    name: "DLS-L",
    proactive_baseline: "B0",
    ready_aware: false,
    use_oracle: false,
    sdl_k: 2,
  },

  dls_a: {
    id: "dls_a",
    name: "DLS-A",
    proactive_baseline: "B0",
    ready_aware: false,
    use_oracle: false,
    sdl_k: 8,
  },

  seq_pf: {
    id: "seq_pf",
    name: "Seq-P",
    proactive_baseline: "B1",
    ready_aware: true,
    use_oracle: false,
  },

  view_pf: {
    id: "view_pf",
    name: "View-P",
    proactive_baseline: "READY",
    ready_aware: true,
    use_oracle: false,
    ready_variant: "full",
  },

  dec_ahead: {
    id: "dec_ahead",
    name: "Dec-A",
    proactive_baseline: "READY-DS",
    ready_aware: true,
    use_oracle: false,
    ready_variant: "demand_safe",
  },

  range_fuse: {
    id: "range_fuse",
    name: "Range-F",
    proactive_baseline: "B0",
    ready_aware: false,
    use_oracle: false,
    coalesce_k: 4,
  },

};



export const LEGACY_BASELINE_MAP = {

  B0_on_demand: "spark_od",

  B3_ready: "ready",

  B4_ready_oracle: "oracle",

  vrc: "ready",

  vrc_p: "ready_p",

  vrc_e: "ready_e",

  vrc_g: "ready_g",

  vrc_v: "ready_v",

  vrc_i: "ready_i",

  vrc_d: "ready_d",

  vrc_b: "ready_b",

  ready_e: "ready_e",

  ready_g: "ready_g",

};


