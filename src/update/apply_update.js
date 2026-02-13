import { getNodeDeps } from "./node_env.js";
import { unzipToMemory } from "./zip.js";

/**
 * @typedef {{
 *  preservedExtraScripts: boolean,
 *  backupDir: string,
 *  updatedFiles: number,
 * }} SlqjAiUpdateApplyResult
 */

/**
 * 从 zip 内容覆盖更新当前扩展目录。
 *
 * 策略：
 * - `src/`：先删除再写入（避免旧文件残留）
 * - `scripts/`：覆盖同名文件，不删除本地额外脚本
 * - 其它文件：直接覆盖
 *
 * @param {{baseUrl?:string, game?:any, zipBytes:Uint8Array, zipRootName:string, backup?:boolean}} opts
 * @returns {Promise<{ok:true, result:SlqjAiUpdateApplyResult} | {ok:false, error:string}>}
 */
export async function applyUpdateFromZip(opts) {
  const baseUrl = String(opts?.baseUrl || "");
  const game = opts?.game;
  const zipBytes = opts?.zipBytes;
  const zipRootName = String(opts?.zipRootName || "").trim();
  const doBackup = opts?.backup !== false;
  if (!(zipBytes instanceof Uint8Array) || !zipRootName) return { ok: false, error: "bad args" };

  // 优先使用引擎提供的 IO（game.promises.*）+ JSZip 解压：可在无 Node 内置模块的环境工作。
  if (canUseGameIo(game)) {
    const viaGame = await applyUpdateFromZipViaGame({ game, zipBytes, zipRootName, backup: doBackup });
    if (viaGame.ok) return viaGame;
  }

  // 兜底：Node 环境（fs/path/url/zlib）直接覆盖写入。
  if (!baseUrl) return { ok: false, error: "baseUrl required" };

  const deps = await getNodeDeps();
  const fs = deps.fs;
  const path = deps.path;
  const urlMod = deps.url;
  if (!fs || !fs.promises || !path || !urlMod || typeof urlMod.fileURLToPath !== "function") {
    return { ok: false, error: "node deps unavailable" };
  }

  const unzip = unzipToMemory(zipBytes, { zlib: deps.zlib });
  if (!unzip.ok) return { ok: false, error: unzip.error };

  const prefix = resolveZipPrefix(
    unzip.files.map((f) => String(f?.path || "")),
    zipRootName
  );
  if (prefix === null) return { ok: false, error: "zip root missing" };

  const files = unzip.files.filter((f) => f && typeof f.path === "string" && normalizeZipEntryPath(f.path).startsWith(prefix));
  if (!files.length) return { ok: false, error: "zip root missing" };

  const mustHave = new Set([`${prefix}extension.js`, `${prefix}info.json`]);
  for (const need of mustHave) {
    if (!files.some((f) => normalizeZipEntryPath(f.path) === need)) return { ok: false, error: `zip missing ${need}` };
  }

  const extensionDir = resolveExtensionDir(baseUrl, urlMod, path);
  if (!extensionDir) return { ok: false, error: "resolve extension dir failed" };

  const backupDir = doBackup ? await createBackupDir(extensionDir, path, fs) : "";
  if (doBackup && !backupDir) return { ok: false, error: "backup failed" };

  if (doBackup) {
    await backupIfExists(fs, path, extensionDir, backupDir, "extension.js");
    await backupIfExists(fs, path, extensionDir, backupDir, "info.json");
    await backupIfExists(fs, path, extensionDir, backupDir, "README.md");
    await backupDirIfExists(fs, path, extensionDir, backupDir, "src");
  }

  // 先清理 src，避免旧文件残留。
  await rmDirRecursive(fs, path, path.join(extensionDir, "src"));

  let updatedFiles = 0;
  for (const f of files) {
    const full = normalizeZipEntryPath(f.path);
    const rel = full.slice(prefix.length);
    if (!rel) continue;
    const dest = path.join(extensionDir, rel);
    if (!isPathInside(dest, extensionDir, path)) return { ok: false, error: "unsafe path in zip" };

    await ensureDir(fs, path.dirname(dest));
    await fs.promises.writeFile(dest, f.data);
    updatedFiles++;
  }

  return {
    ok: true,
    result: {
      preservedExtraScripts: true,
      backupDir,
      updatedFiles,
    },
  };
}

