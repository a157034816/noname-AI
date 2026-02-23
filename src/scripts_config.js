/**
 * scripts 插件配置（Schema + 覆盖值）工具集。
 *
 * 说明：
 * - Schema 由脚本模块导出（`export const slqjAiScriptConfig = {...}`）
 * - 覆盖值由“脚本插件管理 -> 配置(⚙)”二级弹窗保存到扩展配置 `slqj_ai_scripts_config`
 * - 运行时由 scripts_loader 注入到 `ctx.scriptConfig`，脚本可据此读取参数
 */

/**
 * @typedef {"boolean"|"number"|"string"|"select"} SlqjAiScriptConfigItemType
 */

/**
 * @typedef {Object} SlqjAiScriptConfigItemV1
 * @property {string} key
 * @property {string} name
 * @property {SlqjAiScriptConfigItemType} type
 * @property {boolean|number|string} default
 * @property {string=} description
 * @property {number=} min
 * @property {number=} max
 * @property {number=} step
 * @property {{value:string,label:string}[]=} options
 */

/**
 * @typedef {Object} SlqjAiScriptConfigSchemaV1
 * @property {1} version
 * @property {SlqjAiScriptConfigItemV1[]} items
 */

/**
 * scripts 配置持久化结构（v1）：仅保存“覆盖值”，默认值永远来自脚本 Schema。
 *
 * @typedef {Object} SlqjAiScriptsConfigStoreV1
 * @property {1} version
 * @property {Record<string, Record<string, any>>} overrides file -> {key:value}
 */

const EXTENSION_NAME = "身临其境的AI";
const CONFIG_KEY = "slqj_ai_scripts_config";

/**
 * 读取并解析 scripts 插件配置覆盖值。
 *
 * 说明：
 * - 配置内容为 JSON 字符串（由“脚本配置”保存）
 * - 未设置或解析失败：回退默认值（空覆盖）
 *
 * @param {import("./ai_persona/lib/jsdoc_types.js").SlqjAiExtensionConfig|any} config
 * @param {*} lib
 * @returns {SlqjAiScriptsConfigStoreV1}
 */
export function readScriptsConfig(config, lib) {
  const prefixedKey = `extension_${EXTENSION_NAME}_${CONFIG_KEY}`;
  const raw =
    config?.[CONFIG_KEY] ??
    lib?.config?.[CONFIG_KEY] ??
    config?.[prefixedKey] ??
    lib?.config?.[prefixedKey];
  const fallback = /** @type {SlqjAiScriptsConfigStoreV1} */ ({ version: 1, overrides: {} });
  if (!raw) return fallback;

  if (typeof raw === "string") {
    const parsed = safeJsonParse(raw);
    if (!isValidStoreShape(parsed)) return fallback;
    return normalizeStoreShape(parsed);
  }
  if (typeof raw === "object") {
    if (!isValidStoreShape(raw)) return fallback;
    return normalizeStoreShape(raw);
  }
  return fallback;
}

/**
 * 持久化 scripts 配置覆盖值到扩展配置（同时写入 extension_ 前缀与无前缀键）。
 *
 * 说明：
 * - 引擎配置在部分环境下会落盘到 IndexedDB（异步）。若不等待写入完成就立刻重启/刷新，可能出现“下次打开还是默认值”。
 * - 因此这里优先使用 `game.promises.saveConfig`，确保写入完成后再返回成功。
 *
 * @param {*} game
 * @param {SlqjAiScriptsConfigStoreV1} store
 * @returns {Promise<boolean>}
 */
