/** Classify manifest entries for edge warm-up targets. */
export function classifyWarmupTargets(manifest) {
  const sorted = [...manifest].sort((a, b) => {
    const sa = Number(String(a.range || "").match(/bytes=(\d+)/)?.[1] || 0);
    const sb = Number(String(b.range || "").match(/bytes=(\d+)/)?.[1] || 0);
    return sa - sb;
  });
  return sorted
    .map((ent, idx) => {
      const start = Number(String(ent.range || "").match(/bytes=(\d+)/)?.[1] || 0);
      const bytes = ent.encoded_bytes || 65536;
      const warmed_first_screen = start < 262144;
      const warmed_base = start < 1048576 || bytes <= 49152;
      const warmed_hot = warmed_first_screen || idx < 12;
      return {
        range: ent.range,
        url: ent.url,
        warmed_first_screen,
        warmed_base,
        warmed_hot,
        warmed_by_ready: true,
      };
    })
    .filter((t) => t.warmed_first_screen || t.warmed_base || t.warmed_hot)
    .slice(0, 24);
}
