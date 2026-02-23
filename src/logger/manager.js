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
