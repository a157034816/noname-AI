import { STORAGE_KEY } from "../lib/constants.js";
import { ensureStorage, getPid } from "../lib/utils.js";

/**
 * 安全读取卡牌 info（缺失/异常时回退 null）。
 *
 * @param {*} card
 * @param {*} get
 * @returns {any|null}
 */
function safeGetCardInfo(card, get) {
	if (!card || typeof get?.info !== "function") return null;
	try {
		return get.info(card, false) || get.info(card) || null;
	} catch (e) {
		try {
			return get.info(card) || null;
		} catch (e2) {
			return null;
		}
	}
}

/**
 * 判断某牌是否属于“群体/全体”指向（selectTarget:-1 规则）。
 *
 * @param {*} card
 * @param {*} get
 * @returns {boolean}
 */
function isGroupTargetCard(card, get) {
	const info = safeGetCardInfo(card, get);
	const st = info ? info.selectTarget : undefined;
	return st === -1 || (Array.isArray(st) && st.includes(-1));
}

/**
 * 安全读取卡牌 ai tag（缺失/异常回退 false）。
 *
 * @param {*} card
 * @param {string} tag
 * @param {*} get
 * @returns {boolean}
 */
function safeGetCardAiTag(card, tag, get) {
	if (!card || typeof get?.tag !== "function") return false;
	try {
		return !!get.tag(card, tag);
	} catch (e) {
		return false;
	}
}

/**
 * 判断是否为“单目标主动进攻”（用于“刚刚攻击的人我不救”的触发标记）。
 *
 * 判定规则（保守）：
 * - 仅单目标：trigger.targets.length===1
 * - 排除“群体/全体”牌：selectTarget:-1
 * - 需要具备伤害倾向：get.tag(card,"damage") 或常见直伤牌名兜底
 *
 * @param {*} trigger
 * @param {*} get
 * @returns {boolean}
 */
function isSingleTargetOffenseTrigger(trigger, get) {
	if (!trigger || !trigger.card) return false;
	const ts = Array.isArray(trigger.targets) ? trigger.targets : [];
	if (ts.length !== 1) return false;
	if (isGroupTargetCard(trigger.card, get)) return false;

	const name = String(trigger.card?.name || "");
	if (!name) return false;
	if (safeGetCardAiTag(trigger.card, "damage", get)) return true;
	// 兜底：常见直伤（避免部分环境 tag 缺失导致漏判）
	return name === "sha" || name === "juedou" || name === "huogong";
}

/**
 * 记录“刚刚被我单点攻击的目标”（窗口=本次结算链，直到 useCardAfter 清空）。
 *
 * 写入位置：player.storage[STORAGE_KEY].runtime.recentAttack
 *
 * @param {*} trigger useCardToTargeted 事件
 * @param {*} player 出牌者（本地 AI）
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRecentAttackMark(trigger, player, game, get, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !player || !game) return;
	if (!trigger.card || !trigger.target) return;
	if (!isSingleTargetOffenseTrigger(trigger, get)) return;

	const st = ensureStorage(player);
	st.runtime ??= { turnsTaken: 0, installedAtRound: game.roundNumber || 0 };
	st.runtime.recentAttack = {
		targetPid: getPid(trigger.target),
		cardName: String(trigger.card?.name || trigger.card?.viewAs || ""),
		setAtRound: typeof game.roundNumber === "number" && !Number.isNaN(game.roundNumber) ? game.roundNumber : 0,
	};
}

/**
 * 清空“刚刚攻击标记”（窗口结束）。
 *
 * @param {*} _trigger useCardAfter 事件（未强依赖其字段）
 * @param {*} player 出牌者（本地 AI）
 * @returns {void}
 */
export function onRecentAttackClear(_trigger, player) {
	const st = player?.storage?.[STORAGE_KEY];
	if (!st?.runtime) return;
	if (!st.runtime.recentAttack) return;
	st.runtime.recentAttack = null;
}

