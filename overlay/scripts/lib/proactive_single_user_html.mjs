/**
 * Build streaming-lod page with proactive delivery instrumentation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAblationHtml } from "./local_stutter_ablation_html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chunkProbe = readFileSync(path.join(__dirname, "proactive_chunk_probe.js"), "utf8");
const prefetchCtrl = readFileSync(path.join(__dirname, "proactive_prefetch_controller.js"), "utf8");

export async function buildProactiveSingleUserHtml({
  assetBase,
  assetUrl,
  baseline,
  prefetchBudgetBytes,
  label,
  warmupMs = 20000,
}) {
  let html = await buildAblationHtml({
    assetBase,
    assetUrl,
    ablationMode: "normal",
    pixelRatio: "1",
    label: label || baseline,
    startupMode: "steady_state",
  });

  const inject = `
${chunkProbe}
${prefetchCtrl}
    window.__proactiveRadUrl = ${JSON.stringify(assetUrl)};
`;
  html = html.replace(
    '<script type="module">',
    `<script type="module">\n${inject}`,
  );

  const q = new URL(`http://local/?${html.includes("?") ? "" : ""}`);
  q.searchParams.set("VRC_PROACTIVE", "1");
  q.searchParams.set("VRC_PROACTIVE_BASELINE", baseline.replace(/^B\d_/, "B").replace("_on_demand", "0").replace("on_demand", "0"));
  // Map B0_on_demand -> B0 etc
  const bMap = {
    B0_on_demand: "B0",
    B1_naive_prefetch: "B1",
    B2_priority_prefetch: "B2",
    B3_vrc_single: "B3",
    B4_oracle_prefetch: "B4",
  };
  const bCode = bMap[baseline] || "B0";
  const extraParams = [
    "VRC_PROACTIVE=1",
    `VRC_PROACTIVE_BASELINE=${bCode}`,
    `VRC_PREFETCH_BUDGET_BYTES=${prefetchBudgetBytes}`,
    `VRC_RAD_URL=${encodeURIComponent(assetUrl)}`,
    "ablation_mode=normal",
    "VRC_DIAG_MODE=normal",
    "pixel_ratio=1",
    "VRC_PIXEL_RATIO=1",
    "VRC_STARTUP_MODE=steady_state",
  ].join("&");

  if (html.includes("searchParams.set")) {
    html = html.replace(
      /searchParams\.set\([^)]+\);/g,
      (m, offset) => (offset > 0 ? m : m),
    );
  }
  html = html.replace(
    "const pageUrl = new URL(",
    `const pageUrl = new URL(`,
  );

  return { html, urlParams: extraParams, baselineCode: bCode };
}

export function appendProactiveParamsToPageUrl(pageUrlStr, baseline, assetUrl, budgetBytes) {
  const u = new URL(pageUrlStr);
  const bMap = {
    B0_on_demand: "B0",
    B1_naive_prefetch: "B1",
    B2_priority_prefetch: "B2",
    B3_vrc_single: "B3",
    B4_oracle_prefetch: "B4",
  };
  u.searchParams.set("VRC_PROACTIVE", "1");
  u.searchParams.set("VRC_PROACTIVE_BASELINE", bMap[baseline] || "B0");
  u.searchParams.set("VRC_PREFETCH_BUDGET_BYTES", String(budgetBytes));
  u.searchParams.set("VRC_RAD_URL", assetUrl);
  return u.toString();
}
