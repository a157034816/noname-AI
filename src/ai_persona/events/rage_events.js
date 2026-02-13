import { STORAGE_KEY } from "../lib/constants.js";
import { isAiPersonaTrackedPlayer } from "../lib/utils.js";
import { addRage, addRageTowards } from "../memory.js";

/**
 * 被加血后降低全局怒气（rage）的基础系数。
 *
 * 数值越大：回血越“冷静”（怒气掉得更快）。
 * 数值越小：怒气更容易保留（更容易堆到 4+）。
 *
 * 可在文件头部直接调参（满足“核心代码头部可配置常量”的需求）。
 *
 * @type {number}
 */
const RAGE_CALM_PER_HEAL = 1.0;

/**
 * 安全读取 persona id。
 *
 * @param {*} player
 * @returns {string}
 */
function safeGetPersonaId(player) {
  return String(player?.storage?.[STORAGE_KEY]?.persona?.id || "");
}

/**
 * 获取怒气增长倍率（按人格类型）。
 *
 * @param {string} personaId
 * @returns {number}
 */
function getRageGainMultiplier(personaId) {
  if (personaId === "impulsive") return 1.15;
  if (personaId === "petty") return 1.05;
  if (personaId === "camouflage") return 0.9;
  return 1.0;
}

/**
 * 获取“被加血后冷静”的倍率（按人格类型）。
 *
 * @param {string} personaId
 * @returns {number}
 */
function getRageCalmMultiplier(personaId) {
  if (personaId === "impulsive") return 0.9;
  if (personaId === "petty") return 0.95;
  if (personaId === "camouflage") return 1.05;
  return 1.0;
}

/**
 * 安全读取卡牌位置（缺失时回退空字符串）。
 *
 * @param {*} get
 * @param {*} card
 * @returns {string}
 */
function safeGetCardPosition(get, card) {
  if (!card) return "";
  if (typeof get?.position === "function") {
    try {
      return String(get.position(card) || "");
    } catch (e) {
      return "";
    }
  }
  return "";
}

/**
 * 计算拆/顺时的“位置因子”：拆装备区/判定区更容易激起怒气。
 *
 * @param {any[]} cards
 * @param {*} get
 * @returns {number}
 */
function computePosFactor(cards, get) {
  let factor = 1.0;
  for (const c of cards) {
    const pos = safeGetCardPosition(get, c);
    if (!pos) continue;
    if (pos.includes("e") || pos.includes("j")) factor = Math.max(factor, 1.2);
  }
  return factor;
}

/**
 * 受伤结算：本地 AI 受伤会提升怒气；若存在伤害来源则同时提升对其怒气。
 *
 * @param {*} trigger damageEnd 事件
 * @param {*} victim 受伤者
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onDamageEndRage(trigger, victim, game, get, _status) {
  if (_status?.connectMode) return;
  if (!trigger || !victim || !game) return;
  if (!isAiPersonaTrackedPlayer(victim, game, _status)) return;

  const personaId = safeGetPersonaId(victim);
  if (!personaId) return;

  const d = typeof trigger.num === "number" && !Number.isNaN(trigger.num) ? trigger.num : 1;
  if (d <= 0) return;

  const gainM = getRageGainMultiplier(personaId);
  addRage(victim, d * 1.4 * gainM);

  const source = trigger.source;
  if (source && source !== victim) {
    addRageTowards(victim, source, d * 1.9 * gainM);
  }
}

/**
 * 拆牌结算（rewriteDiscardResult）：目标为本地 AI 时提升其怒气与对来源玩家怒气。
 *
 * @param {*} trigger rewriteDiscardResult 事件
 * @param {*} player 行为者（过河拆桥使用者）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRewriteDiscardResultRage(trigger, player, game, get, _status) {
  if (_status?.connectMode) return;
  if (!trigger || !player || !game) return;

  const parent = typeof trigger.getParent === "function" ? trigger.getParent() : null;
  if (String(parent?.name || "") !== "guohe") return;

  const target = trigger.target;
  if (!target || target === player) return;
  if (!isAiPersonaTrackedPlayer(target, game, _status)) return;

  const personaId = safeGetPersonaId(target);
  if (!personaId) return;

  const cards = Array.isArray(trigger.cards) ? trigger.cards : [];
  if (!cards.length) return;

  const gainM = getRageGainMultiplier(personaId);
  const posFactor = computePosFactor(cards, get);
  const n = cards.length;

  addRage(target, n * 0.9 * posFactor * gainM);
  addRageTowards(target, player, n * 1.2 * posFactor * gainM);
}

/**
 * 顺牌结算（rewriteGainResult）：目标为本地 AI 时提升其怒气与对来源玩家怒气。
 *
 * @param {*} trigger rewriteGainResult 事件
 * @param {*} player 行为者（顺手牵羊使用者）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRewriteGainResultRage(trigger, player, game, get, _status) {
  if (_status?.connectMode) return;
  if (!trigger || !player || !game) return;

  const parent = typeof trigger.getParent === "function" ? trigger.getParent() : null;
  if (String(parent?.name || "") !== "shunshou") return;

  const target = trigger.target;
  if (!target || target === player) return;
  if (!isAiPersonaTrackedPlayer(target, game, _status)) return;

  const personaId = safeGetPersonaId(target);
  if (!personaId) return;

  const cards = Array.isArray(trigger.cards) ? trigger.cards : [];
  if (!cards.length) return;

  const gainM = getRageGainMultiplier(personaId);
  const posFactor = computePosFactor(cards, get);
  const n = cards.length;

  addRage(target, n * 0.9 * posFactor * gainM);
  addRageTowards(target, player, n * 1.2 * posFactor * gainM);
}

/**
 * 回复体力结算：本地 AI 被加血会降低其全局怒气（只影响全局，不直接改定向怒气）。
 *
 * @param {*} trigger recoverEnd 事件
 * @param {*} player 回复者
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRecoverEndRage(trigger, player, game, get, _status) {
  if (_status?.connectMode) return;
  if (!trigger || !player || !game) return;
  if (!isAiPersonaTrackedPlayer(player, game, _status)) return;

  const personaId = safeGetPersonaId(player);
  if (!personaId) return;

  const heal = typeof trigger.num === "number" && !Number.isNaN(trigger.num) ? trigger.num : 1;
  if (heal <= 0) return;

  const calmM = getRageCalmMultiplier(personaId);
  addRage(player, -heal * RAGE_CALM_PER_HEAL * calmM);
}
