#!/usr/bin/env node
/**
 * Synthetic unit test for fast_but_empty detector logic.
 * Spec: fast_but_empty = high FPS + low useful content + NO visible splats.
 * If visible splats are present, content IS rendering — not truly empty.
 */
function detectFastButEmpty({ measureFps, usefulBefore, demandedChunks, visibleSplatCount, frameCount }) {
  // Primary path: many frames rendered, low useful, AND no visible content
  const primaryPath =
    (frameCount ?? 0) > 30
    && usefulBefore < Math.max(3, demandedChunks * 0.05)
    && visibleSplatCount === 0;
  // Secondary path: extreme FPS with zero useful and zero visible
  const secondaryPath =
    measureFps > 120
    && usefulBefore === 0
    && demandedChunks > 0
    && visibleSplatCount === 0;
  return primaryPath || secondaryPath;
}

const cases = [
  {
    name: "synthetic_high_fps_empty_content",
    input: { measureFps: 144, usefulBefore: 0, demandedChunks: 12, visibleSplatCount: 0, frameCount: 0 },
    expect: true,
  },
  {
    name: "normal_streaming",
    input: { measureFps: 72, usefulBefore: 8, demandedChunks: 12, visibleSplatCount: 5000, frameCount: 60 },
    expect: false,
  },
  {
    name: "low_useful_but_visible_content",
    input: { measureFps: 90, usefulBefore: 1, demandedChunks: 40, visibleSplatCount: 100, frameCount: 45 },
    expect: false, // visible content present — NOT fast-but-empty
  },
  {
    name: "many_frames_no_visible_truly_empty",
    input: { measureFps: 90, usefulBefore: 1, demandedChunks: 40, visibleSplatCount: 0, frameCount: 45 },
    expect: true, // no visible content — truly fast-but-empty
  },
];

let failed = 0;
for (const c of cases) {
  const got = detectFastButEmpty(c.input);
  if (got !== c.expect) {
    console.error(`FAIL ${c.name}: got ${got}, expect ${c.expect}`);
    failed += 1;
  } else {
    console.log(`PASS ${c.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} synthetic test(s) failed`);
  process.exit(1);
}
console.log("\nAll fast_but_empty synthetic tests passed");
