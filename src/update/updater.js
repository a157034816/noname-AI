import { SLQJ_AI_UPDATE_REPO, SLQJ_AI_UPDATE_ZIP_ROOT_NAME } from "../version.js";
import { fetchReleases, matchesReleaseForChannel, pickLatestReleaseForChannel } from "./github.js";
import { compareSemver } from "./semver.js";
import { downloadToBytes } from "./download.js";
import { applyUpdateFromZip } from "./apply_update.js";
import { normalizeBuildChannel, normalizeUpdateChannel, normalizeUpdatePrNumber, UPDATE_CHANNEL_PR } from "./settings.js";

/**
 * @typedef {{
 *  ok: true,
 *  currentVersion: string,
 *  latestVersion: string,
 *  latestTag: string,
 *  installedChannel: "stable"|"pr",
 *  installedPrNumber: string,
 *  targetChannel: "stable"|"pr",
 *  targetPrNumber: string,
 *  updateAvailable: boolean,
 *  comparable: boolean,
 *  requiresReinstall: boolean,
 *  updateReason: string,
 *  htmlUrl: string,
 *  assetName: string,
 *  downloadUrl: string,
 * } | {
 *  ok: false,
 *  error: string,
 * }} SlqjAiUpdateCheckResult
 */

/**
 * @param {{
 *  currentVersion:string,
 *  installedChannel?:"stable"|"pr"|string,
 *  installedPrNumber?:string,
 *  targetChannel?:"stable"|"pr"|string,
 *  targetPrNumber?:string
 * }} opts
 * @returns {Promise<SlqjAiUpdateCheckResult>}
 */
export async function checkForUpdate(opts) {
  const currentVersion = String(opts?.currentVersion || "").trim();
  if (!currentVersion) return { ok: false, error: "bad current version" };
  const installedChannel = normalizeBuildChannel(opts?.installedChannel);
  const installedPrNumber = normalizeUpdatePrNumber(opts?.installedPrNumber);
  const targetChannel = normalizeUpdateChannel(opts?.targetChannel);
  const targetPrNumber = normalizeUpdatePrNumber(opts?.targetPrNumber);
  if (targetChannel === UPDATE_CHANNEL_PR && !targetPrNumber) return { ok: false, error: "bad pr number" };

  const targetMatcher = { channel: targetChannel, prNumber: targetPrNumber };
  const list = await fetchReleases(SLQJ_AI_UPDATE_REPO, {
    perPage: 50,
    includePrerelease: targetChannel === UPDATE_CHANNEL_PR,
    stopWhen: ({ releases }) => !!pickLatestReleaseForChannel(releases, targetMatcher),
  });
  if (!list.ok) return { ok: false, error: list.error };
  const latest = pickLatestReleaseForChannel(list.releases, targetMatcher);
  if (!latest) {
    return {
      ok: false,
      error: targetChannel === UPDATE_CHANNEL_PR ? `no release for pr ${targetPrNumber}` : "no stable release",
    };
  }

  const latestVersion = String(latest.version || "").trim();
  const latestTag = String(latest.tagName || "").trim();
  const decision = decideUpdateAvailability({
    currentVersion,
    installedChannel,
    installedPrNumber,
    targetChannel,
    targetPrNumber,
    latestVersion,
    latestTag,
  });

  return {
    ok: true,
    currentVersion,
    latestVersion,
    latestTag,
    installedChannel,
    installedPrNumber,
    targetChannel,
    targetPrNumber,
    updateAvailable: decision.updateAvailable,
    comparable: decision.comparable,
    requiresReinstall: decision.requiresReinstall,
    updateReason: decision.updateReason,
    htmlUrl: latest.htmlUrl,
    assetName: latest.assetName,
    downloadUrl: latest.downloadUrl,
  };
}

/**
 * @typedef {{
 *  version: string,
 *  tagName: string,
 *  title: string,
 *  body: string,
 *  htmlUrl: string,
 *  publishedAt: string,
 * }} SlqjAiReleaseNote
 */

/**
 * @typedef {{
 *  ok: true,
 *  notes: SlqjAiReleaseNote[],
 *  warning?: string,
 * } | {
 *  ok: false,
 *  error: string,
 * }} SlqjAiReleaseNotesResult
 */

