/**
 * @typedef {{priority?:number, once?:boolean}} HookOptions
 */

import logManager from "../../logger/manager.js";

/**
 * @typedef {{on:Function, off:Function, emit:Function, has:Function, clear:Function, list:Function}} HookBus
 */

/**
 * 创建一个简单的 Hook Bus（事件总线）。
 *
 * 特性：
 * - 支持 priority（数值越大越先执行）
 * - 支持 once（执行一次后自动解绑）
 * - handler 若返回非 undefined，将作为新的 ctx 继续向后传递
 * - handler 可通过 ctx.stop = true 终止后续 handler
 *
 * @returns {HookBus}
 */
export function createHookBus() {
  const logger = logManager;
  const map = new Map();

  /**
   * @param {any} name
   * @returns {string}
   */
  function normalizeEventName(name) {
    const s = String(name || "").trim();
    if (!s) return "";
    return s;
  }

  /**
   * @param {string} name
   * @param {boolean} create
   * @returns {Array<{fn:Function,priority:number,once:boolean}>|null}
   */
  function getList(name, create) {
    name = normalizeEventName(name);
    if (!name) return null;
    let list = map.get(name);
    if (!list && create) {
      list = [];
      map.set(name, list);
    }
    return list;
  }

  /**
   * 订阅事件。
   *
   * @param {string} name
   * @param {Function} fn
   * @param {HookOptions=} opts
   * @returns {Function} 取消订阅函数
   */
  function on(name, fn, opts) {
    name = normalizeEventName(name);
    if (!name || typeof fn !== "function") return function () {};

    const list = getList(name, true);
    const priority = opts && typeof opts.priority === "number" ? opts.priority : 0;
    const once = !!(opts && opts.once);

    const rec = { fn: fn, priority: priority, once: once };
    list.push(rec);
    list.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    return function () {
      off(name, fn);
    };
  }

  /**
   * 取消订阅（移除同名事件下匹配的 handler）。
   *
   * @param {string} name
   * @param {Function} fn
   * @returns {void}
   */
  function off(name, fn) {
    const list = getList(name, false);
    if (!list || !list.length) return;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].fn === fn) list.splice(i, 1);
    }
    if (!list.length) map.delete(normalizeEventName(name));
  }

  /**
   * 判断某事件是否有订阅者。
   *
   * @param {string} name
   * @returns {boolean}
   */
  function has(name) {
    const list = getList(name, false);
    return !!(list && list.length);
  }

  /**
   * 触发事件。
   *
   * @param {string} name
   * @param {any} ctx
   * @returns {any} 事件链执行后的 ctx（可能被 handler 替换）
   */
  function emit(name, ctx) {
    name = normalizeEventName(name);
    const list = getList(name, false);
    if (!list || !list.length) return ctx;

    for (const rec of list.slice()) {
      try {
        const res = rec.fn(ctx);
        if (res !== undefined) ctx = res;
      } catch (e) {
        try {
          logger.error("hook", name, e);
        } catch (e2) {}
      }

      if (rec.once) off(name, rec.fn);
      if (ctx && ctx.stop === true) break;
    }

    return ctx;
  }

  /**
   * 清空事件订阅。
   *
   * @param {string=} name 不传表示清空全部
   * @returns {void}
   */
  function clear(name) {
    name = normalizeEventName(name);
    if (!name) {
      map.clear();
      return;
    }
    map.delete(name);
  }

  /**
   * 列出所有已注册事件名。
   *
   * @returns {string[]}
   */
  function list() {
    return Array.from(map.keys());
  }

  return { on, off, emit, has, clear, list };
}
