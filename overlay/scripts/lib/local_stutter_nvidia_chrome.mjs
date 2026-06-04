/** Shared headed NVIDIA Chrome launch args for local ablation batches. */
export const NVIDIA_CHROME_ARGS = [
  "--disable-dev-shm-usage",
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--force-high-performance-gpu",
  "--use-angle=d3d11",
  "--disable-software-rasterizer",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-web-security",
  "--allow-running-insecure-content",
  "--no-proxy-server",
];

export const NVIDIA_CHROMIUM_LAUNCH = {
  headless: false,
  args: NVIDIA_CHROME_ARGS,
  ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
};