/**
 * @param {*} game
 * @returns {boolean}
 */
function canUseGameIo(game) {
  if (!game) return false;
  // 注意：game.promises.* 在某些环境里即使底层 game.* 不存在也会有同名包装函数，
  // 因此这里优先检查底层能力，避免误判导致更新流程走错路径。
  try {
    if (typeof game.writeFile !== "function") return false;
    if (typeof game.readFile !== "function") return false;
    if (typeof game.getFileList !== "function") return false;
    if (typeof game.removeDir !== "function") return false;
  } catch (e) {
    return false;
  }
  const p = game.promises;
  return !!(p && typeof p.writeFile === "function" && typeof p.readFile === "function");
}

/**
 * 使用 JSZip + game.promises.* 进行解压覆盖更新。
 *
 * @param {{game:any, zipBytes:Uint8Array, zipRootName:string, backup:boolean}} opts
 * @returns {Promise<{ok:true, result:SlqjAiUpdateApplyResult} | {ok:false, error:string}>}
 */
async function applyUpdateFromZipViaGame(opts) {
  const game = opts?.game;
  const zipBytes = opts?.zipBytes;
  const zipRootName = String(opts?.zipRootName || "").trim();
  const doBackup = !!opts?.backup;
  if (!canUseGameIo(game) || !(zipBytes instanceof Uint8Array) || !zipRootName) return { ok: false, error: "game io unavailable" };

  const JSZip = await tryImportJSZip();
  if (!JSZip) return { ok: false, error: "JSZip unavailable" };

  let zip = null;
  try {
    zip = new JSZip();
    zip.load(zipBytes.buffer);
  } catch (e) {
    return { ok: false, error: "bad zip" };
  }

  const zipFiles = zip && zip.files ? zip.files : {};
  const prefix = resolveZipPrefix(Object.keys(zipFiles || {}), zipRootName);
  if (prefix === null) return { ok: false, error: "zip root missing" };

  /** @type {Array<{rel:string, entry:any}>} */
  const entries = [];
  for (const [name, entry] of Object.entries(zipFiles)) {
    const p = normalizeZipEntryPath(name);
    if (!p.startsWith(prefix)) continue;
    if (entry && entry.dir) continue;
    const rel = p.slice(prefix.length);
    if (!rel) continue;
    if (!isSafeZipRelPath(rel)) return { ok: false, error: "unsafe path in zip" };
    entries.push({ rel, entry });
  }

  if (!entries.length) return { ok: false, error: "zip root missing" };
  const mustHave = new Set(["extension.js", "info.json"]);
  for (const need of mustHave) {
    if (!entries.some((e) => e.rel === need)) return { ok: false, error: `zip missing ${prefix}${need}` };
  }

  const extensionDir = `extension/${zipRootName}`;
  const backupDir = doBackup ? `${extensionDir}/.backup/${makeBackupStamp()}` : "";

  if (doBackup) {
    await backupFileIfExists(game, `${extensionDir}/extension.js`, `${backupDir}/extension.js`);
    await backupFileIfExists(game, `${extensionDir}/info.json`, `${backupDir}/info.json`);
    await backupFileIfExists(game, `${extensionDir}/README.md`, `${backupDir}/README.md`);
    await backupDirIfExistsGame(game, `${extensionDir}/src`, `${backupDir}/src`);
  }

  // 先清理 src，避免旧文件残留。（忽略“不存在”的错误）
  try {
    await game.promises.removeDir(`${extensionDir}/src`);
  } catch (e) {}

  let updatedFiles = 0;
  for (const it of entries) {
    const destFull = joinPath(extensionDir, it.rel);
    const data = await entryToArrayBuffer(it.entry);
    if (!data) return { ok: false, error: "unzip failed" };
    await writeFileByFullPath(game, destFull, data);
    updatedFiles++;
  }

  return { ok: true, result: { preservedExtraScripts: true, backupDir, updatedFiles } };
}

/**
 * @returns {string}
 */
