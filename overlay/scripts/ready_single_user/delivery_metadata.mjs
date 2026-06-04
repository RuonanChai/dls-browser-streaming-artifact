/** Delivery role normalization for trial JSON. */
export function normalizeDeliveryKey(raw) {
  const k = String(raw || "edge").trim();
  if (k === "local" || k === "local_disk") {
    return { storage_key: "local_disk", delivery_role: "local", display: "local" };
  }
  if (k === "edge" || k === "edge_server" || k === "origin_server") {
    return { storage_key: "edge_server", delivery_role: "edge", display: "edge" };
  }
  if (k === "remote" || k === "remote_server") {
    return { storage_key: "remote_server", delivery_role: "remote", display: "remote" };
  }
  if (k === "remote_cos" || k === "cos") {
    return { storage_key: "remote_cos", delivery_role: "remote", display: "remote_cos" };
  }
  return {
    storage_key: k,
    delivery_role: k.includes("remote") ? "remote" : k,
    display: k,
  };
}

export function buildDeliveryMetadata({
  requested_delivery_key,
  actual_delivery_key,
  delivery,
  asset_url,
  startup_mode,
  warmup_mode,
}) {
  const req = normalizeDeliveryKey(requested_delivery_key);
  const act = normalizeDeliveryKey(actual_delivery_key ?? requested_delivery_key);
  const role = act.delivery_role;
  return {
    delivery_role: role,
    requested_delivery: req.display,
    actual_delivery: act.display,
    requested_delivery_key: req.storage_key,
    actual_delivery_key: act.storage_key,
    server_url: delivery?.asset_base || (asset_url ? new URL(asset_url).origin : null),
    asset_url: asset_url ?? delivery?.asset_url ?? null,
    is_local: role === "local",
    is_lan_edge: role === "edge",
    is_remote: role === "remote",
    warmup_mode: warmup_mode ?? "none",
    startup_mode: startup_mode ?? "cold",
  };
}
