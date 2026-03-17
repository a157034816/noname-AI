import { isAiPersonaTrackedPlayer, ensureStorage, getPid } from "../lib/utils.js";
import { rollOutputCoreTurnWindow } from "../stats.js";

/**
 * @typedef {import("../lib/jsdoc_types.js").SlqjAiTurnEvent} SlqjAiTurnEvent
 * @typedef {import("../lib/jsdoc_types.js").SlqjAiTurnMemory} SlqjAiTurnMemory
 */

const MAX_TURN_EVENTS = 80;

/**
 * 确保 game.__slqjAiPersona._turnMemoryState 存在，并返回该对象。
 *
 * @param {*} game
 * @returns {{id:number, activePid:string}}
 */
function ensureTurnMemoryState(game) {
	if (!game) return { id: 0, activePid: "" };
	const root = game.__slqjAiPersona;
	if (!root || typeof root !== "object") return { id: 0, activePid: "" };
	root._turnMemoryState ??= { id: 0, activePid: "" };
	const st = root._turnMemoryState;
	if (!st || typeof st !== "object") {
		root._turnMemoryState = { id: 0, activePid: "" };
		return root._turnMemoryState;
	}
	if (typeof st.id !== "number" || Number.isNaN(st.id)) st.id = 0;
	if (typeof st.activePid !== "string") st.activePid = "";
	return st;
}

/**
 * 为某个 AI 玩家确保 runtime.turnMemory 已对齐到当前回合。
 *
 * @param {*} observer
 * @param {*} game
 * @param {{id:number, activePid:string}} state
 * @returns {SlqjAiTurnMemory}
 */
function ensureObserverTurnMemory(observer, game, state) {
	const st = ensureStorage(observer);
	st.runtime ??= { turnsTaken: 0, installedAtRound: game?.roundNumber || 0 };

	/** @type {any} */
	let tm = st.runtime.turnMemory;
	const okShape =
		tm &&
		typeof tm === "object" &&
		typeof tm.turnId === "number" &&
		tm.turnId === state.id &&
		Array.isArray(tm.events);

	if (!okShape) {
		tm = { turnId: state.id, activePid: state.activePid, events: [] };
		st.runtime.turnMemory = tm;
	} else {
		// activePid 可能在异常情况下为空，这里做一次同步修正
		tm.activePid = state.activePid;
	}

	// 防御性：限制单回合记录长度，避免异常事件导致数组无限增长
	if (tm.events.length > MAX_TURN_EVENTS) {
		tm.events.splice(0, tm.events.length - MAX_TURN_EVENTS);
	}
	return tm;
}

/**
 * 尝试从事件链上解析“造成者”（source/discarder/player），尽力满足“粒度细到是谁造成的”。
 *
 * @param {*} evt
 * @param {*} victim
 * @returns {*|null}
 */
function resolveSourcePlayerFromEventChain(evt, victim) {
	let e = evt;
	for (let i = 0; i < 12 && e; i++) {
		if (e.source && e.source !== victim) return e.source;
		if (e.discarder && e.discarder !== victim) return e.discarder;
		// 有些事件只带 player（施加者），无 source 字段
		if (e.player && e.player !== victim) return e.player;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return null;
}

/**
 * 将一次事件写入“相关的本地 AI 玩家”的回合记忆。
 *
 * 相关规则（与需求一致）：
 * - 只记录 observer 自己被影响（targetPid===observerPid）
 * - 或 observer 自己造成（sourcePid===observerPid）
 *
 * @param {*} game
 * @param {*} _status
 * @param {SlqjAiTurnEvent} rec
 * @returns {void}
 */
function pushTurnEventToAllLocalAI(game, _status, rec) {
	if (!game || !rec) return;
	const state = ensureTurnMemoryState(game);
	if (!state || typeof state.id !== "number") return;

	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		const observerPid = getPid(observer);
		const sourcePid = String(rec.sourcePid || "");
		const targetPid = String(rec.targetPid || "");
		if (!observerPid) continue;
		if (observerPid !== sourcePid && observerPid !== targetPid) continue;
		const tm = ensureObserverTurnMemory(observer, game, state);
		// 避免对象引用在多观察者间共享（虽然当前不会再改动，但这里更稳妥）
		const copy = {
			kind: rec.kind,
			sourcePid,
			targetPid,
			num: rec.num,
			via: rec.via,
			cardNames: Array.isArray(rec.cardNames) ? rec.cardNames.slice(0) : undefined,
			cardName: rec.cardName,
		};
		tm.events.push(copy);
		if (tm.events.length > MAX_TURN_EVENTS) tm.events.shift();
	}
}

