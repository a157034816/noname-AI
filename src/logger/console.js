/**
 * 控制台输出封装：扩展 core 的唯一 console 输出入口。
 *
 * 设计目标：
 * - 永不抛错（console 不存在/方法缺失时静默跳过）
 * - 统一 prefix + feature
 * - 保留 console 的格式化能力：当首个内容参数为 string 时，将前缀合并进 format string
 */

/**
 * @typedef {(...args:any[])=>void} SlqjLogMethod
 */

/**
 * @typedef {{
 *  prefix?: string,
 *  debug?: boolean | (() => boolean),
 * }} SlqjConsoleLoggerOptions
 */

/**
 * @typedef {{
 *  log:(feature:any, ...args:any[])=>void,
 *  warn:(feature:any, ...args:any[])=>void,
 *  error:(feature:any, ...args:any[])=>void,
 *  debug:(feature:any, ...args:any[])=>void,
 *  isDebug:()=>boolean,
 * }} SlqjLogger
 */
export class ConsoleLogger {
  /**
   * @param {SlqjConsoleLoggerOptions} [opts]
   */
  constructor(opts) {
    this.prefix = opts && opts.prefix != null ? String(opts.prefix) : "";
    this._isDebug = normalizeDebugResolver(opts ? opts.debug : undefined);
  }

  /**
   * @param {any} feature
   * @param {...any} args
   * @returns {void}
   */
  log(feature, ...args) {
    this._out("log", feature, args);
  }

  /**
   * @param {any} feature
   * @param {...any} args
   * @returns {void}
   */
  warn(feature, ...args) {
    this._out("warn", feature, args);
  }

  /**
   * @param {any} feature
   * @param {...any} args
   * @returns {void}
   */
  error(feature, ...args) {
    this._out("error", feature, args);
  }

  /**
   * @param {any} feature
   * @param {...any} args
   * @returns {void}
   */
  debug(feature, ...args) {
    try {
      if (!this.isDebug()) return;
    } catch (e) {
      return;
    }
    this._out("debug", feature, args);
  }

  /**
   * @returns {boolean}
   */
  isDebug() {
    try {
      return !!this._isDebug();
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {"log"|"warn"|"error"|"debug"} level
   * @param {any} feature
   * @param {any[]} args
   * @returns {void}
   */
  _out(level, feature, args) {
    try {
      const c = getConsole();
      if (!c) return;
      const fn = pickConsoleMethod(c, level);
      if (!fn) return;
      const finalArgs = buildArgsWithPrefixAndFeature(this.prefix, feature, args);
      fn.apply(c, finalArgs);
    } catch (e) {}
  }
}

export class NoopLogger {
  /** @returns {void} */
  log() {}
  /** @returns {void} */
  warn() {}
  /** @returns {void} */
  error() {}
  /** @returns {void} */
  debug() {}
  /** @returns {boolean} */
  isDebug() {
    return false;
  }
}

/** @type {SlqjLogger} */
export const NOOP_LOGGER = new NoopLogger();

/**
 * @returns {Console|null}
 */
function getConsole() {
  try {
    if (typeof console === "undefined") return null;
    return console || null;
  } catch (e) {
    return null;
  }
}

/**
 * @param {Console} c
 * @param {"log"|"warn"|"error"|"debug"} level
 * @returns {Function|null}
 */
function pickConsoleMethod(c, level) {
  try {
    /** @type {any} */
    const anyConsole = c;

    const primary = anyConsole && anyConsole[level];
    if (typeof primary === "function") return primary;

    const fallback = anyConsole && anyConsole.log;
    if (typeof fallback === "function") return fallback;

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 当首个内容参数为 string 时将 prefix/feature 合并进 format string，
 * 否则将 prefix/feature 作为第一个参数传入。
 *
 * @param {string} prefix
 * @param {any} feature
 * @param {any[]} args
 * @returns {any[]}
 */
function buildArgsWithPrefixAndFeature(prefix, feature, args) {
  const f = String(feature == null ? "" : feature).trim();
  const p = prefix ? String(prefix) : "";
  const head = f ? (p ? `${p}[${f}]` : `[${f}]`) : (p || "[logger]");

  const rest = Array.isArray(args) ? args : [];
  if (!rest.length) return [head];
  if (typeof rest[0] === "string") return [head + " " + rest[0]].concat(rest.slice(1));
  return [head].concat(rest);
}

/**
 * @param {boolean|(()=>boolean)|undefined} debug
 * @returns {()=>boolean}
 */
function normalizeDebugResolver(debug) {
  if (typeof debug === "function") return debug;
  return () => !!debug;
}
