import { SLQJ_AI_UPDATE_REPO, SLQJ_AI_UPDATE_ZIP_ROOT_NAME } from "../version.js";
import { fetchLatestRelease } from "./github.js";
import { compareSemver } from "./semver.js";
import { downloadToBytes } from "./download.js";
import { applyUpdateFromZip } from "./apply_update.js";

/**
 * @typedef {{
 *  ok: true,
 *  currentVersion: string,
 *  latestVersion: string,
 *  latestTag: string,
 *  updateAvailable: boolean,
 *  comparable: boolean,
 *  htmlUrl: string,
 *  assetName: string,
 *  downloadUrl: string,
 * } | {
 *  ok: false,
 *  error: string,
 * }} SlqjAiUpdateCheckResult
 */

/**
 * @param {{currentVersion:string}} opts
 * @returns {Promise<SlqjAiUpdateCheckResult>}
 */
export async function checkForUpdate(opts) {
  const currentVersion = String(opts?.currentVersion || "").trim();
  if (!currentVersion) return { ok: false, error: "bad current version" };

  const latest = await fetchLatestRelease(SLQJ_AI_UPDATE_REPO);
  if (!latest.ok) return { ok: false, error: latest.error };

  const latestVersion = String(latest.version || "").trim();
  const latestTag = String(latest.tagName || "").trim();

  const cmp = compareSemver(currentVersion, latestVersion);
  const comparable = cmp !== null;
  const updateAvailable = comparable ? cmp === -1 : latestVersion && latestVersion !== currentVersion;

  return {
    ok: true,
    currentVersion,
    latestVersion,
    latestTag,
    updateAvailable,
    comparable,
    htmlUrl: latest.htmlUrl,
    assetName: latest.assetName,
    downloadUrl: latest.downloadUrl,
  };
}

/**
 * 下载并覆盖更新（Node/Electron 环境可用时）。
 *
 * @param {{game?:any, baseUrl:string, downloadUrl:string, backup?:boolean}} opts
 * @returns {Promise<{ok:true, updatedFiles:number, backupDir:string} | {ok:false, error:string}>}
 */
export async function downloadAndApplyUpdate(opts) {
  const game = opts?.game;
  const baseUrl = String(opts?.baseUrl || "");
  const downloadUrl = String(opts?.downloadUrl || "").trim();
  const backup = opts?.backup !== false;
  if (!baseUrl || !downloadUrl) return { ok: false, error: "bad args" };

  const zip = await downloadUpdateZipToBytes({ game, downloadUrl });
  if (!zip.ok) return { ok: false, error: zip.error };

  const applied = await applyUpdateFromZip({
    baseUrl,
    game,
    zipBytes: zip.bytes,
    zipRootName: SLQJ_AI_UPDATE_ZIP_ROOT_NAME,
    backup,
  });
  if (!applied.ok) return { ok: false, error: applied.error };

  return { ok: true, updatedFiles: applied.result.updatedFiles, backupDir: applied.result.backupDir };
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isGithubReleaseAssetApiUrl(url) {
  const u = String(url || "");
  return u.includes("api.github.com/") && u.includes("/releases/assets/");
}

/**
 * 下载更新 zip：优先走引擎下载（绕过 CORS），失败再使用 fetch 直接取字节。
 *
 * @param {{game?:any, downloadUrl:string}} opts
 * @returns {Promise<{ok:true, bytes:Uint8Array} | {ok:false, error:string}>}
 */
async function downloadUpdateZipToBytes(opts) {
  const game = opts?.game;
  const downloadUrl = String(opts?.downloadUrl || "").trim();
  if (!downloadUrl) return { ok: false, error: "bad url" };

  // GitHub Assets API -> 302 Location -> release-assets URL（无 CORS header），因此在浏览器/Electron 渲染进程里
  // 更推荐先拿到 Location，再交给引擎的 game.download 去下载文件。
  if (canUseGameDownload(game) && isGithubReleaseAssetApiUrl(downloadUrl)) {
    const redirected = await resolveGithubAssetRedirectUrl(downloadUrl);
    if (redirected.ok) {
      const viaGame = await downloadToBytesViaGame(game, redirected.url);
      if (viaGame.ok) return viaGame;
    }
  }

  const headers = isGithubReleaseAssetApiUrl(downloadUrl) ? { Accept: "application/octet-stream" } : undefined;
  return await downloadToBytes(downloadUrl, headers ? { headers } : undefined);
}

/**
 * @param {*} game
 * @returns {boolean}
 */
function canUseGameDownload(game) {
  try {
    return !!(game && typeof game.download === "function" && game.promises && typeof game.promises.download === "function");
  } catch (e) {
    return false;
  }
}

/**
 * @param {string} assetApiUrl
 * @returns {Promise<{ok:true, url:string} | {ok:false, error:string}>}
 */
async function resolveGithubAssetRedirectUrl(assetApiUrl) {
  const u = String(assetApiUrl || "").trim();
  if (!u) return { ok: false, error: "bad url" };
  try {
    if (typeof fetch !== "function") return { ok: false, error: "fetch unavailable" };
    const resp = await fetch(u, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/octet-stream",
      },
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("Location") || resp.headers.get("location");
      if (loc) return { ok: true, url: String(loc).trim() };
      return { ok: false, error: "redirect missing location" };
    }
    return { ok: false, error: `http ${resp.status}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) || "unknown" };
  }
}

/**
 * @param {*} game
 * @param {string} url
 * @returns {Promise<{ok:true, bytes:Uint8Array} | {ok:false, error:string}>}
 */
async function downloadToBytesViaGame(game, url) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "bad url" };

  const tmp = `extension/${SLQJ_AI_UPDATE_ZIP_ROOT_NAME}/.update_tmp/slqj-ai-update-${Date.now()}.zip`;
  try {
    await game.promises.download(u, tmp);
  } catch (e) {
    return { ok: false, error: "game download failed" };
  }

  let data = null;
  try {
    data = await game.promises.readFile(tmp);
  } catch (e) {
    return { ok: false, error: "game readFile failed" };
  } finally {
    try {
      if (game.promises && typeof game.promises.removeFile === "function") {
        await game.promises.removeFile(tmp);
      }
    } catch (e) {}
  }

  const bytes = toUint8Array(data);
  if (!bytes) return { ok: false, error: "bad file bytes" };
  // 基础校验：zip 文件头 "PK"
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ok: false, error: "downloaded file is not a zip" };
  return { ok: true, bytes };
}

/**
 * @param {any} data
 * @returns {Uint8Array|null}
 */
function toUint8Array(data) {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // Node Buffer (Uint8Array-like)
  if (typeof data === "object" && data.buffer && typeof data.byteLength === "number") {
    try {
      return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    } catch (e) {
      return null;
    }
  }
  return null;
}
