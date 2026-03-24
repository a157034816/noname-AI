import { compareSemver, extractPrBuildInfo, normalizeTagToVersion } from "./semver.js";
import { normalizeUpdateChannel, normalizeUpdatePrNumber, UPDATE_CHANNEL_PR } from "./settings.js";

const GITHUB_API_BASE = "https://api.github.com";

/**
 * @typedef {{name?:string, browser_download_url?:string, url?:string, id?:number, content_type?:string}} GithubReleaseAsset
 */

/**
 * @typedef {{
 *  tag_name?: string,
 *  html_url?: string,
 *  assets?: GithubReleaseAsset[],
 * }} GithubReleaseLatest
 */

/**
 * @typedef {{
 *  id?: number,
 *  tag_name?: string,
 *  html_url?: string,
 *  name?: string,
 *  body?: string,
 *  draft?: boolean,
 *  prerelease?: boolean,
 *  published_at?: string,
 * }} GithubReleaseItem
 */

/**
 * @typedef {{
 *  full_name?: string,
 * }} GithubRepoRef
 */

/**
 * @typedef {{
 *  repo?: GithubRepoRef|null,
 * }} GithubPullRequestHead
 */

/**
 * @typedef {{
 *  number?: number,
 *  title?: string,
 *  html_url?: string,
 *  draft?: boolean,
 *  updated_at?: string,
 *  head?: GithubPullRequestHead|null,
 * }} GithubPullRequestItem
 */

/**
 * @typedef {{
 *  tagName: string,
 *  version: string,
 *  htmlUrl: string,
 *  title: string,
 *  body: string,
 *  publishedAt: string,
 *  prerelease: boolean,
 *  draft: boolean,
 *  assetName: string,
 *  downloadUrl: string,
 * }} SlqjAiGithubRelease
 */

/**
 * @typedef {{
 *  number: number,
 *  title: string,
 *  htmlUrl: string,
 *  draft: boolean,
 *  updatedAt: string,
 *  headRepoFullName: string,
 * }} SlqjAiGithubPullRequest
 */

/**
 * @param {GithubReleaseAsset[]} assets
 * @returns {{ name: string, downloadUrl: string, apiUrl: string }|null}
 */
function pickZipAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  /** @type {{name:string, downloadUrl:string, apiUrl:string, score:number}[]} */
  const candidates = [];
  for (const a of list) {
    const name = String(a?.name || "").trim();
    const url = String(a?.browser_download_url || "").trim();
    const apiUrl = String(a?.url || "").trim();
    if (!name || !url) continue;
    if (!name.toLowerCase().endsWith(".zip")) continue;

    const ct = String(a?.content_type || "").toLowerCase();
    let score = 0;
    if (ct.includes("zip")) score += 5;
    const lower = name.toLowerCase();
    if (lower.includes("shenlinqijing")) score += 3;
    if (name.includes("身临其境")) score += 3;
    if (lower.includes("ai")) score += 1;
    candidates.push({ name, downloadUrl: url, apiUrl, score });
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => y.score - x.score);
  return { name: candidates[0].name, downloadUrl: candidates[0].downloadUrl, apiUrl: candidates[0].apiUrl };
}

/**
 * 获取最新 Release（GitHub API: releases/latest）。
 *
 * @param {{owner:string, repo:string}} repo
 * @returns {Promise<{ok:true, tagName:string, version:string, htmlUrl:string, assetName:string, downloadUrl:string} | {ok:false, error:string, status?:number}>}
 */
