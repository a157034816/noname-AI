/**
 * @param {string} name
 * @returns {Promise<any|null>}
 */
export async function tryImportNodeBuiltin(name) {
  try {
    return await import(name);
  } catch (e) {
    return null;
  }
}

/**
 * @returns {Promise<{fs:any|null, path:any|null, os:any|null, url:any|null, zlib:any|null}>}
 */
export async function getNodeDeps() {
  const [fs, path, os, url, zlib] = await Promise.all([
    tryImportNodeBuiltin("fs"),
    tryImportNodeBuiltin("path"),
    tryImportNodeBuiltin("os"),
    tryImportNodeBuiltin("url"),
    tryImportNodeBuiltin("zlib"),
  ]);
  return { fs, path, os, url, zlib };
}

/**
 * @param {{game?:any}} [opts]
 * @returns {Promise<boolean>}
 */
export async function canWriteFiles(opts) {
  const game = opts?.game;
  // 无名杀环境下可能禁用 Node 内置模块，但仍可通过 game.writeFile 写入扩展目录。
  try {
    if (game && typeof game.writeFile === "function") return true;
  } catch (e) {}

  const { fs } = await getNodeDeps();
  return !!(fs && fs.promises && typeof fs.promises.writeFile === "function");
}
