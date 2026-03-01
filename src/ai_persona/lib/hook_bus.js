/**
 * Hook 订阅选项。
 *
 * 说明：
 * - `priority`：数值越大越先执行
 * - `once`：执行一次后自动解绑
 * - `title`：策略功能名（用于“AI决策”统计面板展示），例如“锦囊牌通用策略优化”
 *
 * @typedef {{priority?:number, once?:boolean, title?:string}} HookOptions
 */

import logManager from "../../logger/manager.js";

/**
 * @typedef {{on:Function, off:Function, emit:Function, has:Function, clear:Function, list:Function}} HookBus
 */

const SCORE_EVENT = "slqj_ai_score";

/**
 * 决策类型（对应选择器补丁包装的 chooseCard/chooseTarget/chooseButton）。
 *
 * @typedef {"chooseCard"|"chooseTarget"|"chooseButton"} SlqjAiDecisionKind
 */

/**
 * 某策略在某类决策下的计数器。
 *
 * @typedef {{cover:number, hit:number, pick:number}} SlqjAiDecisionCounters
 */

/**
 * 按决策类型分组的计数器集合。
 *
 * @typedef {{chooseCard:SlqjAiDecisionCounters, chooseTarget:SlqjAiDecisionCounters, chooseButton:SlqjAiDecisionCounters}} SlqjAiDecisionCountersByKind
 */

/**
 * 策略元信息（每个 `slqj_ai_score` 的 hook handler 视为一条策略）。
 *
 * @typedef {{
 *  id: number,
 *  event: string,
 *  title: string,
 *  fnName: string,
 *  priority: number,
 *  once: boolean,
 *  registeredAt: number,
 *  stack: string,
 *  origin: string,
 *  active: boolean,
 * }} SlqjAiHookStrategyMeta
 */

/**
 * 单个决策步的临时数据（用于覆盖/命中/最终选用归因）。
 *
 * @typedef {{
 *  id: number,
 *  kind: SlqjAiDecisionKind,
 *  createdAt: number,
 *  finalized: boolean,
 *  touched: Set<number>,
 *  objectCandidateDeltas: WeakMap<object, Map<number, number>>,
 *  primitiveCandidateDeltas: Map<string, Map<number, number>>,
 * }} SlqjAiDecisionStep
 */

/**
 * 一次“选择会话”（一次 chooseX 调用），可能包含多个决策步。
 *
 * @typedef {{
 *  id: number,
 *  kind: SlqjAiDecisionKind,
 *  createdAt: number,
 *  currentStep: SlqjAiDecisionStep|null,
 *  lastAllRef: any,
 * }} SlqjAiDecisionSession
 */

/**
 * 创建“AI 决策统计”存储（与 HookBus 共存，专用于 `slqj_ai_score` 的策略覆盖率/命中率/最终选用率）。
 *
 * 说明：
 * - “策略”= 通过 `hooks.on('slqj_ai_score', handler, ...)` 注册的每个 handler
 * - “决策步”= 一次 chooseCard/chooseTarget/chooseButton 的单次选中（由外部通过 `finalizeSelection` 通知）
 *
 * @returns {{
 *  registerStrategy: (meta: Omit<SlqjAiHookStrategyMeta, 'id'|'registeredAt'|'active'>) => SlqjAiHookStrategyMeta,
 *  markStrategyInactive: (id: number) => void,
 *  beginSession: (args: {kind: SlqjAiDecisionKind}) => SlqjAiDecisionSession,
 *  endSession: (session: SlqjAiDecisionSession) => void,
 *  beginStep: (session: SlqjAiDecisionSession, allRef: any) => SlqjAiDecisionStep,
 *  recordDelta: (step: SlqjAiDecisionStep|null|undefined, strategyId: number, candidate: any, delta: number) => void,
 *  finalizeSelection: (kind: SlqjAiDecisionKind, winner: any) => void,
 *  clear: () => void,
 *  snapshot: () => {
 *    totalsByKind: Record<string, number>,
 *    strategies: Array<{meta: SlqjAiHookStrategyMeta, statsByKind: SlqjAiDecisionCountersByKind}>,
 *  },
 * }}
 */
