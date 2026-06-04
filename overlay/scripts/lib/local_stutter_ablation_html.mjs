/**
 * Build ablation-patched streaming-lod index.html (v2 instrumentation).
 */
import fs from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const probeJs = readFileSync(path.join(__dirname, "ablation_page_probe.js"), "utf8");
const startupJs = readFileSync(path.join(__dirname, "ablation_startup_timeline.js"), "utf8");
const vrcOptJs = readFileSync(path.join(__dirname, "vrc_opt_runtime.js"), "utf8");
const proactiveChunkProbeJs = readFileSync(path.join(__dirname, "proactive_chunk_probe.js"), "utf8");
const readyModuleNames = [
  "ready_core.js",
  "ready_prediction.js",
  "ready_readiness.js",
  "ready_delivery.js",
  "ready_schedulers.js",
  "ready_controller.js",
];
const readyModulesJs = readyModuleNames
  .map((f) => readFileSync(path.join(__dirname, "ready", f), "utf8"))
  .join("\n");
const proactivePrefetchJs = readFileSync(path.join(__dirname, "proactive_prefetch_controller.js"), "utf8");
const proactiveWorkerJs = readFileSync(path.join(__dirname, "proactive_prefetch_worker.js"), "utf8");

function applyDiagnosticImportMap(html) {
  const THREE_LOCAL = "/node_modules/three/build/three.module.js";
  const LIL_LOCAL = "/node_modules/lil-gui/dist/lil-gui.esm.js";
  const sparkLocal = existsSync(path.join(projectRoot, "dist", "spark.module.js"));
  const SPARK = sparkLocal
    ? "/dist/spark.module.js"
    : "https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.0.0/dist/spark.module.js";
  let h = html;
  h = h.replace(
    /"three"\s*:\s*"\.\.\/js\/vendor\/three\/build\/three\.module\.js"/,
    `"three": "${THREE_LOCAL}"`,
  );
  h = h.replace(
    /"lil-gui"\s*:\s*"\/examples\/js\/vendor\/lil-gui\/dist\/lil-gui\.esm\.js"/,
    `"lil-gui": "${LIL_LOCAL}"`,
  );
  h = h.replace(
    /"@sparkjsdev\/spark"\s*:\s*"\.\.\/\.\.\/dist\/spark\.module\.js"/,
    `"@sparkjsdev/spark": "${SPARK}"`,
  );
  return h;
}

