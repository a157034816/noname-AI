/**
 * @typedef {Object} SlqjAiScriptsRegistryV1
 * @property {1} version
 * @property {string[]} order
 * @property {Record<string, boolean>} disabled
 */

const EXTENSION_NAME = "身临其境的AI";
const CONFIG_KEY = "slqj_ai_scripts_registry";
const DEFAULT_SCRIPTS_DIR = `extension/${EXTENSION_NAME}/scripts`;

/**
 * 读取并解析脚本插件注册表配置。
 *
 * 说明：
 * - 配置内容为 JSON 字符串（由“脚本插件管理”保存）
 * - 未设置或解析失败：回退默认值
 *
 * @param {import("./ai_persona/lib/jsdoc_types.js").SlqjAiExtensionConfig|any} config
 * @param {*} lib
 * @returns {SlqjAiScriptsRegistryV1}
 */
export function readScriptsRegistry(config, lib) {
  const raw = config?.[CONFIG_KEY] ?? lib?.config?.[CONFIG_KEY];
  const fallback = /** @type {SlqjAiScriptsRegistryV1} */ ({ version: 1, order: [], disabled: {} });

  if (!raw) return fallback;
  if (typeof raw === "string") {
    const parsed = safeJsonParse(raw);
    if (!isValidRegistryShape(parsed)) return fallback;
    return normalizeRegistryShape(parsed);
  }
  // 仅允许直接传入“已规范形状”的对象（调试/开发场景）；不再做旧形状兼容/补齐。
  if (typeof raw === "object") {
    if (!isValidRegistryShape(raw)) return fallback;
    return normalizeRegistryShape(raw);
  }
  return fallback;
}

/**
 * 按当前目录文件列表归一化注册表：
 * - 清理不存在文件
 * - 追加新增文件到末尾（按文件名排序）
 *
 * @param {string[]} files
 * @param {SlqjAiScriptsRegistryV1} registry
 * @returns {SlqjAiScriptsRegistryV1}
 */
export function normalizeScriptsRegistry(files, registry) {
  const fileSet = new Set((files || []).map((f) => String(f || "")).filter(Boolean));
  const base = normalizeRegistryShape(registry);

  const order = [];
  for (const f of base.order || []) {
    const name = String(f || "");
    if (fileSet.has(name) && !order.includes(name)) order.push(name);
  }

  const remaining = Array.from(fileSet).filter((f) => !order.includes(f)).sort((a, b) => a.localeCompare(b));
  order.push(...remaining);

  /** @type {Record<string, boolean>} */
  const disabled = {};
  for (const [k, v] of Object.entries(base.disabled || {})) {
    const name = String(k || "");
    if (fileSet.has(name) && v) disabled[name] = true;
  }

  return { version: 1, order, disabled };
}

/**
 * 根据注册表计算加载顺序与跳过列表。
 *
 * @param {string[]} files
 * @param {SlqjAiScriptsRegistryV1} registry
 * @returns {{ ordered: string[], skipped: string[] }}
 */
export function getScriptsLoadPlan(files, registry) {
  const normalized = normalizeScriptsRegistry(files, registry);
  const ordered = [];
  const skipped = [];

  for (const f of normalized.order) {
    if (normalized.disabled && normalized.disabled[f]) skipped.push(f);
    else ordered.push(f);
  }
  return { ordered, skipped };
}

/**
 * 持久化注册表到配置（同时写入 extension_ 前缀与无前缀键，保持与本扩展其他配置项一致）。
 *
 * @param {*} game
 * @param {SlqjAiScriptsRegistryV1} registry
 * @returns {boolean}
 */
