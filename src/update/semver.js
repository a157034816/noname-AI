/**
 * 将 tag（如 v0.0.1）规范化为版本字符串（如 0.0.1）。
 *
 * @param {string} tag
 * @returns {string}
 */
export function normalizeTagToVersion(tag) {
  const raw = String(tag || "").trim();
  if (!raw) return "";
  if (raw.length >= 2 && (raw[0] === "v" || raw[0] === "V") && raw[1] >= "0" && raw[1] <= "9") {
    return raw.slice(1);
  }
  return raw;
}

/**
 * @param {string} version
 * @returns {{major:number, minor:number, patch:number} | null}
 */
export function parseSemver(version) {
  const v = String(version || "").trim();
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1|null}
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * @param {string} current
 * @param {string} latest
 * @returns {boolean|null} null 表示无法比较
 */
export function isLatestNewer(current, latest) {
  const c = compareSemver(current, latest);
  if (c === null) return null;
  return c === -1;
}