export async function fetchLatestRelease(repo) {
  const owner = String(repo?.owner || "").trim();
  const name = String(repo?.repo || "").trim();
  if (!owner || !name) return { ok: false, error: "bad repo" };

  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`;

  try {
    if (typeof fetch !== "function") return { ok: false, error: "fetch unavailable" };

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    if (!resp.ok) {
      // 某些仓库可能没有 latest（或未设置为非草稿），这里降级为取 releases 列表第一个。
      if (resp.status === 404) {
        return await fetchLatestReleaseFromList({ owner, repo: name });
      }
      return { ok: false, error: `http ${resp.status}`, status: resp.status };
    }

    /** @type {GithubReleaseLatest} */
    const data = await resp.json();
    const tagName = String(data?.tag_name || "").trim();
    const htmlUrl = String(data?.html_url || "").trim();
    const version = normalizeTagToVersion(tagName);
    const asset = pickZipAsset(data?.assets || []);

    if (!tagName || !asset || !(asset.apiUrl || asset.downloadUrl)) {
      return { ok: false, error: "release asset missing" };
    }

    return {
      ok: true,
      tagName,
      version,
      htmlUrl,
      assetName: asset.name,
      // 优先使用 GitHub Assets API（更稳定，支持重定向到 release-assets 域名）
      downloadUrl: asset.apiUrl || asset.downloadUrl,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) || "unknown" };
  }
}

/**
 * 获取 releases 列表（GitHub API: releases）。
 *
 * @param {{owner:string, repo:string}} repo
 * @param {{perPage?:number, maxPages?:number, includePrerelease?:boolean, stopWhen?:(ctx:{page:number, releases:SlqjAiGithubRelease[]})=>boolean}} [opts]
 * @returns {Promise<{ok:true, releases:SlqjAiGithubRelease[]} | {ok:false, error:string, status?:number}>}
 */
export async function fetchReleases(repo, opts) {
  const owner = String(repo?.owner || "").trim();
  const name = String(repo?.repo || "").trim();
  if (!owner || !name) return { ok: false, error: "bad repo" };

  const includePrerelease = opts?.includePrerelease === true;

  let perPage = 30;
  try {
    const n = Number(opts?.perPage);
    if (Number.isFinite(n) && n > 0) perPage = Math.floor(n);
  } catch (e) {}
  if (perPage < 1) perPage = 1;
  if (perPage > 100) perPage = 100;

  let maxPages = Number.POSITIVE_INFINITY;
  try {
    const n = Number(opts?.maxPages);
    if (Number.isFinite(n) && n > 0) maxPages = Math.floor(n);
  } catch (e) {}
  const stopWhen = typeof opts?.stopWhen === "function" ? opts.stopWhen : null;

  /** @type {SlqjAiGithubRelease[]} */
  const releases = [];
  const seenTags = new Set();

  try {
    if (typeof fetch !== "function") return { ok: false, error: "fetch unavailable" };

    for (let page = 1; page <= maxPages; page++) {
      const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=${perPage}&page=${page}`;

      const resp = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
        },
      });

      if (!resp.ok) return { ok: false, error: `http ${resp.status}`, status: resp.status };

      /** @type {GithubReleaseItem[]|any} */
      const list = await resp.json();
      if (!Array.isArray(list)) return { ok: false, error: "bad response" };
      if (!list.length) break;

      for (const item of list) {
        const tagName = String(item?.tag_name || "").trim();
        if (!tagName) continue;
        if (seenTags.has(tagName)) continue;
        seenTags.add(tagName);

        const draft = !!item?.draft;
        if (draft) continue;
        const prerelease = !!item?.prerelease;
        if (prerelease && !includePrerelease) continue;

        const htmlUrl = String(item?.html_url || "").trim();
        const title = String(item?.name || "").trim();
        const body = typeof item?.body === "string" ? item.body : String(item?.body || "");
        const publishedAt = String(item?.published_at || "").trim();
        const version = normalizeTagToVersion(tagName);
        const asset = pickZipAsset(item?.assets || []);

        releases.push({
          tagName,
          version,
          htmlUrl,
          title,
          body,
          publishedAt,
          prerelease,
          draft,
          assetName: asset?.name || "",
          downloadUrl: asset?.apiUrl || asset?.downloadUrl || "",
        });
      }

      // 若返回条数不足 perPage，通常表示已经到末页。
      if (stopWhen && stopWhen({ page, releases })) break;
      if (list.length < perPage) break;
    }

    return { ok: true, releases };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) || "unknown" };
  }
}

/**
 * 获取开放 PR 列表（GitHub API: pulls）。
 *
 * @param {{owner:string, repo:string}} repo
 * @param {{perPage?:number, maxPages?:number}} [opts]
 * @returns {Promise<{ok:true, pullRequests:SlqjAiGithubPullRequest[]} | {ok:false, error:string, status?:number}>}
 */