/**
 * 拉取并计算“当前版本 -> latest”的更新内容区间（用于更新弹窗展示）。
 *
 * @param {{
 *  currentVersion:string,
 *  latestVersion:string,
 *  latestTag:string,
 *  installedChannel?:"stable"|"pr"|string,
 *  installedPrNumber?:string,
 *  targetChannel?:"stable"|"pr"|string,
 *  targetPrNumber?:string,
 *  requiresReinstall?:boolean
 * }} opts
 * @returns {Promise<SlqjAiReleaseNotesResult>}
 */
export async function fetchReleaseNotesBetweenVersions(opts) {
  const currentVersion = String(opts?.currentVersion || "").trim();
  const latestVersion = String(opts?.latestVersion || "").trim();
  const latestTag = String(opts?.latestTag || "").trim();
  if (!currentVersion || !latestVersion) return { ok: false, error: "bad args" };
  const installedChannel = normalizeBuildChannel(opts?.installedChannel);
  const installedPrNumber = normalizeUpdatePrNumber(opts?.installedPrNumber);
  const targetChannel = normalizeUpdateChannel(opts?.targetChannel);
  const targetPrNumber = normalizeUpdatePrNumber(opts?.targetPrNumber);
  const requiresReinstall = opts?.requiresReinstall === true;
  if (targetChannel === UPDATE_CHANNEL_PR && !targetPrNumber) return { ok: false, error: "bad pr number" };

  const targetMatcher = { channel: targetChannel, prNumber: targetPrNumber };
  const crossStream =
    requiresReinstall ||
    installedChannel !== targetChannel ||
    (targetChannel === UPDATE_CHANNEL_PR && installedPrNumber !== targetPrNumber);
  const list = await fetchReleases(SLQJ_AI_UPDATE_REPO, {
    perPage: 50,
    includePrerelease: targetChannel === UPDATE_CHANNEL_PR,
    stopWhen: ({ releases }) =>
      shouldStopFetchingReleaseNotes(releases, {
        targetMatcher,
        latestVersion,
        latestTag,
        currentVersion,
        crossStream,
      }),
  });
  if (!list.ok) return { ok: false, error: list.error };

  const releases = (Array.isArray(list.releases) ? list.releases : []).filter((release) =>
    matchesReleaseForChannel(release, targetMatcher)
  );
  if (!releases.length) return { ok: true, notes: [] };
  const targetRelease =
    releases.find((release) => String(release?.tagName || "").trim() === latestTag) ||
    releases.find((release) => String(release?.version || "").trim() === latestVersion) ||
    pickLatestReleaseForChannel(releases, targetMatcher);
  if (!targetRelease) return { ok: true, notes: [] };

  if (crossStream) {
    return {
      ok: true,
      notes: [toReleaseNote(targetRelease)],
      warning: "当前安装与目标更新流不同，将重新下载安装目标版本；这里只展示目标版本说明。",
    };
  }

  // 优先走 semver 区间筛选（最准确）。
  const cmp = compareSemver(currentVersion, latestVersion);
  if (cmp !== null) {
    const picked = new Map();
    for (const r of releases) {
      const rv = String(r?.version || "").trim();
      if (!rv) continue;
      // current < rv <= latest
      const c1 = compareSemver(currentVersion, rv);
      if (c1 !== -1) continue;
      const c2 = compareSemver(rv, latestVersion);
      if (c2 !== -1 && c2 !== 0) continue;
      if (!picked.has(rv)) picked.set(rv, r);
    }
    const notes = Array.from(picked.values())
      .sort((a, b) => {
        const c = compareSemver(String(a?.version || ""), String(b?.version || ""));
        return c === null ? 0 : c;
      })
      .map(toReleaseNote);
    return { ok: true, notes };
  }

  // 降级：无法比较版本时，按 release 时间从新到旧回溯直到命中当前版本 tag。
  /** @type {any[]} */
  const notesDesc = [];
  let foundCurrent = false;
  for (const r of releases) {
    const v = String(r?.version || "").trim();
    const tag = String(r?.tagName || "").trim();
    if ((v && v === currentVersion) || (tag && tag === currentVersion)) {
      foundCurrent = true;
      break;
    }
    // 尝试额外兼容：tag 为 v{current}
    if (tag && tag.toLowerCase() === ("v" + currentVersion).toLowerCase()) {
      foundCurrent = true;
      break;
    }
    notesDesc.push(r);
  }

  const warning = foundCurrent
    ? ""
    : "未在 GitHub Releases 中找到与当前版本一致的 tag，可能是手动安装/本地版本与发布版本不一致；仅展示最近的更新内容。";

  const notes = notesDesc
    .slice()
    .reverse()
    .map(toReleaseNote);

  if (warning) return { ok: true, notes, warning };
  return { ok: true, notes };
}

