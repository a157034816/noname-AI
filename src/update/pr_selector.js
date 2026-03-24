import { fetchOpenPullRequests, fetchReleases } from "./github.js";
import { compareSemver, extractPrBuildInfo } from "./semver.js";
import { normalizeUpdatePrNumber } from "./settings.js";

/**
 * @typedef {{
 *  prNumber: string,
 *  title: string,
 *  htmlUrl: string,
 *  latestVersion: string,
 *  latestTag: string,
 *  publishedAt: string,
 * }} SlqjAiSelectablePrBuild
 */

/**
 * @param {{owner:string, repo:string}} repo
 * @returns {Promise<{ok:true, items:SlqjAiSelectablePrBuild[]} | {ok:false, error:string, status?:number}>}
 */
export async function fetchSelectablePrBuilds(repo) {
  const owner = String(repo?.owner || "").trim();
  const name = String(repo?.repo || "").trim();
  if (!owner || !name) return { ok: false, error: "bad repo" };

  const pullsResult = await fetchOpenPullRequests({ owner, repo: name }, { perPage: 50 });
  if (!pullsResult.ok) return pullsResult;

  const repoFullName = `${owner}/${name}`.toLowerCase();
  const sameRepoPullRequests = pullsResult.pullRequests.filter(
    (item) => String(item?.headRepoFullName || "").trim().toLowerCase() === repoFullName
  );
  if (!sameRepoPullRequests.length) return { ok: true, items: [] };

  const targetPrNumbers = new Set(
    sameRepoPullRequests.map((item) => normalizeUpdatePrNumber(item?.number)).filter(Boolean)
  );
  const releasesResult = await fetchReleases({ owner, repo: name }, {
    perPage: 50,
    includePrerelease: true,
    stopWhen: ({ releases }) => hasBuildsForAllPrNumbers(releases, targetPrNumbers),
  });
  if (!releasesResult.ok) return releasesResult;

  return {
    ok: true,
    items: buildSelectablePrBuilds(sameRepoPullRequests, releasesResult.releases),
  };
}

/**
 * @param {any[]} pullRequests
 * @param {any[]} releases
 * @returns {SlqjAiSelectablePrBuild[]}
 */
export function buildSelectablePrBuilds(pullRequests, releases) {
  const pullList = Array.isArray(pullRequests) ? pullRequests : [];
  const releaseList = Array.isArray(releases) ? releases : [];

  /** @type {Map<string, any>} */
  const latestByPr = new Map();
  for (const release of releaseList) {
    if (!release || typeof release !== "object") continue;
    if (!release.prerelease) continue;
    if (!String(release?.assetName || "").trim() || !String(release?.downloadUrl || "").trim()) continue;
    const info = extractPrBuildInfo(String(release?.version || release?.tagName || ""));
    if (!info?.prNumber) continue;
    const prev = latestByPr.get(info.prNumber);
    if (!prev || compareReleasePriority(release, prev) < 0) latestByPr.set(info.prNumber, release);
  }

  /** @type {SlqjAiSelectablePrBuild[]} */
  const items = [];
  for (const pullRequest of pullList) {
    const prNumber = normalizeUpdatePrNumber(pullRequest?.number);
    if (!prNumber) continue;
    const latest = latestByPr.get(prNumber);
    if (!latest) continue;

    items.push({
      prNumber,
      title: String(pullRequest?.title || "").trim(),
      htmlUrl: String(pullRequest?.htmlUrl || "").trim(),
      latestVersion: String(latest?.version || "").trim(),
      latestTag: String(latest?.tagName || "").trim(),
      publishedAt: String(latest?.publishedAt || "").trim(),
    });
  }

  items.sort(compareSelectablePrBuilds);
  return items;
}

/**
 * @param {any[]} releases
 * @param {Set<string>} targetPrNumbers
 * @returns {boolean}
 */
function hasBuildsForAllPrNumbers(releases, targetPrNumbers) {
  if (!(targetPrNumbers instanceof Set) || !targetPrNumbers.size) return true;

  const matched = new Set();
  const list = Array.isArray(releases) ? releases : [];
  for (const release of list) {
    if (!release || typeof release !== "object") continue;
    if (!release.prerelease) continue;
    if (!String(release?.assetName || "").trim() || !String(release?.downloadUrl || "").trim()) continue;
    const info = extractPrBuildInfo(String(release?.version || release?.tagName || ""));
    if (!info?.prNumber) continue;
    if (targetPrNumbers.has(info.prNumber)) matched.add(info.prNumber);
    if (matched.size >= targetPrNumbers.size) return true;
  }
  return false;
}

/**
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
function compareReleasePriority(a, b) {
  const cmp = compareSemver(String(a?.version || ""), String(b?.version || ""));
  if (cmp !== null && cmp !== 0) return cmp === 1 ? -1 : 1;

  const ta = Date.parse(String(a?.publishedAt || ""));
  const tb = Date.parse(String(b?.publishedAt || ""));
  const validA = Number.isFinite(ta);
  const validB = Number.isFinite(tb);
  if (validA && validB && ta !== tb) return tb - ta;
  return String(b?.tagName || "").localeCompare(String(a?.tagName || ""));
}

/**
 * @param {SlqjAiSelectablePrBuild} a
 * @param {SlqjAiSelectablePrBuild} b
 * @returns {number}
 */
function compareSelectablePrBuilds(a, b) {
  const ta = Date.parse(String(a?.publishedAt || ""));
  const tb = Date.parse(String(b?.publishedAt || ""));
  const validA = Number.isFinite(ta);
  const validB = Number.isFinite(tb);
  if (validA && validB && ta !== tb) return tb - ta;

  const cmp = compareSemver(String(a?.latestVersion || ""), String(b?.latestVersion || ""));
  if (cmp !== null && cmp !== 0) return cmp === 1 ? -1 : 1;

  const na = Number(a?.prNumber);
  const nb = Number(b?.prNumber);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
  return String(a?.title || "").localeCompare(String(b?.title || ""));
}
