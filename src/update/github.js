import { normalizeTagToVersion } from "./semver.js";

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