export async function fetchOpenPullRequests(repo, opts) {
  const owner = String(repo?.owner || "").trim();
  const name = String(repo?.repo || "").trim();
  if (!owner || !name) return { ok: false, error: "bad repo" };

  let perPage = 30;
  try {
    const n = Number(opts?.perPage);
    if (Number.isFinite(n) && n > 0) perPage = Math.floor(n);
  } catch (e) {}
  if (perPage < 1) perPage = 1;
  if (perPage > 100) perPage = 100;

  let maxPages = Number.POSITIVE_INFINITY;
  try {
    const n = Number(opts?.maxPages);
    if (Number.isFinite(n) && n > 0) maxPages = Math.floor(n);
  } catch (e) {}

  /** @type {SlqjAiGithubPullRequest[]} */
  const pullRequests = [];
  const seenNumbers = new Set();

  try {
    if (typeof fetch !== "function") return { ok: false, error: "fetch unavailable" };

    for (let page = 1; page <= maxPages; page++) {
      const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=${perPage}&page=${page}`;

      const resp = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
        },
      });
      if (!resp.ok) return { ok: false, error: `http ${resp.status}`, status: resp.status };

      /** @type {GithubPullRequestItem[]|any} */
      const list = await resp.json();
      if (!Array.isArray(list)) return { ok: false, error: "bad response" };
      if (!list.length) break;

      for (const item of list) {
        const number = Number(item?.number);
        if (!Number.isFinite(number) || number <= 0) continue;
        if (seenNumbers.has(number)) continue;
        seenNumbers.add(number);

        pullRequests.push({
          number,
          title: String(item?.title || "").trim(),
          htmlUrl: String(item?.html_url || "").trim(),
          draft: !!item?.draft,
          updatedAt: String(item?.updated_at || "").trim(),
          headRepoFullName: String(item?.head?.repo?.full_name || "").trim(),
        });
      }

      if (list.length < perPage) break;
    }

    return { ok: true, pullRequests };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) || "unknown" };
  }
}

/**
 * @param {SlqjAiGithubRelease} release
 * @param {{channel:"stable"|"pr", prNumber:string}} opts
 * @returns {boolean}
 */
export function matchesReleaseForChannel(release, opts) {
  if (!release || typeof release !== "object") return false;
  const channel = normalizeUpdateChannel(opts?.channel);
  const prNumber = normalizeUpdatePrNumber(opts?.prNumber);
  if (channel !== UPDATE_CHANNEL_PR) return !release.prerelease;
  if (!release.prerelease || !prNumber) return false;
  const prMeta = extractPrBuildInfo(release.version || release.tagName || "");
  return !!prMeta && prMeta.prNumber === prNumber;
}

/**
 * @param {SlqjAiGithubRelease[]} releases
 * @param {{channel:"stable"|"pr", prNumber:string}} opts
 * @returns {SlqjAiGithubRelease|null}
 */
export function pickLatestReleaseForChannel(releases, opts) {
  const list = Array.isArray(releases) ? releases : [];
  const filtered = list
    .filter((release) => matchesReleaseForChannel(release, opts))
    .filter((release) => String(release?.assetName || "").trim() && String(release?.downloadUrl || "").trim());
  if (!filtered.length) return null;
  filtered.sort(compareReleasesDesc);
  return filtered[0];
}

/**
 * 降级方案：读取 releases 列表取第一个（最新）。
 *
 * @param {{owner:string, repo:string}} repo
 * @returns {Promise<{ok:true, tagName:string, version:string, htmlUrl:string, assetName:string, downloadUrl:string} | {ok:false, error:string, status?:number}>}
 */
async function fetchLatestReleaseFromList(repo) {
  const owner = String(repo?.owner || "").trim();
  const name = String(repo?.repo || "").trim();
  if (!owner || !name) return { ok: false, error: "bad repo" };

  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=1`;
  try {
    if (typeof fetch !== "function") return { ok: false, error: "fetch unavailable" };

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    if (!resp.ok) return { ok: false, error: `http ${resp.status}`, status: resp.status };

    const list = await resp.json();
    const first = Array.isArray(list) ? list[0] : null;
    if (!first) return { ok: false, error: "no releases" };
    const tagName = String(first?.tag_name || "").trim();
    const htmlUrl = String(first?.html_url || "").trim();
    const version = normalizeTagToVersion(tagName);
    const asset = pickZipAsset(first?.assets || []);
    if (!tagName || !asset || !(asset.apiUrl || asset.downloadUrl)) return { ok: false, error: "release asset missing" };

    return {
      ok: true,
      tagName,
      version,
      htmlUrl,
      assetName: asset.name,
      downloadUrl: asset.apiUrl || asset.downloadUrl,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) || "unknown" };
  }
}

/**
 * @param {SlqjAiGithubRelease} a
 * @param {SlqjAiGithubRelease} b
 * @returns {number}
 */
function compareReleasesDesc(a, b) {
  const cmp = compareSemver(String(a?.version || ""), String(b?.version || ""));
  if (cmp !== null && cmp !== 0) return cmp === -1 ? 1 : -1;
  const ta = Date.parse(String(a?.publishedAt || ""));
  const tb = Date.parse(String(b?.publishedAt || ""));
  const validA = Number.isFinite(ta);
  const validB = Number.isFinite(tb);
  if (validA && validB && ta !== tb) return tb - ta;
  return String(b?.tagName || "").localeCompare(String(a?.tagName || ""));
}
