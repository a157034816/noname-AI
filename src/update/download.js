/**
 * @param {string} url
 * @param {{headers?: Record<string, string>}} [opts]
 * @returns {Promise<{ok:true, bytes:Uint8Array} | {ok:false, error:string, status?:number}>}
 */
export async function downloadToBytes(url, opts) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "bad url" };

  try {
    if (typeof fetch !== "function") return { ok: false, error: "fetch unavailable" };
    const headers = opts?.headers && typeof opts.headers === "object" ? opts.headers : undefined;
    const resp = await fetch(u, { method: "GET", headers });
    if (!resp.ok) return { ok: false, error: `http ${resp.status}`, status: resp.status };
    const ab = await resp.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(ab) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) || "unknown" };
  }
}
