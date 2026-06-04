/**
 * Apply Chrome DevTools network shaping (best-effort on Windows).
 */
export const NETWORK_PROFILES = {
  "WAN-M": { rtt_ms: 40, bandwidth_mbps: 100 },
  "WAN-S": { rtt_ms: 80, bandwidth_mbps: 50 },
  "WAN-H": { rtt_ms: 150, bandwidth_mbps: 20 },
};

export async function applyNetworkProfile(cdpSession, profileId) {
  const p = NETWORK_PROFILES[profileId];
  if (!p || !cdpSession) return { applied: false, profileId };
  const throughput = Math.round((p.bandwidth_mbps * 125_000) / 8);
  try {
    await cdpSession.send("Network.enable");
    await cdpSession.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: p.rtt_ms,
      downloadThroughput: throughput,
      uploadThroughput: throughput,
      connectionType: "cellular3g",
    });
    return { applied: true, profileId, ...p };
  } catch (e) {
    return { applied: false, profileId, error: String(e?.message || e) };
  }
}
