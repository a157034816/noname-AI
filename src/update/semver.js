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

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * @param {string} version
 * @returns {{major:number, minor:number, patch:number, prerelease:string, prereleaseIdentifiers:Array<string|number>} | null}
 */
export function parseSemver(version) {
  const v = normalizeTagToVersion(version);
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  const prerelease = String(m[4] || "").trim();
  return {
    major,
    minor,
    patch,
    prerelease,
    prereleaseIdentifiers: prerelease ? prerelease.split(".").map(parsePrereleaseIdentifier) : [],
  };
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
  if (!pa.prerelease && !pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;

  const len = Math.max(pa.prereleaseIdentifiers.length, pb.prereleaseIdentifiers.length);
  for (let i = 0; i < len; i++) {
    const aa = pa.prereleaseIdentifiers[i];
    const bb = pb.prereleaseIdentifiers[i];
    if (aa === undefined) return -1;
    if (bb === undefined) return 1;
    if (aa === bb) continue;

    const aNum = typeof aa === "number";
    const bNum = typeof bb === "number";
    if (aNum && bNum) return aa < bb ? -1 : 1;
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    const as = String(aa);
    const bs = String(bb);
    if (as === bs) continue;
    return as < bs ? -1 : 1;
  }
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

/**
 * @param {string} version
 * @returns {{prNumber:string, runNumber:string}|null}
 */
export function extractPrBuildInfo(version) {
  const parsed = parseSemver(version);
  if (!parsed || !parsed.prerelease) return null;
  const match = /^pr\.(\d+)\.(\d+)$/.exec(parsed.prerelease);
  if (!match) return null;
  return { prNumber: match[1], runNumber: match[2] };
}

/**
 * @param {string} token
 * @returns {string|number}
 */
function parsePrereleaseIdentifier(token) {
  const raw = String(token || "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}
