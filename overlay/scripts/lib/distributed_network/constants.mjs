/** Formal distributed diagnostic arms — do not change semantics. */
export const FORMAL_ARMS = {
  E3_normal_streaming: {
    experimentId: "E3",
    ablationMode: "normal",
    pixelRatio: "1",
    phasedMeasure: true,
    fullReplay: false,
    pureRenderPreload: false,
    defaultMeasurementMode: "streaming_in_loop_mode",
  },
  E4_normal_dpr05: {
    experimentId: "E4",
    ablationMode: "normal",
    pixelRatio: "0.5",
    phasedMeasure: true,
    fullReplay: false,
    pureRenderPreload: false,
    defaultMeasurementMode: "streaming_in_loop_mode",
  },
  E5_fetch_only: {
    experimentId: "E5",
    ablationMode: "fetch_only_full",
    pixelRatio: "auto",
    phasedMeasure: false,
    fullReplay: true,
    pureRenderPreload: false,
    defaultMeasurementMode: "streaming_in_loop_mode",
  },
  E7_upload_only: {
    experimentId: "E7",
    ablationMode: "upload_only",
    pixelRatio: "auto",
    phasedMeasure: true,
    fullReplay: false,
    pureRenderPreload: false,
    defaultMeasurementMode: "streaming_in_loop_mode",
  },
  E8_pure_render: {
    experimentId: "E8",
    ablationMode: "render_only_pure",
    pixelRatio: "auto",
    phasedMeasure: false,
    fullReplay: false,
    pureRenderPreload: true,
    defaultMeasurementMode: "warm_steady_render_mode",
  },
  E9_static_pure_render: {
    experimentId: "E9",
    ablationMode: "static_camera_render_only_pure",
    pixelRatio: "auto",
    phasedMeasure: false,
    fullReplay: false,
    pureRenderPreload: true,
    defaultMeasurementMode: "warm_steady_render_mode",
  },
  E10_moving_pure_render: {
    experimentId: "E10",
    ablationMode: "moving_camera_render_only_pure",
    pixelRatio: "auto",
    phasedMeasure: false,
    fullReplay: false,
    pureRenderPreload: true,
    defaultMeasurementMode: "warm_steady_render_mode",
  },
};

export const EXCLUDED_FROM_FORMAL_SUMMARY = new Set(["E0", "E2"]);

export function armCellSpec(armId, matrixOverrides = {}) {
  const arm = FORMAL_ARMS[armId];
  if (!arm) throw new Error(`Unknown formal arm: ${armId}`);
  return {
    experimentId: arm.experimentId,
    ablationMode: arm.ablationMode,
    pixelRatio: arm.pixelRatio,
    phasedMeasure: arm.phasedMeasure,
    fullReplay: arm.fullReplay,
    pureRenderPreload: arm.pureRenderPreload,
    measurementMode: matrixOverrides.measurementMode ?? arm.defaultMeasurementMode,
    warmupMs: matrixOverrides.warmupMs,
    moveMs: matrixOverrides.moveMs,
  };
}
