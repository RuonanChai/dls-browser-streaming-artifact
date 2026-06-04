/**
 * Deterministic camera traces for Phase E robustness.
 */
export async function replayCameraTrace(page, mode, durationMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < durationMs) {
    const elapsed = Date.now() - t0;
    const p = elapsed / durationMs;
    await page.evaluate(
      ({ mode: m, p: phase, elapsed: el }) => {
        const c = window.__slDiagCam;
        if (!c) return;
        const r = 6;
        let x = 0;
        let y = 2.2;
        let z = -1.1;
        if (m === "orbit") {
          const a = phase * Math.PI * 2;
          x = Math.sin(a) * r;
          y = 2.2 + Math.sin(a * 0.5) * 0.5;
          z = Math.cos(a) * r - 1.1;
        } else if (m === "stop_go") {
          const seg = Math.floor(el / 2000) % 2;
          const a = phase * Math.PI * 2;
          if (seg === 0) {
            x = Math.sin(a) * r;
            z = Math.cos(a) * r - 1.1;
          } else {
            x = Math.sin(a * 0.1) * r * 0.2;
            z = Math.cos(a * 0.1) * r * 0.2 - 1.1;
          }
        } else if (m === "burst_turn") {
          const burst = Math.sin(phase * Math.PI * 8) > 0.3 ? 1 : 0.15;
          const a = phase * Math.PI * 4;
          x = Math.sin(a) * r * burst;
          z = Math.cos(a) * r * burst - 1.1;
        } else if (m === "random_walk") {
          const seed = Math.sin(el * 0.0013) * 10000;
          const a = (seed - Math.floor(seed)) * Math.PI * 2;
          x = Math.sin(a) * r * (0.5 + (seed % 1) * 0.5);
          z = Math.cos(a * 1.3) * r - 1.1;
        }
        c.position.set(x, y, z);
        c.lookAt(0, 0, 0);
        c.updateMatrixWorld(true);
      },
      { mode, p, elapsed },
    );
    await new Promise((r) => setTimeout(r, 80));
  }
}