export async function buildAblationHtml({
  assetBase,
  assetUrl,
  ablationMode,
  pixelRatio,
  label,
  startupMode = "steady_state",
  proactiveBaselineCode = null,
  prefetchBudgetBytes = 512 * 1024 * 1024,
}) {
  const orig = path.join(projectRoot, "examples", "streaming-lod", "index.html");
  let html = await fs.readFile(orig, "utf8");
  const localRadUrl = assetUrl || `${assetBase}/examples/streaming-lod/coit-40m-sh1-lod.rad`;

  html = applyDiagnosticImportMap(html);
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>Ablation · ${label || ablationMode}</title>`,
  );
  // Hide the overlay (title/subtitle) so it doesn't appear in screenshots
  html = html.replace(
    '.overlay {',
    '.overlay { display: none !important; ',
  );
  // Replace the coit GCS URL if present (older index.html versions)
  html = html.replace(
    /url:\s*"https:\/\/storage\.googleapis\.com\/forge-dev-public\/asundqui\/rad\/260217\/coit-40m-sh1-lod\.rad"/,
    `url: "${localRadUrl}"`,
  );

  const localRadUrlPatch = `
    function localRadUrl(relativePath) {
      const rel = String(relativePath || "").replace(/^\\//, "");
      const base = ${JSON.stringify(String(assetBase || "").replace(/\/$/, ""))};
      const fullUrl = ${JSON.stringify(String(assetUrl || ""))};
      if (fullUrl && /coit-40m-sh1-lod\\.rad$/.test(rel)) return fullUrl;
      if (!base) return relativePath;
      return rel.startsWith("examples/") ? base + "/" + rel : base + "/examples/" + rel;
    }`;
  html = html.replace(
    /function localRadUrl\(relativePath\)\s*\{[\s\S]*?return `http:\/\/\$\{host\}:\$\{port\}\/\$\{rel\}`;\s*\}/,
    localRadUrlPatch,
  );

  const pixelRatioCode =
    pixelRatio === "auto"
      ? "highDpi ? window.devicePixelRatio : 1"
      : pixelRatio === "0.5"
        ? "0.5"
        : "1";

  html = html.replace(
    "renderer.setPixelRatio(highDpi ? window.devicePixelRatio : 1);",
    `renderer.setPixelRatio(${pixelRatioCode});`,
  );

  const proactiveWrap = proactiveBaselineCode
    ? `
${proactiveChunkProbeJs}
${readyModulesJs}
(function(){try{window.__proactivePrefetchWorkerUrl=URL.createObjectURL(new Blob([${JSON.stringify(proactiveWorkerJs)}],{type:"application/javascript"}));}catch(e){console.warn("prefetch worker blob",e);}})();
${proactivePrefetchJs}
`
    : "";

  const ablationWrap = `
${probeJs}
${startupJs}
${vrcOptJs}
${proactiveWrap}

    window.__stutterDiag = {
      frame_times: [],
      measure_frame_times: [],
      preload_frame_times: [],
      long_frame_count: 0,
      jank_frames_over_33ms: 0,
      jank_frames_over_50ms: 0,
      measure_jank_33: 0,
      measure_jank_100: 0,
      splat_mesh_ready: false,
    };
`;

  html = html.replace('<script type="module">', `<script type="module">\n${ablationWrap}`);

  html = html.replace(
    "scene.add(spark);",
    "scene.add(spark);\n    window.__slDiagSpark = spark;\n    window.__slDiagRenderer = renderer;\n    window.__vrcOptInit?.(renderer, spark);",
  );

  html = html.replace(
    "world = new SplatMesh({ url, paged: true });",
    `world = new SplatMesh({ url, paged: true });
      window.__ablationPatchWorld?.(world);`,
  );

  html = html.replace("scene.add(world);", `if (world) scene.add(world);`);

  const origLoop = `    renderer.setAnimationLoop(function animate(time) {
      if (tracePlayer) tracePlayer.update();
      else if (controls) controls.update(camera);
      renderer.render(scene, camera);
    });`;

  const patchedLoop = `    let __lastRaf = performance.now();
    let __uploadFrameSkip = 0;
    renderer.setAnimationLoop(function animate(time) {
      const __now = performance.now();
      const __dt = __now - __lastRaf;
      __lastRaf = __now;
      const __m = window.__vrcAblation.mode;
      const __phase = window.__vrcAblation.phase || 'preload';
      const __pureRender = ['render_only','render_only_pure','static_camera_render_only','static_camera_render_only_pure','moving_camera_render_only','moving_camera_render_only_pure','render_plus_camera_only','render_plus_visibility_only','render_plus_lod_update_only'].includes(__m);
      const __staticCam = __m === 'static_camera_render_only' || __m === 'static_camera_render_only_pure' || __m === 'render_plus_lod_update_only';
      const __movingOnly = (__pureRender && !__staticCam) || __m === 'render_plus_camera_only';
      const __diagNoNet = __pureRender || __m === 'normal_fixed_lod';
      const __noFetchRender = ['fetch_only','fetch_only_full','parse_only'].includes(__m);
      const __parseOnlyFull = __m === 'parse_only_full';
      if (tracePlayer) tracePlayer.update();
      else if (controls && !__staticCam && (__movingOnly || __m === 'normal' || __m === 'normal_fixed_lod' || __m === 'fetch_only_full' || __m === 'parse_only_full' || __m === 'upload_only')) controls.update(camera);
      window.__vrcOptTick?.(__now);
      const __skipRender = window.__vrcAblation.disableRender || __noFetchRender;
      const __uploadThrottle = __m === 'upload_only' && ((__uploadFrameSkip++) % 30 !== 0);
      const __d = window.__stutterDiag;
      const __fts = __phase === 'measure' ? (__d.measure_frame_times || __d.frame_times) : (__d.preload_frame_times || __d.frame_times);
      if (__dt > 0 && __dt < 2000) {
        __fts.push(__dt);
        if (__fts.length > 1200) __fts.shift();
        if (__phase === 'measure') {
          if (__dt > 33.33) { __d.measure_jank_33 = (__d.measure_jank_33 || 0) + 1; __d.jank_frames_over_33ms += 1; }
          if (__dt > 100) { __d.measure_jank_100 = (__d.measure_jank_100 || 0) + 1; __d.long_frame_count += 1; }
        } else {
          if (__dt > 33.33) __d.jank_frames_over_33ms += 1;
          if (__dt > 50) __d.jank_frames_over_50ms += 1;
          if (__dt > 100) __d.long_frame_count += 1;
        }
      }
      if (!__skipRender && !__uploadThrottle) {
        const __callsBefore = renderer.info.render.calls;
        const __rt0 = performance.now();
        renderer.render(scene, camera);
        const __rdt = performance.now() - __rt0;
        const __probePh = window.__ablationProbe?.metrics?.[__phase];
        if (__probePh) __probePh.renderer_render_call_ms.push(__rdt);
        if (__phase === 'measure') {
          const __dcDelta = renderer.info.render.calls - __callsBefore;
          window.__ablationProbe?.recordDrawCalls?.(__dcDelta);
          const __spark = window.__slDiagSpark;
          if (__spark) {
            const __lod = __spark.lodSplatCount ?? 0;
            const __rendered = Math.round(__lod * (__spark.lodSplatScale ?? 0));
            window.__ablationProbe?.recordRenderedSplats?.(__rendered);
          }
        }
      }
    });`;

  if (!html.includes(origLoop)) throw new Error("ablation: animation loop anchor missing");
  html = html.replace(origLoop, patchedLoop);

  const selectWorldHook = `
    window.__ablationPatchWorld = function(w) {
      const pager = w?.paged?.pager;
      if (!pager) return;
      const m = window.__vrcAblation.mode;
      if (window.__vrcAblation.disableLod && typeof pager.driveFetchers === 'function') {
        pager.driveFetchers = function() {};
      }
      if (m === 'parse_only' || window.__vrcAblation.disableGpuUpload) {
        pager.processUploads = function() {};
      } else if (m === 'parse_only_full') {
        pager.processUploads = function drainUploadsNoGpu() {
          while (this.readyUploads.length) this.readyUploads.shift();
        };
      }
    };
    const __origSelectWorld = selectWorld;
    selectWorld = async function(worldKey) {
      if (world) {
        scene.remove(world);
        world.dispose();
        world = null;
      }
      const def = worlds[worldKey];
      const { url, quaternion, position, scale, background, description, cameraPosition, cameraQuaternion, lodSplatScale, highDpi } = def;
      if (window.__vrcAblation.mode === 'fetch_only_full') {
        scene.background = new THREE.Color(background);
        camera.position.set(...(cameraPosition ?? [0, 0, 0]));
        camera.quaternion.set(...(cameraQuaternion ?? [0, 0, 0, 1])).normalize();
        title.textContent = worldKey + ' [fetch_only_full]';
        subtitle.textContent = description;
        spark.lodSplatScale = lodSplatScale ?? 1.0;
        renderer.setPixelRatio(${pixelRatioCode});
        onWindowResize();
        await window.__ablationReplayFetchManifest(url);
        window.__stutterDiag.splat_mesh_ready = true;
        return;
      }
      __origSelectWorld(worldKey);
      if (world) {
        window.__stutterDiag.splat_mesh_ready = true;
        window.__vrcAblation.baseLodSplatScale = spark.lodSplatScale ?? lodSplatScale ?? 1.5;
        window.__vrcAblation.basePixelRatio = renderer.getPixelRatio?.() ?? 1;
        window.__ablationPatchWorld(world);
        window.__vrcOptInit?.(renderer, spark);
      }
    };
  `;
  html = html.replace("selectWorld(settings.worldKey);", `${selectWorldHook}\n    selectWorld(settings.worldKey);`);

  const cacheDir = path.join(projectRoot, ".diag-cache", "ablation");
  const assetBaseTag = String(assetBase || "no-base")
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
  const assetUrlTag = assetUrl
    ? "u" + String(assetUrl).split("").reduce((h, c) => ((h * 33) ^ c.charCodeAt(0)) >>> 0, 5381).toString(36)
    : "ub0";
  const outFile = path.join(cacheDir, `ablation-v2-${ablationMode}-${pixelRatio}-${assetBaseTag}-${assetUrlTag}.html`);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, html, "utf8");
  return { outFile, localRadUrl };
}
