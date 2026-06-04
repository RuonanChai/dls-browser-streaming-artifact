/**
 * DLS evaluation artifact — baselines and output paths.
 */
export const PAPER_TITLE = "DLS: Demand Lookahead Scheduling for Browser 3DGS Streaming";
export const PAPER_MATERIALS_DIR = "paper_materials/dls_eval_v1";

export const DEFAULT_EDGE_URL =
  process.env.EDGE_ASSET_URL
  || `http://${process.env.EDGE_SERVER_HOST || "127.0.0.1"}:8090/examples/streaming-lod/coit-40m-sh1-lod.rad`;

export const DEFAULT_REMOTE_COS_URL =
  process.env.REMOTE_COS_URL
  || "https://example-bucket.cos.ap-region.myqcloud.com/coit-40m-sh1-lod.rad";

export const DEFAULT_REMOTE_CDN_URL =
  process.env.REMOTE_CDN_URL
  || "https://cdn.example.com/streaming-lod/coit-40m-sh1-lod.rad";

export const READY_EVENT_POLICY = "parse_or_upload";
export const DEFAULT_PREDICTION_HORIZON_MS = 2000;

export const DELIVERY_ROLE_BY_KEY = {
  local_disk: "local",
  local: "local",
  edge_server: "edge",
  edge: "edge",
  origin_server: "edge",
  remote_server: "remote",
  remote: "remote",
  remote_cos: "remote",
  cos: "remote",
};

export const PHASE_ALIASES = {
  "dls-trace-robustness": "dls-trace-robustness-gated",
  "dls-safety-gated": "dls-safety-strict-gate",
};

/** Spark-OD (K=0) and DLS variants only. */
export const BASELINES = {
  spark_od: {
    id: "spark_od",
    name: "Spark-OD",
    sdl_k: 0,
  },
  dls: {
    id: "dls",
    name: "DLS",
    sdl_k: 4,
  },
  dls_l: {
    id: "dls_l",
    name: "DLS-L",
    sdl_k: 2,
  },
  dls_a: {
    id: "dls_a",
    name: "DLS-A",
    sdl_k: 8,
  },
};

export const LEGACY_BASELINE_MAP = {};

export const DLS_PHASE_ORDER = [
  "dls-main-burst-cos-n5",
  "dls-trace-robustness-gated",
  "dls-safety-strict-gate",
];