/**
 * @param {{
 *  currentVersion:string,
 *  installedChannel?:"stable"|"pr"|string,
 *  installedPrNumber?:string,
 *  targetChannel?:"stable"|"pr"|string,
 *  targetPrNumber?:string,
 *  latestVersion:string,
 *  latestTag:string
 * }} opts
 * @returns {{updateAvailable:boolean, comparable:boolean, requiresReinstall:boolean, updateReason:string}}
 */
export function decideUpdateAvailability(opts) {
  const currentVersion = String(opts?.currentVersion || "").trim();
  const latestVersion = String(opts?.latestVersion || "").trim();
  const latestTag = String(opts?.latestTag || "").trim();
  const installedChannel = normalizeBuildChannel(opts?.installedChannel);
  const installedPrNumber = normalizeUpdatePrNumber(opts?.installedPrNumber);
  const targetChannel = normalizeUpdateChannel(opts?.targetChannel);
  const targetPrNumber = normalizeUpdatePrNumber(opts?.targetPrNumber);

  if (!currentVersion || !latestVersion || !latestTag) {
    return { updateAvailable: false, comparable: false, requiresReinstall: false, updateReason: "bad-args" };
  }
  if (installedChannel !== targetChannel) {
    return { updateAvailable: true, comparable: false, requiresReinstall: true, updateReason: "channel-switch" };
  }
  if (targetChannel === UPDATE_CHANNEL_PR && installedPrNumber !== targetPrNumber) {
    return { updateAvailable: true, comparable: false, requiresReinstall: true, updateReason: "pr-switch" };
  }

  const cmp = compareSemver(currentVersion, latestVersion);
  const comparable = cmp !== null;
  const updateAvailable = comparable ? cmp === -1 : latestVersion !== currentVersion;
  return {
    updateAvailable,
    comparable,
    requiresReinstall: false,
    updateReason: updateAvailable ? "same-stream-newer" : "up-to-date",
  };
}

/**
 * @param {any} release
 * @returns {SlqjAiReleaseNote}
 */
function toReleaseNote(release) {
  return {
    version: String(release?.version || "").trim(),
    tagName: String(release?.tagName || "").trim(),
    title: String(release?.title || "").trim(),
    body: typeof release?.body === "string" ? release.body : String(release?.body || ""),
    htmlUrl: String(release?.htmlUrl || "").trim(),
    publishedAt: String(release?.publishedAt || "").trim(),
  };
}

/**
 * @param {any[]} releases
 * @param {{
 *  targetMatcher:{channel:"stable"|"pr", prNumber:string},
 *  latestVersion:string,
 *  latestTag:string,
 *  currentVersion:string,
 *  crossStream:boolean
 * }} opts
 * @returns {boolean}
 */
function shouldStopFetchingReleaseNotes(releases, opts) {
  const streamReleases = (Array.isArray(releases) ? releases : []).filter((release) =>
    matchesReleaseForChannel(release, opts?.targetMatcher)
  );
  if (!streamReleases.length) return false;

  const latestTag = String(opts?.latestTag || "").trim();
  const latestVersion = String(opts?.latestVersion || "").trim();
  const currentVersion = String(opts?.currentVersion || "").trim();
  const hasTargetRelease = streamReleases.some((release) => {
    const tagName = String(release?.tagName || "").trim();
    const version = String(release?.version || "").trim();
    return (latestTag && tagName === latestTag) || (latestVersion && version === latestVersion);
  });
  if (!hasTargetRelease) return false;
  if (opts?.crossStream) return true;
  return streamReleases.some((release) => String(release?.version || "").trim() === currentVersion);
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