/**
 * 在回合开始（phaseBeginStart）时重置“本回合记忆”（所有本地 AI）。
 *
 * 触发点选择：
 * - phaseBeginStart：等价于“某玩家回合开始”的稳定锚点
 *
 * @param {*} trigger phaseBeginStart 事件
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
export function onPhaseBeginStartTurnMemoryReset(trigger, game, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !game) return;
	// 防止同一 global 触发被多次执行（全局技能在不同 owner 上可能重复触发）
	if (trigger._slqjAiTurnMemoryResetDone) return;
	trigger._slqjAiTurnMemoryResetDone = true;

	const state = ensureTurnMemoryState(game);
	state.id = (state.id || 0) + 1;
	state.activePid = getPid(trigger.player);
	// 同步推进“输出核心两回合窗口”：以 phaseBeginStart 作为“自身回合开始”的锚点
	if (trigger.player) rollOutputCoreTurnWindow(trigger.player);

	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		const st = ensureStorage(observer);
		st.runtime ??= { turnsTaken: 0, installedAtRound: game.roundNumber || 0 };
		st.runtime.turnMemory = { turnId: state.id, activePid: state.activePid, events: [] };
	}
}

/**
 * 记录一次伤害结算（damageEnd）：扣血事件。
 *
 * @param {*} trigger damageEnd 事件
 * @param {*} victim 受伤者（event.player）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onDamageEndTurnMemory(trigger, victim, game, get, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !victim || !game) return;

	const n = typeof trigger.num === "number" && !Number.isNaN(trigger.num) ? trigger.num : 1;
	if (n <= 0) return;

	const source = trigger.source || resolveSourcePlayerFromEventChain(trigger, victim);
	const sourcePid = source ? getPid(source) : "";
	const targetPid = getPid(victim);
	const cardName = String(trigger?.card?.name || trigger?.card?.viewAs || "");

	pushTurnEventToAllLocalAI(game, _status, {
		kind: "damage",
		sourcePid,
		targetPid,
		num: n,
		cardName: cardName || undefined,
	});
}

/**
 * 记录一次流失体力结算（loseHpEnd）：扣血事件（非 damage）。
 *
 * 说明：
 * - loseHp 事件本身通常不带 source 字段，这里尽力从事件链推断造成者
 *
 * @param {*} trigger loseHpEnd 事件
 * @param {*} victim 流失体力者（event.player）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onLoseHpEndTurnMemory(trigger, victim, game, get, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !victim || !game) return;

	const n = typeof trigger.num === "number" && !Number.isNaN(trigger.num) ? trigger.num : 1;
	if (n <= 0) return;

	const source = trigger.source || resolveSourcePlayerFromEventChain(trigger, victim);
	const sourcePid = source ? getPid(source) : "";
	const targetPid = getPid(victim);

	pushTurnEventToAllLocalAI(game, _status, {
		kind: "loseHp",
		sourcePid,
		targetPid,
		num: n,
	});
}

/**
 * 记录一次回复体力结算（recoverEnd）：加血事件。
 *
 * @param {*} trigger recoverEnd 事件
 * @param {*} target 回复者（event.player）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRecoverEndTurnMemory(trigger, target, game, get, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !target || !game) return;

	const n = typeof trigger.num === "number" && !Number.isNaN(trigger.num) ? trigger.num : 1;
	if (n <= 0) return;

	const source = trigger.source || resolveSourcePlayerFromEventChain(trigger, target);
	const sourcePid = source ? getPid(source) : "";
	const targetPid = getPid(target);
	const cardName = String(trigger?.card?.name || trigger?.card?.viewAs || "");

	pushTurnEventToAllLocalAI(game, _status, {
		kind: "recover",
		sourcePid,
		targetPid,
		num: n,
		cardName: cardName || undefined,
	});
}

/**
 * 记录一次摸牌结算（drawAfter）：摸牌事件。
 *
 * @param {*} trigger drawAfter 事件
 * @param {*} target 摸牌者（event.player）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onDrawAfterTurnMemory(trigger, target, game, get, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !target || !game) return;

	const n0 = typeof trigger.num === "number" && !Number.isNaN(trigger.num) ? trigger.num : 0;
	const n1 = Array.isArray(trigger.cards) ? trigger.cards.length : 0;
	const n = n0 || n1;
	if (n <= 0) return;

	const source = trigger.source || resolveSourcePlayerFromEventChain(trigger, target);
	const sourcePid = source ? getPid(source) : "";
	const targetPid = getPid(target);

	pushTurnEventToAllLocalAI(game, _status, {
		kind: "draw",
		sourcePid,
		targetPid,
		num: n,
	});
}

/**
 * 记录一次弃牌结算（discardAfter）：弃牌事件。
 *
 * @param {*} trigger discardAfter 事件
 * @param {*} target 弃牌者（event.player）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onDiscardAfterTurnMemory(trigger, target, game, get, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !target || !game) return;

	const cards = Array.isArray(trigger.cards) ? trigger.cards : [];
	if (!cards.length) return;

	const discarder = trigger.discarder || trigger.source || resolveSourcePlayerFromEventChain(trigger, target);
	const sourcePid = discarder ? getPid(discarder) : "";
	const targetPid = getPid(target);
	const cardNames = cards
		.map(c => String(c?.name || c?.viewAs || ""))
		.filter(Boolean);

	pushTurnEventToAllLocalAI(game, _status, {
		kind: "discard",
		sourcePid,
		targetPid,
		num: cards.length,
		via: "discard",
		cardNames: cardNames.length ? cardNames : undefined,
	});
}

/**
 * 记录一次“置入弃牌堆”结算（loseToDiscardpileAfter）：弃牌事件（可能来自他人效果）。
 *
 * @param {*} trigger loseToDiscardpileAfter 事件
 * @param {*} target 失去牌者（event.player）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onLoseToDiscardpileAfterTurnMemory(trigger, target, game, get, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !target || !game) return;

	const cards = Array.isArray(trigger.cards) ? trigger.cards : [];
	if (!cards.length) return;

	const source = trigger.source || resolveSourcePlayerFromEventChain(trigger, target);
	const sourcePid = source ? getPid(source) : "";
	const targetPid = getPid(target);
	const cardNames = cards
		.map(c => String(c?.name || c?.viewAs || ""))
		.filter(Boolean);

	pushTurnEventToAllLocalAI(game, _status, {
		kind: "discard",
		sourcePid,
		targetPid,
		num: cards.length,
		via: "loseToDiscardpile",
		cardNames: cardNames.length ? cardNames : undefined,
	});
}