export async function saveScriptsConfig(game, store) {
  if (!game) return false;
  const payload = JSON.stringify(normalizeStoreShape(store));
  const prefixedKey = `extension_${EXTENSION_NAME}_${CONFIG_KEY}`;
  try {
    if (game.promises && typeof game.promises.saveConfig === "function") {
      await game.promises.saveConfig(prefixedKey, payload);
      await game.promises.saveConfig(CONFIG_KEY, payload);
      return true;
    }
    if (typeof game.saveConfig === "function") {
      await new Promise((resolve) => {
        try {
          game.saveConfig(prefixedKey, payload, undefined, resolve);
        } catch (e) {
          resolve();
        }
      });
      await new Promise((resolve) => {
        try {
          game.saveConfig(CONFIG_KEY, payload, undefined, resolve);
        } catch (e) {
          resolve();
        }
      });
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 规范化脚本导出的配置 Schema。
 *
 * @param {any} input
 * @returns {SlqjAiScriptConfigSchemaV1|null}
 */
export function normalizeScriptConfigSchema(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.version !== 1) return null;
  if (!Array.isArray(input.items)) return null;

  /** @type {SlqjAiScriptConfigItemV1[]} */
  const items = [];
  const seen = new Set();
  for (const rawItem of input.items) {
    const normalized = normalizeItem(rawItem);
    if (!normalized) continue;
    if (seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    items.push(normalized);
  }

  return { version: 1, items };
}

/**
 * 根据 Schema 与覆盖值解析出“生效配置值”。
 *
 * @param {SlqjAiScriptConfigSchemaV1} schema
 * @param {Record<string, any>|null|undefined} overrides
 * @returns {Record<string, any>}
 */
export function resolveScriptConfigValues(schema, overrides) {
  const o = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
  /** @type {Record<string, any>} */
  const out = {};
  const items = Array.isArray(schema?.items) ? schema.items : [];
  for (const item of items) {
    const key = item.key;
    const raw = o[key];
    out[key] = coerceItemValue(item, raw);
  }
  return out;
}

/**
 * 根据 Schema 与“当前值”计算“需要持久化的覆盖值”（剔除等于 default 的字段）。
 *
 * @param {SlqjAiScriptConfigSchemaV1} schema
 * @param {Record<string, any>|null|undefined} values
 * @returns {Record<string, any>}
 */
export function computeScriptConfigOverrides(schema, values) {
  const v = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  /** @type {Record<string, any>} */
  const out = {};
  const items = Array.isArray(schema?.items) ? schema.items : [];
  for (const item of items) {
    const key = item.key;
    const current = coerceItemValue(item, v[key]);
    const def = item.default;
    if (item.type === "number" && typeof def === "number" && typeof current === "number") {
      if (!numberAlmostEqual(current, def)) out[key] = current;
      continue;
    }
    if (!Object.is(current, def)) out[key] = current;
  }
  return out;
}

/**
 * @param {any} input
 * @returns {SlqjAiScriptConfigItemV1|null}
 */
function normalizeItem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const key = String(input.key || "").trim();
  const name = String(input.name || "").trim();
  const type = String(input.type || "").trim();
  if (!key || !name) return null;
  if (type !== "boolean" && type !== "number" && type !== "string" && type !== "select") return null;

  const d = input.default;
  if (type === "boolean" && typeof d !== "boolean") return null;
  if (type === "number" && typeof d !== "number") return null;
  if (type === "string" && typeof d !== "string") return null;
  if (type === "select" && typeof d !== "string") return null;
  let defaultValue = d;

  const description = typeof input.description === "string" ? input.description : "";

  const min = typeof input.min === "number" ? input.min : undefined;
  const max = typeof input.max === "number" ? input.max : undefined;
  const step = typeof input.step === "number" ? input.step : undefined;

  /** @type {{value:string,label:string}[]|undefined} */
  let options = undefined;
  if (type === "select") {
    if (!Array.isArray(input.options)) return null;
    const normalizedOptions = [];
    for (const opt of input.options) {
      if (!opt || typeof opt !== "object" || Array.isArray(opt)) continue;
      const value = String(opt.value || "").trim();
      const label = String(opt.label || "").trim();
      if (!value || !label) continue;
      normalizedOptions.push({ value, label });
    }
    if (!normalizedOptions.length) return null;
    // 若 default 不在 options 内，则回退到第一个 option 的 value
    if (!normalizedOptions.some((o) => o.value === defaultValue)) defaultValue = normalizedOptions[0].value;
    options = normalizedOptions;
  }

  /** @type {SlqjAiScriptConfigItemV1} */
  const out = {
    key,
    name,
    type: /** @type {SlqjAiScriptConfigItemType} */ (type),
    default: defaultValue,
  };
  if (description) out.description = description;
  if (type === "number") {
    if (min !== undefined) out.min = min;
    if (max !== undefined) out.max = max;
    if (step !== undefined) out.step = step;
  }
  if (type === "select" && options) out.options = options;
  return out;
}

/**
 * @param {SlqjAiScriptConfigItemV1} item
 * @param {any} raw
 * @returns {any}
 */
function coerceItemValue(item, raw) {
  const t = item.type;
  const def = item.default;
  if (t === "boolean") return coerceBoolean(raw, /** @type {boolean} */ (def));
  if (t === "string") return coerceString(raw, /** @type {string} */ (def));
  if (t === "number") {
    const base = coerceNumber(raw, /** @type {number} */ (def));
    return clampNumber(base, item.min, item.max);
  }
  if (t === "select") return coerceSelect(raw, /** @type {string} */ (def), item.options);
  return def;
}

/**
 * @param {any} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function coerceBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  }
  return fallback;
}

/**
 * @param {any} value
 * @param {string} fallback
 * @returns {string}
 */
function coerceString(value, fallback) {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  try {
    return String(value);
  } catch (e) {
    return fallback;
  }
}

/**
 * 把可能包含全角数字/中文标点/分隔符/单位的数字文本归一化为 JS Number 可解析的格式。
 *
 * 例：
 * - `０．６` / `0。6` / `0·6` -> `0.6`
 * - `0,6` / `0，6` / `,6` -> `0.6`
 * - `1,234` / `1，234` -> `1234`
 * - `1,234.5` -> `1234.5`
 * - `50ms` -> `50`
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeNumberText(raw) {
  const s = raw == null ? "" : String(raw);
  let out = "";

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);

    // 全角数字 ０-９
    if (code >= 0xff10 && code <= 0xff19) {
      out += String.fromCharCode(code - 0xff10 + 0x30);
      continue;
    }

    // 全角正负号
    if (code === 0xff0b) {
      out += "+";
      continue;
    }
    if (code === 0xff0d) {
      out += "-";
      continue;
    }

    // 兼容常见的 Unicode 减号/破折号
    if (ch === "−" || ch === "–" || ch === "—") {
      out += "-";
      continue;
    }

    // 小数点（中文/全角/中点/部分键盘）
    if (ch === "。" || ch === "．" || ch === "｡" || ch === "﹒" || ch === "·" || ch === "・" || ch === "∙" || ch === "•") {
      out += ".";
      continue;
    }

    // 逗号（中文/顿号）
    if (ch === "，" || ch === "、") {
      out += ",";
      continue;
    }

    // 常见空白/分隔符：直接丢弃
    if (
      ch === " " ||
      ch === "\t" ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "_" ||
      ch === "\u00a0" ||
      ch === "\u202f" ||
      ch === "\u3000"
    ) {
      continue;
    }

    // 兼容全角 e/E（科学计数法）
    if (ch === "ｅ" || ch === "Ｅ") {
      out += "e";
      continue;
    }

    // 仅保留数字解析相关字符，其余（单位/中文/字母等）剔除
    if (
      (ch >= "0" && ch <= "9") ||
      ch === "+" ||
      ch === "-" ||
      ch === "." ||
      ch === "," ||
      ch === "e" ||
      ch === "E"
    ) {
      out += ch;
      continue;
    }
  }

  out = out.trim();
  if (!out) return "";

  // 兼容以逗号开头的小数：`,6` / `-,6`
  if (out[0] === ",") out = "0" + out;
  if ((out.startsWith("-,") || out.startsWith("+,")) && out.length >= 2) out = out[0] + "0" + out.slice(1);

  // 拆分科学计数法指数部分：只处理 mantissa 中的分隔符，避免干扰指数
  let mantissa = out;
  let exponent = "";
  const eIndex = (() => {
    for (let i = 1; i < out.length; i++) {
      const c = out[i];
      if (c === "e" || c === "E") return i;
    }
    return -1;
  })();
  if (eIndex > 0) {
    mantissa = out.slice(0, eIndex);
    exponent = out.slice(eIndex);
    const m = exponent.match(/^([eE][+-]?\d+)/);
    exponent = m ? m[1] : "";
  }

  // mantissa：处理逗号（千分位/小数逗号）
  if (mantissa.includes(".")) {
    mantissa = mantissa.replace(/,/g, "");
  } else {
    const commaCount = (mantissa.match(/,/g) || []).length;
    if (commaCount === 1) {
      const m = mantissa.match(/^([+-]?\d+),(\d+)$/);
      if (m) {
        const lhs = m[1];
        const rhs = m[2];
        const lhsDigits = lhs.replace(/^[+-]/, "");
        // 仅当形如 1,234 / 12,345 才视为千分位；0,6 / 0,55 等视为小数
        const isThousands = rhs.length === 3 && lhsDigits !== "0";
        mantissa = isThousands ? lhs + rhs : lhs + "." + rhs;
      } else {
        mantissa = mantissa.replace(/,/g, "");
      }
    } else if (commaCount > 1) {
      mantissa = mantissa.replace(/,/g, "");
    }
  }

  return mantissa + exponent;
}

/**
 * 尝试从字符串中解析有限数值；失败返回 null。
 *
 * @param {string} raw
 * @returns {number|null}
 */
function tryParseFiniteNumber(raw) {
  const normalized = normalizeNumberText(raw);
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
function coerceNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (value.trim() === "") return fallback;
    const n = tryParseFiniteNumber(value);
    if (n != null) return n;
  }
  return fallback;
}

/**
 * @param {any} value
 * @param {string} fallback
 * @param {{value:string,label:string}[]|undefined} options
 * @returns {string}
 */
function coerceSelect(value, fallback, options) {
  const v = typeof value === "string" ? value : value == null ? "" : String(value);
  const opts = Array.isArray(options) ? options : [];
  if (opts.some((o) => o && o.value === v)) return v;
  if (opts.some((o) => o && o.value === fallback)) return fallback;
  return opts.length ? opts[0].value : fallback;
}

/**
 * @param {number} value
 * @param {number|undefined} min
 * @param {number|undefined} max
 * @returns {number}
 */
function clampNumber(value, min, max) {
  let v = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (typeof min === "number" && Number.isFinite(min)) v = Math.max(v, min);
  if (typeof max === "number" && Number.isFinite(max)) v = Math.min(v, max);
  return v;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
function numberAlmostEqual(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1e-9;
}

/**
 * @param {any} input
 * @returns {SlqjAiScriptsConfigStoreV1}
 */
function normalizeStoreShape(input) {
  /** @type {Record<string, Record<string, any>>} */
  const overridesOut = {};
  const overrides = input?.overrides && typeof input.overrides === "object" && !Array.isArray(input.overrides) ? input.overrides : {};

  for (const [file, ov] of Object.entries(overrides)) {
    const fileKey = String(file || "").trim();
    if (!fileKey) continue;
    if (!ov || typeof ov !== "object" || Array.isArray(ov)) continue;
    /** @type {Record<string, any>} */
    const perFile = {};
    for (const [k, v] of Object.entries(ov)) {
      const key = String(k || "").trim();
      if (!key) continue;
      if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
        perFile[key] = v;
      }
    }
    if (Object.keys(perFile).length) overridesOut[fileKey] = perFile;
  }

  return { version: 1, overrides: overridesOut };
}

/**
 * @param {any} input
 * @returns {input is SlqjAiScriptsConfigStoreV1}
 */
function isValidStoreShape(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (input.version !== 1) return false;
  const overrides = input.overrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return false;
  for (const [file, ov] of Object.entries(overrides)) {
    if (typeof file !== "string" || !file) return false;
    if (!ov || typeof ov !== "object" || Array.isArray(ov)) return false;
    for (const [k, v] of Object.entries(ov)) {
      if (typeof k !== "string" || !k) return false;
      if (!(typeof v === "boolean" || typeof v === "number" || typeof v === "string")) return false;
    }
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