export function saveScriptsRegistry(game, registry) {
  if (!game || typeof game.saveConfig !== "function") return false;
  const payload = JSON.stringify(normalizeRegistryShape(registry));
  try {
    game.saveConfig(`extension_${EXTENSION_NAME}_${CONFIG_KEY}`, payload);
    game.saveConfig(CONFIG_KEY, payload);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 列出本扩展 `scripts/` 目录下的一层脚本文件（不递归）。
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl 用于解析 `scripts/` 目录的基准 URL（建议传入 `import.meta.url`）
 * @param {*=} opts.game
 * @param {string=} opts.scriptsDir
 * @returns {Promise<{files: string[], skipped: boolean, reason?: string}>}
 */
export async function listExtensionScriptFiles(opts) {
  const game = opts ? opts.game : null;
  const scriptsDir = opts && opts.scriptsDir ? String(opts.scriptsDir) : DEFAULT_SCRIPTS_DIR;

  // 优先使用引擎提供的 getFileList（可在 sandbox/浏览器环境工作）。
  const listByGame = await tryListByGame(game, scriptsDir);
  if (listByGame) {
    const files = (listByGame || [])
      .map((n) => String(n || ""))
      .filter((n) => n && (n.endsWith(".js") || n.endsWith(".mjs")))
      .sort((a, b) => a.localeCompare(b));
    return { files, skipped: false };
  }

  // 兜底：Node 环境通过 fs 枚举（部分环境可能不可用）
  const baseUrl = opts && opts.baseUrl ? String(opts.baseUrl) : "";
  const scriptsUrl = safeNewUrl("./scripts/", baseUrl);
  if (!scriptsUrl) return { files: [], skipped: true, reason: "bad baseUrl" };

  const fs = await tryImportNodeBuiltin("fs");
  const urlMod = await tryImportNodeBuiltin("url");
  if (!fs || !urlMod || typeof urlMod.fileURLToPath !== "function") {
    return { files: [], skipped: true, reason: "fs unavailable" };
  }

  let dirPath = null;
  try {
    dirPath = urlMod.fileURLToPath(scriptsUrl);
  } catch (e) {
    return { files: [], skipped: true, reason: "bad scripts url" };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return { files: [], skipped: true, reason: "scripts dir missing" };
  }

  const files = entries
    .filter((d) => d && d.isFile && d.isFile())
    .map((d) => String(d.name || ""))
    .filter((n) => n && (n.endsWith(".js") || n.endsWith(".mjs")))
    .sort((a, b) => a.localeCompare(b));

  return { files, skipped: false };
}

/**
 * @param {any} input
 * @returns {SlqjAiScriptsRegistryV1}
 */
function normalizeRegistryShape(input) {
  const version = 1;
  const order = Array.isArray(input?.order) ? input.order.map((x) => String(x || "")).filter(Boolean) : [];
  const disabled =
    input?.disabled && typeof input.disabled === "object" && !Array.isArray(input.disabled) ? input.disabled : {};
  /** @type {Record<string, boolean>} */
  const disabledOut = {};
  for (const [k, v] of Object.entries(disabled)) {
    const name = String(k || "");
    if (name && v) disabledOut[name] = true;
  }
  return { version, order, disabled: disabledOut };
}

/**
 * 判断输入是否为当前版本支持的注册表形状。
 *
 * @param {any} input
 * @returns {input is SlqjAiScriptsRegistryV1}
 */
function isValidRegistryShape(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (input.version !== 1) return false;
  if (!Array.isArray(input.order) || !input.order.every((x) => typeof x === "string")) return false;
  const disabled = input.disabled;
  if (!disabled || typeof disabled !== "object" || Array.isArray(disabled)) return false;
  for (const [k, v] of Object.entries(disabled)) {
    if (typeof k !== "string" || !k) return false;
    if (typeof v !== "boolean") return false;
  }
  return true;
}

/**
 * @param {string} text
 * @returns {any|null}
 */
function safeJsonParse(text) {
  try {
    return JSON.parse(String(text));
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} rel
 * @param {string} base
 * @returns {URL|null}
 */
function safeNewUrl(rel, base) {
  try {
    return new URL(rel, base);
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} name
 * @returns {Promise<any|null>}
 */
async function tryImportNodeBuiltin(name) {
  try {
    return await import(name);
  } catch (e) {
    return null;
  }
}

/**
 * 尝试通过引擎 `game.getFileList` 枚举目录文件。
 *
 * @param {*} game
 * @param {string} dir
 * @returns {Promise<string[]|null>}
 */
async function tryListByGame(game, dir) {
  if (!game) return null;
  try {
    if (game.promises && typeof game.promises.getFileList === "function") {
      const result = await game.promises.getFileList(dir);
      const files = Array.isArray(result) ? result[1] : null;
      return Array.isArray(files) ? files : null;
    }
    if (typeof game.getFileList === "function") {
      return await new Promise((resolve) => {
        try {
          game.getFileList(
            dir,
            (folders, files) => resolve(Array.isArray(files) ? files : []),
            () => resolve(null)
          );
        } catch (e) {
          resolve(null);
        }
      });
    }
  } catch (e) {
    return null;
  }
  return null;
}