function makeBackupStamp() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `slqj-ai-update-${stamp}`;
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
function isSafeZipRelPath(rel) {
  let s = String(rel || "").replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (!s) return false;
  if (s.startsWith("/") || /^[a-zA-Z]:\//.test(s)) return false;
  const parts = s.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return false;
  return true;
}

/**
 * 规范化 zip 内条目路径（只做轻量清洗，安全校验由后续流程完成）。
 *
 * @param {string} p
 * @returns {string}
 */
function normalizeZipEntryPath(p) {
  let s = String(p || "");
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  s = s.replace(/\/+/g, "/");
  return s;
}

/**
 * 兼容“zip 顶层目录名与扩展目录名不一致”的情况：
 * - 先尝试使用期望的 zipRootName
 * - 若不存在，则从 zip 内容中自动探测包含 extension.js/info.json 的根前缀
 *
 * @param {string[]} paths
 * @param {string} zipRootName
 * @returns {string|null} 返回带 trailing '/' 的 prefix；顶层无目录时返回 ''
 */
function resolveZipPrefix(paths, zipRootName) {
  const list = Array.isArray(paths) ? paths : [];
  const norm = list.map((p) => normalizeZipEntryPath(p)).filter(Boolean);
  const set = new Set(norm);

  const expectedRoot = normalizeZipEntryPath(String(zipRootName || "")).replace(/\/+$/, "");
  const expectedPrefix = expectedRoot ? expectedRoot + "/" : "";
  if (set.has(expectedPrefix + "extension.js") && set.has(expectedPrefix + "info.json")) return expectedPrefix;

  const candidates = new Set();
  for (const p of norm) {
    if (p === "extension.js") candidates.add("");
    else if (p.endsWith("/extension.js")) candidates.add(p.slice(0, -"/extension.js".length));
  }
  for (const root of candidates) {
    const cleaned = String(root || "").replace(/\/+$/, "");
    const prefix = cleaned ? cleaned + "/" : "";
    if (set.has(prefix + "extension.js") && set.has(prefix + "info.json")) return prefix;
  }

  return null;
}

/**
 * @param {any} entry
 * @returns {Promise<ArrayBuffer|null>}
 */
async function entryToArrayBuffer(entry) {
  try {
    if (entry && typeof entry.asArrayBuffer === "function") return entry.asArrayBuffer();
  } catch (e) {}
  try {
    // fallback: 某些构建下可能只有 asNodeBuffer
    if (entry && typeof entry.asNodeBuffer === "function") {
      const b = entry.asNodeBuffer();
      if (b && b.buffer) {
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
    }
  } catch (e) {}
  return null;
}

/**
 * @returns {Promise<any|null>}
 */
async function tryImportJSZip() {
  // 引擎内置：resources/app/_virtual/index2.js（JSZip 2.7.0 的 ESM 封装）
  try {
    const url = new URL("../../../../_virtual/index2.js", import.meta.url);
    const mod = await import(url.href);
    const JSZip = mod && mod.default ? mod.default : null;
    if (typeof JSZip === "function") return JSZip;
  } catch (e) {}
  try {
    // @ts-ignore
    if (typeof window !== "undefined" && window.JSZip) return window.JSZip;
  } catch (e) {}
  return null;
}

/**
 * @param {*} game
 * @param {string} srcFull
 * @param {string} destFull
 * @returns {Promise<void>}
 */
async function backupFileIfExists(game, srcFull, destFull) {
  try {
    const data = await game.promises.readFile(srcFull);
    await writeFileByFullPath(game, destFull, data);
  } catch (e) {}
}

/**
 * @param {*} game
 * @param {string} srcDir
 * @param {string} destDir
 * @returns {Promise<void>}
 */
async function backupDirIfExistsGame(game, srcDir, destDir) {
  const files = await listFilesRecursiveGame(game, srcDir);
  if (!files.length) return;
  for (const file of files) {
    const rel = file.slice(srcDir.length).replace(/^\/+/, "");
    if (!rel) continue;
    await backupFileIfExists(game, file, joinPath(destDir, rel));
  }
}

/**
 * @param {*} game
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFilesRecursiveGame(game, dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "")];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    let folders = [];
    let files = [];
    try {
      const result = await game.promises.getFileList(cur);
      folders = Array.isArray(result) ? result[0] : [];
      files = Array.isArray(result) ? result[1] : [];
    } catch (e) {
      continue;
    }
    for (const f of files || []) {
      const name = String(f || "").trim();
      if (!name) continue;
      out.push(joinPath(cur, name));
    }
    for (const d of folders || []) {
      const name = String(d || "").trim();
      if (!name) continue;
      stack.push(joinPath(cur, name));
    }
  }
  return out;
}

/**
 * @param {*} game
 * @param {string} fullPath
 * @param {any} data
 * @returns {Promise<void>}
 */
async function writeFileByFullPath(game, fullPath, data) {
  const norm = String(fullPath || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  if (idx <= 0 || idx >= norm.length - 1) throw new Error("bad path");
  const dir = norm.slice(0, idx);
  const name = norm.slice(idx + 1);
  await game.promises.writeFile(data, dir, name);
}

/**
 * @param {...string} parts
 * @returns {string}
 */
function joinPath(...parts) {
  const cleaned = [];
  for (const p of parts) {
    const s = String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (s) cleaned.push(s);
  }
  return cleaned.join("/");
}

/**
 * @param {string} baseUrl
 * @param {*} urlMod
 * @param {*} path
 * @returns {string|null}
 */
function resolveExtensionDir(baseUrl, urlMod, path) {
  try {
    const dirUrl = new URL("./", baseUrl);
    const dirPath = urlMod.fileURLToPath(dirUrl);
    return path.resolve(String(dirPath));
  } catch (e) {
    return null;
  }
}

/**
 * @param {*} fs
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function ensureDir(fs, dir) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (e) {}
}

/**
 * @param {*} fs
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function rmDirRecursive(fs, path, dir) {
  try {
    if (fs.promises.rm) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    }
  } catch (e) {}
  // fallback
  try {
    const st = await fs.promises.stat(dir);
    if (!st || !st.isDirectory()) return;
  } catch (e) {
    return;
  }
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await rmDirRecursive(fs, path, p);
    else {
      try {
        await fs.promises.unlink(p);
      } catch (e) {}
    }
  }
  try {
    await fs.promises.rmdir(dir);
  } catch (e) {}
}

/**
 * @param {*} fs
 * @param {*} path
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 */
async function copyDir(fs, path, src, dest) {
  await ensureDir(fs, dest);
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(fs, path, from, to);
    else if (ent.isFile()) {
      await ensureDir(fs, path.dirname(to));
      await fs.promises.copyFile(from, to);
    }
  }
}

/**
 * @param {*} fs
 * @param {*} path
 * @param {string} srcBase
 * @param {string} backupBase
 * @param {string} rel
 * @returns {Promise<void>}
 */
async function backupIfExists(fs, path, srcBase, backupBase, rel) {
  const src = path.join(srcBase, rel);
  const dest = path.join(backupBase, rel);
  try {
    const st = await fs.promises.stat(src);
    if (!st || !st.isFile()) return;
  } catch (e) {
    return;
  }
  await ensureDir(fs, path.dirname(dest));
  try {
    await fs.promises.copyFile(src, dest);
  } catch (e) {}
}

/**
 * @param {*} fs
 * @param {*} path
 * @param {string} srcBase
 * @param {string} backupBase
 * @param {string} rel
 * @returns {Promise<void>}
 */
async function backupDirIfExists(fs, path, srcBase, backupBase, rel) {
  const src = path.join(srcBase, rel);
  const dest = path.join(backupBase, rel);
  try {
    const st = await fs.promises.stat(src);
    if (!st || !st.isDirectory()) return;
  } catch (e) {
    return;
  }
  try {
    await copyDir(fs, path, src, dest);
  } catch (e) {}
}

/**
 * @param {string} extensionDir
 * @param {*} os
 * @param {*} path
 * @param {*} fs
 * @returns {Promise<string>}
 */
async function createBackupDir(extensionDir, path, fs) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(extensionDir, ".backup");
    const dir = path.join(base, `slqj-ai-update-${stamp}`);
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  } catch (e) {
    return "";
  }
}

/**
 * @param {string} dest
 * @param {string} root
 * @param {*} path
 * @returns {boolean}
 */
function isPathInside(dest, root, path) {
  try {
    const r = path.resolve(root);
    const d = path.resolve(dest);
    if (d === r) return true;
    const prefix = r.endsWith(path.sep) ? r : r + path.sep;
    return d.startsWith(prefix);
  } catch (e) {
    return false;
  }
}
