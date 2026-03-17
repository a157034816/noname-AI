import { NOOP_LOGGER } from "./console.js";
import { SLQJ_AI_EXTENSION_NAME } from "../version.js";

/**
 * @typedef {{
 *  log:(feature:any, ...args:any[])=>void,
 *  warn:(feature:any, ...args:any[])=>void,
 *  error:(feature:any, ...args:any[])=>void,
 *  debug:(feature:any, ...args:any[])=>void,
 *  isDebug:()=>boolean,
 * }} SlqjLogger
 */

/**
 * @typedef {{
 *  prefix?: string,
 *  debug?: boolean|(()=>boolean),
 * }} SlqjLoggerRegisterOptions
 */

/** @type {Map<string, {cls:any, logger: SlqjLogger}>} */
const registry = new Map();

/**
 * 按名称注册 logger 实例。
 *
 * 说明：
 * - `get(name)` 必须在 `register(name, 类)` 之后才能获得真实实例；否则返回 noop（不输出、不报错）
 * - 同名重复注册默认返回首次实例（不覆盖），避免多处持有不同实例造成输出不一致
 * - 调用方可通过 `opts.prefix` 自定义输出前缀
 *
 * @param {string} name
 * @param {new (opts:any)=>SlqjLogger} LoggerClass
 * @param {SlqjLoggerRegisterOptions} [opts]
 * @returns {SlqjLogger}
 */
export function register(name, LoggerClass, opts) {
  const key = normalizeName(name);
  const existed = registry.get(key);
  if (existed && existed.logger) return existed.logger;

  const logger = createLogger(key, LoggerClass, opts);
  if (logger !== NOOP_LOGGER) {
    registry.set(key, { cls: LoggerClass, logger });
  }
  return logger;
}

/**
 * 按名称获取 logger；若未注册则返回共享 noop logger（不输出、不报错）。
 *
 * @param {string} name
 * @returns {SlqjLogger}
 */
export function get(name) {
  const key = normalizeName(name);
  const existed = registry.get(key);
  if (existed && existed.logger) return existed.logger;
  return NOOP_LOGGER;
}

/**
 * 广播：将日志输出到所有已注册的 logger。
 *
 * @param {"log"|"warn"|"error"|"debug"} level
 * @param {any} feature
 * @param {any[]} args
 * @returns {void}
 */
function broadcast(level, feature, args) {
  const entries = Array.from(registry.values());
  for (const entry of entries) {
    const logger = entry && entry.logger;
    if (!logger) continue;
    try {
      /** @type {any} */
      const anyLogger = logger;
      const fn = anyLogger && anyLogger[level];
      if (typeof fn !== "function") continue;
      fn.call(logger, feature, ...(Array.isArray(args) ? args : []));
    } catch (e) {}
  }
}

/**
 * 统一处理参数：支持 `log(feature, ...args)` 与 `log(message)` 两种调用方式。
 *
 * @param {any} featureOrMsg
 * @param {any[]} args
 * @returns {{feature:any, args:any[]}}
 */
function normalizeFeatureAndArgs(featureOrMsg, args) {
  const rest = Array.isArray(args) ? args : [];
  if (!rest.length) {
    if (typeof featureOrMsg === "undefined") return { feature: "", args: [] };
    return { feature: "", args: [featureOrMsg] };
  }
  return { feature: featureOrMsg == null ? "" : featureOrMsg, args: rest };
}

/**
 * 输出普通日志：触发所有已注册 logger。
 *
 * @param {any} featureOrMsg
 * @param {...any} args
 * @returns {void}
 */
export function log(featureOrMsg, ...args) {
  const n = normalizeFeatureAndArgs(featureOrMsg, args);
  broadcast("log", n.feature, n.args);
}

/**
 * 输出 info 日志（别名）：等价于 `log(...)`。
 *
 * @param {any} featureOrMsg
 * @param {...any} args
 * @returns {void}
 */
export function info(featureOrMsg, ...args) {
  log(featureOrMsg, ...args);
}

/**
 * 输出 warning 日志：触发所有已注册 logger。
 *
 * @param {any} featureOrMsg
 * @param {...any} args
 * @returns {void}
 */
export function warn(featureOrMsg, ...args) {
  const n = normalizeFeatureAndArgs(featureOrMsg, args);
  broadcast("warn", n.feature, n.args);
}

/**
 * 输出 error 日志：触发所有已注册 logger。
 *
 * @param {any} featureOrMsg
 * @param {...any} args
 * @returns {void}
 */
export function error(featureOrMsg, ...args) {
  const n = normalizeFeatureAndArgs(featureOrMsg, args);
  broadcast("error", n.feature, n.args);
}

/**
 * 输出 debug 日志：触发所有已注册 logger。
 *
 * @param {any} featureOrMsg
 * @param {...any} args
 * @returns {void}
 */
export function debug(featureOrMsg, ...args) {
  const n = normalizeFeatureAndArgs(featureOrMsg, args);
  broadcast("debug", n.feature, n.args);
}

/**
 * 是否有任一已注册 logger 处于 debug 开启状态。
 *
 * @returns {boolean}
 */
export function isDebug() {
  const entries = Array.from(registry.values());
  for (const entry of entries) {
    const logger = entry && entry.logger;
    if (!logger) continue;
    try {
      if (typeof logger.isDebug === "function" && logger.isDebug()) return true;
    } catch (e) {}
  }
  return false;
}

/**
 * @param {string} name
 * @param {new (opts:any)=>SlqjLogger} LoggerClass
 * @param {SlqjLoggerRegisterOptions|undefined} opts
 * @returns {SlqjLogger}
 */
function createLogger(name, LoggerClass, opts) {
  try {
    if (typeof LoggerClass !== "function") return NOOP_LOGGER;

    const prefix =
      opts && opts.prefix != null ? String(opts.prefix) : buildDefaultPrefix(name);
    const debug = opts ? opts.debug : undefined;

    // LoggerClass 仅约定 prefix/debug 等字段，额外字段可忽略。
    const logger = new LoggerClass({ name, prefix, debug });
    return logger || NOOP_LOGGER;
  } catch (e) {
    return NOOP_LOGGER;
  }
}

/**
 * @param {any} name
 * @returns {string}
 */
function normalizeName(name) {
  const key = String(name == null ? "" : name).trim();
  return key || "default";
}

/**
 * @param {string} name
 * @returns {string}
 */
function buildDefaultPrefix(name) {
  const base = SLQJ_AI_EXTENSION_NAME ? `[${SLQJ_AI_EXTENSION_NAME}]` : "";
  if (!name) return base || "[logger]";
  if (!base) return `[${name}]`;
  return `${base}[${name}]`;
}

/**
 * @typedef {{
 *  register: typeof register,
 *  get: typeof get,
 *  log: typeof log,
 *  info: typeof info,
 *  warn: typeof warn,
 *  error: typeof error,
 *  debug: typeof debug,
 *  isDebug: typeof isDebug,
 * }} SlqjLogManager
 */

/**
 * 日志管理器：暴露与 logger 类似的调用方式，并将输出广播到所有已注册 logger。
 *
 * 用法示例：
 * - `logManager.log("hello")`
 * - `logManager.warn("scripts", "skip", reason)`
 *
 * @type {SlqjLogManager}
 */
export const logManager = { register, get, log, info, warn, error, debug, isDebug };

export default logManager;
