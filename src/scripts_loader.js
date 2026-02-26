/**
 * @typedef {Object} SlqjAiScriptContext
 * @property {*} lib
 * @property {*} game
 * @property {*} ui
 * @property {*} get
 * @property {*} ai
 * @property {*} _status
 * @property {import("./ai_persona/lib/jsdoc_types.js").SlqjAiExtensionConfig|null} config
 * @property {import("./ai_persona/lib/jsdoc_types.js").SlqjAiHookBus|null} hooks
 * @property {string=} scriptFile 当前脚本文件名（例如：`01_xxx.js`）
 * @property {Record<string, any>=} scriptConfig 当前脚本生效配置（已合并默认值+用户覆盖）
 */

import { listExtensionScriptFiles, readScriptsRegistry, getScriptsLoadPlan } from "./scripts_registry.js";
import { readScriptsConfig, normalizeScriptConfigSchema, resolveScriptConfigValues } from "./scripts_config.js";
import { get as getLogger } from "./logger/manager.js";

/**
 * scripts 插件模块的“约定入口”集合。
 * @typedef {{
 *  default?: (ctx: SlqjAiScriptContext) => (any|Promise<any>),
 *  setup?: (ctx: SlqjAiScriptContext) => (any|Promise<any>),
 *  install?: (ctx: SlqjAiScriptContext) => (any|Promise<any>)
 * }} SlqjAiScriptModule
 */

/**
 * 加载本扩展 `scripts/` 目录下的一层脚本文件（不递归）。
 *
 * 约定：
 * - 默认按文件名排序依次加载 `scripts/*.js` / `scripts/*.mjs`
 * - 若配置了 `slqj_ai_scripts_registry`（由“脚本插件管理”UI维护），则按其顺序加载并跳过被禁用的脚本
 * - 对每个模块：
 *   - 先执行 `import()`（允许模块仅靠副作用注册 hook）
 *   - 若导出 `default` / `setup` / `install` 且为函数，则会以 (ctx) 形式调用
 * - 若运行环境无法访问 Node.js 的 `fs`（无法遍历目录），则跳过加载并仅输出 warning
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl 用于解析 `scripts/` 目录的基准 URL（建议传入 `import.meta.url`）
 * @param {*} opts.lib
 * @param {*} opts.game
 * @param {*} opts.ui
 * @param {*} opts.get
 * @param {*} opts.ai
 * @param {*} opts._status
 * @param {*} opts.config
 * @returns {Promise<{loaded: string[], failed: Array<{file: string, error: any}>, skipped: boolean}>}
 */
export async function loadExtensionScripts(opts) {
  const baseUrl = opts && opts.baseUrl ? String(opts.baseUrl) : "";
  const game = opts ? opts.game : null;
  const lib = opts ? opts.lib : null;
  const config = opts ? opts.config : null;
  const logger = getLogger("console");

  const enable = config?.slqj_ai_scripts_enable ?? lib?.config?.slqj_ai_scripts_enable ?? true;
  if (!enable) return { loaded: [], failed: [], skipped: true };

  const listResult = await listExtensionScriptFiles({ baseUrl, game });
  if (listResult.skipped) {
    try {
      logger.warn("scripts", "skip (" + String(listResult.reason || "unknown") + ")");
    } catch (e) {}
    return { loaded: [], failed: [], skipped: true };
  }

  const files = listResult.files || [];
  const registry = readScriptsRegistry(config, lib);
  const scriptsConfigStore = readScriptsConfig(config, lib);
  const plan = getScriptsLoadPlan(files, registry);
  const scriptsUrl = safeNewUrl("./scripts/", baseUrl);
  if (!scriptsUrl) return { loaded: [], failed: [], skipped: true };

  const ctx = /** @type {SlqjAiScriptContext} */ ({
    lib: opts ? opts.lib : null,
    game: opts ? opts.game : null,
    ui: opts ? opts.ui : null,
    get: opts ? opts.get : null,
    ai: opts ? opts.ai : null,
    _status: opts ? opts._status : null,
    config: opts ? opts.config : null,
    hooks: game
      ? game.slqjAiHooks || game.__slqjAiPersona?.hooks || null
      : null,
  });

  const loaded = [];
  const failed = [];
  const skipped = plan.skipped || [];

  for (const file of plan.ordered || []) {
    try {
      const modUrl = new URL(file, scriptsUrl);
      const mod = await import(modUrl.href);
      loaded.push(file);

      /** @type {Record<string, any>} */
      let scriptConfig = {};
      try {
        const schema = normalizeScriptConfigSchema(mod && mod.slqjAiScriptConfig);
        const overrides =
          scriptsConfigStore &&
          scriptsConfigStore.overrides &&
          typeof scriptsConfigStore.overrides === "object" &&
          scriptsConfigStore.overrides[file] &&
          typeof scriptsConfigStore.overrides[file] === "object"
            ? scriptsConfigStore.overrides[file]
            : null;
        if (schema && Array.isArray(schema.items) && schema.items.length) {
          scriptConfig = resolveScriptConfigValues(schema, overrides);
        }
      } catch (e) {}

      const fn = pickEntryFunction(mod);
      if (typeof fn === "function") {
        await fn({ ...ctx, scriptFile: file, scriptConfig });
      }
    } catch (e) {
      failed.push({ file, error: e });
      try {
        logger.error("scripts", "load failed:", file, e);
      } catch (e2) {}
    }
  }

  // 便于调试：记录加载结果（不保证存在 __slqjAiPersona）
  try {
    if (game) {
      const root =
        game.__slqjAiPersona && typeof game.__slqjAiPersona === "object"
          ? game.__slqjAiPersona
          : {};
      game.__slqjAiPersona = root;
      root.scripts = {
        loaded: loaded.slice(),
        skipped: skipped.slice(),
        failed: failed.map((r) => r.file),
        order: (plan.ordered || []).slice(),
      };
    }
  } catch (e) {}

  return { loaded, failed, skipped: false };
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
 * 从 scripts 插件模块中挑选入口函数。
 *
 * @param {SlqjAiScriptModule|any} mod
 * @returns {((ctx: SlqjAiScriptContext)=>any|Promise<any>)|null}
 */
function pickEntryFunction(mod) {
  if (!mod) return null;
  if (typeof mod.default === "function") return mod.default;
  if (typeof mod.setup === "function") return mod.setup;
  if (typeof mod.install === "function") return mod.install;
  return null;
}
