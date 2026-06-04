/**
 * Off-main-thread Range fetch for proactive prefetch (loaded as blob URL).
 */
self.onmessage = async (e) => {
  const { id, url, range } = e.data || {};
  try {
    const res = await fetch(url, { headers: { Range: range } });
    const buf = await res.arrayBuffer();
    self.postMessage(
      { id, range, ok: true, status: res.status, bytes: buf.byteLength, buffer: buf },
      [buf],
    );
  } catch (err) {
    self.postMessage({ id, range, ok: false, error: String(err?.message || err) });
  }
};