function createDecisionStatsStore() {
  /** @type {Map<number, SlqjAiHookStrategyMeta>} */
  const metaById = new Map();
  /** @type {Map<number, SlqjAiDecisionCountersByKind>} */
  const statsById = new Map();
  /** @type {Record<string, number>} */
  const totalsByKind = { chooseCard: 0, chooseTarget: 0, chooseButton: 0 };
  /** @type {SlqjAiDecisionSession[]} */
  const sessionStack = [];

  let nextStrategyId = 1;
  let nextSessionId = 1;
  let nextStepId = 1;

  /**
   * 创建空计数器（cover/hit/pick 全为 0）。
   *
   * @returns {SlqjAiDecisionCounters}
   */
  function createEmptyCounters() {
    return { cover: 0, hit: 0, pick: 0 };
  }

  /**
   * 创建按 kind 分组的空统计对象。
   *
   * @returns {SlqjAiDecisionCountersByKind}
   */
  function createEmptyStatsByKind() {
    return {
      chooseCard: createEmptyCounters(),
      chooseTarget: createEmptyCounters(),
      chooseButton: createEmptyCounters(),
    };
  }

  /**
   * 确保某策略 id 在 statsById 中存在统计对象（若无则初始化）。
   *
   * @param {number} id
   * @returns {SlqjAiDecisionCountersByKind}
   */
  function ensureStatsById(id) {
    let stats = statsById.get(id);
    if (!stats) {
      stats = createEmptyStatsByKind();
      statsById.set(id, stats);
    }
    return stats;
  }

  /**
   * 尝试从 Error.stack 中提取“注册位置”（第一条非 hook_bus 的堆栈行）。
   *
   * @param {string} stack
   * @returns {string}
   */
  function extractOriginFromStack(stack) {
    const s = String(stack || "");
    if (!s) return "";
    const lines = s.split(/\r?\n/).map((l) => String(l || "").trim()).filter(Boolean);
    for (const line of lines) {
      if (line.includes("hook_bus.js")) continue;
      if (line.includes("createHookBus")) continue;
      // 末尾通常是 (url:line:col) 或 url:line:col
      const m = line.match(/\(?([^()]+?:\d+:\d+)\)?$/);
      if (m && m[1]) return m[1];
    }
    return "";
  }

  /**
   * 登记一个策略（一个 hook handler）并分配自增 id。
   *
   * @param {Omit<SlqjAiHookStrategyMeta, 'id'|'registeredAt'|'active'>} meta
   * @returns {SlqjAiHookStrategyMeta}
   */
  function registerStrategy(meta) {
    const id = nextStrategyId++;
    const now = Date.now();
    const stack = String(meta?.stack || "");
    const rec = /** @type {SlqjAiHookStrategyMeta} */ ({
      id,
      event: String(meta?.event || ""),
      title: String(meta?.title || ""),
      fnName: String(meta?.fnName || ""),
      priority: typeof meta?.priority === "number" ? meta.priority : 0,
      once: !!meta?.once,
      registeredAt: now,
      stack,
      origin: String(meta?.origin || extractOriginFromStack(stack) || ""),
      active: true,
    });

    metaById.set(id, rec);
    ensureStatsById(id);
    return rec;
  }

  /**
   * 将策略标记为 inactive（通常发生在 off/once 自动解绑后）。
   *
   * @param {number} id
   * @returns {void}
   */
  function markStrategyInactive(id) {
    const meta = metaById.get(id);
    if (meta) meta.active = false;
  }

  /**
   * 开始一次“选择会话”（一次 chooseCard/chooseTarget/chooseButton 调用）。
   *
   * 说明：
   * - 会话用于容纳多个“决策步”（例如多选/循环选择时可能出现多个步）
   *
   * @param {{kind: SlqjAiDecisionKind}} args
   * @returns {SlqjAiDecisionSession}
   */
  function beginSession(args) {
    const kind = /** @type {SlqjAiDecisionKind} */ (String(args?.kind || ""));
    const session = /** @type {SlqjAiDecisionSession} */ ({
      id: nextSessionId++,
      kind,
      createdAt: Date.now(),
      currentStep: null,
      lastAllRef: null,
    });
    sessionStack.push(session);
    return session;
  }

  /**
   * 结束会话：从栈中移除该 session。
   *
   * @param {SlqjAiDecisionSession} session
   * @returns {void}
   */
  function endSession(session) {
    if (!session) return;
    // LIFO 正常路径：优先弹出栈顶；异常则兜底扫描删除。
    const last = sessionStack[sessionStack.length - 1];
    if (last === session) {
      sessionStack.pop();
      return;
    }
    for (let i = sessionStack.length - 1; i >= 0; i--) {
      if (sessionStack[i] === session) {
        sessionStack.splice(i, 1);
        return;
      }
    }
  }

  /**
   * 开始一个“决策步”（候选集发生变化时会创建新的 step）。
   *
   * @param {SlqjAiDecisionSession} session
   * @param {any} allRef
   * @returns {SlqjAiDecisionStep}
   */
  function beginStep(session, allRef) {
    const step = /** @type {SlqjAiDecisionStep} */ ({
      id: nextStepId++,
      kind: session.kind,
      createdAt: Date.now(),
      finalized: false,
      touched: new Set(),
      objectCandidateDeltas: new WeakMap(),
      primitiveCandidateDeltas: new Map(),
    });
    session.currentStep = step;
    session.lastAllRef = allRef;
    return step;
  }

  /**
   * 将原始值（非对象）转换为稳定 key，用于 Map 存储候选项 delta。
   *
   * @param {any} v
   * @returns {string}
   */
  function buildPrimitiveKey(v) {
    const t = typeof v;
    if (t === "string") return `s:${v}`;
    if (t === "number") return `n:${Number.isNaN(v) ? "NaN" : String(v)}`;
    if (t === "boolean") return `b:${v ? "1" : "0"}`;
    if (v === null) return "null";
    if (v === undefined) return "undef";
    try {
      return `${t}:${String(v)}`;
    } catch (e) {
      return `${t}:?`;
    }
  }

  /**
   * 记录某策略对某候选项的评分增量 delta（after-before）。
   *
   * 说明：
   * - 仅记录非 0 且有限的 delta
   * - touched 用于统计“覆盖”
   *
   * @param {SlqjAiDecisionStep|null|undefined} step
   * @param {number} strategyId
   * @param {any} candidate
   * @param {number} delta
   * @returns {void}
   */
  function recordDelta(step, strategyId, candidate, delta) {
    if (!step || step.finalized) return;
    if (typeof delta !== "number" || Number.isNaN(delta) || !Number.isFinite(delta)) return;
    if (Math.abs(delta) < 1e-12) return;

    step.touched.add(strategyId);

    /** @type {Map<number, number>|undefined} */
    let m = void 0;
    if (candidate && (typeof candidate === "object" || typeof candidate === "function")) {
      try {
        m = step.objectCandidateDeltas.get(candidate);
      } catch (e) {}
      if (!m) {
        m = new Map();
        try {
          step.objectCandidateDeltas.set(candidate, m);
        } catch (e) {
          // 忽略：极端情况下 WeakMap.set 可能抛错（如被冻结对象/异常宿主实现）。
        }
      }
    } else {
      const key = buildPrimitiveKey(candidate);
      m = step.primitiveCandidateDeltas.get(key);
      if (!m) {
        m = new Map();
        step.primitiveCandidateDeltas.set(key, m);
      }
    }

    const prev = typeof m.get(strategyId) === "number" ? m.get(strategyId) : 0;
    m.set(strategyId, prev + delta);
  }

  /**
   * 从栈中查找某 kind 的当前活跃会话（从栈顶向下）。
   *
   * @param {SlqjAiDecisionKind} kind
   * @returns {SlqjAiDecisionSession|null}
   */
  function findActiveSession(kind) {
    for (let i = sessionStack.length - 1; i >= 0; i--) {
      const s = sessionStack[i];
      if (s && s.kind === kind) return s;
    }
    return null;
  }

  /**
   * 取得“最终选中项”对应的策略 delta 映射（strategyId -> delta）。
   *
   * @param {SlqjAiDecisionStep} step
   * @param {any} winner
   * @returns {Map<number, number>|null}
   */
  function getWinnerDeltaMap(step, winner) {
    if (!step) return null;
    if (winner && (typeof winner === "object" || typeof winner === "function")) {
      try {
        return step.objectCandidateDeltas.get(winner) || null;
      } catch (e) {
        return null;
      }
    }
    const key = buildPrimitiveKey(winner);
    return step.primitiveCandidateDeltas.get(key) || null;
  }

  /**
   * 结束当前决策步：写入 totals 与每个策略的 cover/hit/pick 计数。
   *
   * @param {SlqjAiDecisionKind} kind
   * @param {any} winner
   * @returns {void}
   */
  function finalizeSelection(kind, winner) {
    const session = findActiveSession(kind);
    const step = session?.currentStep;
    if (!session || !step || step.finalized) return;
    step.finalized = true;

    totalsByKind[kind] = (totalsByKind[kind] || 0) + 1;

    const winnerMap = getWinnerDeltaMap(step, winner);

    // 1) 覆盖：在该步内对任意候选产生过 delta 的策略
    for (const strategyId of step.touched) {
      const stats = ensureStatsById(strategyId);
      stats[kind].cover += 1;
    }

    // 2) 命中：对最终选中项产生过 delta 的策略
    /** @type {number|null} */
    let pickId = null;
    let pickAbs = 0;
    if (winnerMap && winnerMap.size) {
      for (const [strategyId, delta] of winnerMap.entries()) {
        if (typeof delta !== "number" || Number.isNaN(delta) || !Number.isFinite(delta)) continue;
        if (Math.abs(delta) < 1e-12) continue;

        const stats = ensureStatsById(strategyId);
        stats[kind].hit += 1;

        const abs = Math.abs(delta);
        if (abs > pickAbs + 1e-12) {
          pickAbs = abs;
          pickId = strategyId;
        } else if (Math.abs(abs - pickAbs) <= 1e-12 && pickId != null) {
          // 并列：按 strategyId 较小者作为“最终选用”归因（保证唯一归因）
          pickId = Math.min(pickId, strategyId);
        }
      }
    }

    // 3) 最终选用：winner 上 |delta| 最大的策略（若全为 0 则不归因）
    if (pickId != null && pickAbs > 1e-12) {
      const stats = ensureStatsById(pickId);
      stats[kind].pick += 1;
    }

    // 清空当前步（避免重复 finalize）
    session.currentStep = null;
    session.lastAllRef = null;
  }

  /**
   * 清空统计（不移除策略元信息）。
   *
   * @returns {void}
   */
  function clear() {
    totalsByKind.chooseCard = 0;
    totalsByKind.chooseTarget = 0;
    totalsByKind.chooseButton = 0;
    for (const id of statsById.keys()) {
      statsById.set(id, createEmptyStatsByKind());
    }
  }

  /**
   * 生成用于 UI 展示的快照（已做拷贝，避免外部篡改内部状态）。
   *
   * @returns {{
   *  totalsByKind: Record<string, number>,
   *  strategies: Array<{meta: SlqjAiHookStrategyMeta, statsByKind: SlqjAiDecisionCountersByKind}>,
   * }}
   */
  function snapshot() {
    const totals = { ...totalsByKind };
    const strategies = Array.from(metaById.values())
      // “尽数列出”：active + inactive 都返回（UI 可据此标灰/筛选）。
      .filter((m) => m && m.event === SCORE_EVENT)
      // active 优先（方便用户优先查看当前仍生效的策略），其次按 id 升序保持稳定。
      .sort((a, b) => {
        const aa = a && a.active ? 1 : 0;
        const bb = b && b.active ? 1 : 0;
        if (aa !== bb) return bb - aa;
        return a.id - b.id;
      })
      .map((m) => {
        const st = statsById.get(m.id) || createEmptyStatsByKind();
        // 深拷贝（避免外部修改内部对象）
        const statsCopy = {
          chooseCard: { ...st.chooseCard },
          chooseTarget: { ...st.chooseTarget },
          chooseButton: { ...st.chooseButton },
        };
        return { meta: { ...m }, statsByKind: statsCopy };
      });
    return { totalsByKind: totals, strategies };
  }

  return {
    registerStrategy,
    markStrategyInactive,
    beginSession,
    endSession,
    beginStep,
    recordDelta,
    finalizeSelection,
    clear,
    snapshot,
  };
}

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
  const decisionStats = createDecisionStatsStore();

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
    const title = opts && typeof opts.title === "string" ? String(opts.title).trim() : "";

    /** @type {SlqjAiHookStrategyMeta|null} */
    let meta = null;
    let wrapped = fn;

    // 仅对 slqj_ai_score：记录策略元信息并在运行时统计 delta
    if (name === SCORE_EVENT) {
      let stack = "";
      try {
        stack = String(new Error().stack || "");
      } catch (e) {}
      meta = decisionStats.registerStrategy({
        event: name,
        title,
        fnName: String(fn && fn.name ? fn.name : ""),
        priority,
        once,
        stack,
        origin: "",
        // active/registeredAt 由 registerStrategy 填充
      });

      wrapped = function (ctx) {
        const before = ctx && typeof ctx.score === "number" ? ctx.score : null;
        const step = ctx && typeof ctx === "object" ? ctx.__slqjAiDecisionStep : null;
        const candidate = ctx && typeof ctx === "object" ? ctx.candidate : null;

        const res = fn(ctx);
        const afterCtx = res !== undefined ? res : ctx;
        const after = afterCtx && typeof afterCtx.score === "number" ? afterCtx.score : null;

        if (meta && typeof before === "number" && typeof after === "number") {
          decisionStats.recordDelta(step, meta.id, candidate, after - before);
        }

        return res;
      };
    }

    const rec = { fn: wrapped, originalFn: fn, priority: priority, once: once, meta };
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
      if (!list[i]) continue;
      if (list[i].fn === fn || list[i].originalFn === fn) {
        if (name === SCORE_EVENT && list[i].meta && typeof list[i].meta.id === "number") {
          decisionStats.markStrategyInactive(list[i].meta.id);
        }
        list.splice(i, 1);
      }
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
        const prev = ctx;
        const res = rec.fn(ctx);
        if (res !== undefined) {
          ctx = res;

          // slqj_ai_score: 若 handler 返回了新的 ctx 对象，则尽量把追踪字段透传下去
          // （避免后续策略 handler 统计丢失）。
          try {
            if (name === SCORE_EVENT && prev && ctx && typeof prev === "object" && typeof ctx === "object") {
              if (prev.__slqjAiDecisionStep && !ctx.__slqjAiDecisionStep) ctx.__slqjAiDecisionStep = prev.__slqjAiDecisionStep;
              if (typeof prev.kind !== "undefined" && typeof ctx.kind === "undefined") ctx.kind = prev.kind;
              if (typeof prev.candidate !== "undefined" && typeof ctx.candidate === "undefined") ctx.candidate = prev.candidate;
            }
          } catch (e) {}
        }
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

  return {
    on,
    off,
    emit,
    has,
    clear,
    list,

    // 扩展调试/统计入口（不影响既有 HookBus 使用）
    __slqjAiDecisionStats: decisionStats,
  };
}
