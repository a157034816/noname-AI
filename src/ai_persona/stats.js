import { STORAGE_KEY } from "./lib/constants.js";
import { ensureStorage, getPid } from "./lib/utils.js";

const CORE_SCORE_DRAW_W = 0.6;
const CORE_SCORE_DAMAGE_W = 2.2;

const OUTPUT_CORE_DRAW_THRESHOLD_DEFAULT = 8;
const OUTPUT_CORE_DAMAGE_THRESHOLD_DEFAULT = 3;

/**
 * 将可能为 number/string/undefined 的阈值归一化为可用数字。
 *
 * @param {*} raw
 * @param {number} fallback
 * @returns {number}
 */
function normalizeThreshold(raw, fallback) {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
	return n;
}

/**
 * 尝试从参数/全局中取得 game 对象。
 *
 * @param {*} gameLike
 * @returns {*|null}
 */
function resolveGame(gameLike) {
	if (gameLike && typeof gameLike === "object") return gameLike;
	// eslint-disable-next-line no-undef
	if (typeof game !== "undefined" && game && typeof game === "object") return game;
	if (globalThis?.game && typeof globalThis.game === "object") return globalThis.game;
	return null;
}

/**
 * 判断某个事件是否发生在该玩家的“自身回合”内（以 activePid 为准）。
 *
 * @param {*} player
 * @param {*} gameLike
 * @returns {boolean}
 */
function isInSelfTurn(player, gameLike) {
	const g = resolveGame(gameLike);
	if (!g || !player) return false;
	const pid = getPid(player);
	if (!pid) return false;
	const activePid = String(g?.__slqjAiPersona?._turnMemoryState?.activePid || "");
	return !!activePid && pid === activePid;
}

/**
 * 若满足“任意两回合内达标”，则将 stats.outputCore 置为 true（本局内保持）。
 *
 * @param {*} stats
 * @param {{outputCoreDrawThreshold?:number, outputCoreDamageThreshold?:number}|null|undefined} cfg
 * @returns {void}
 */
function maybeLatchOutputCore(stats, cfg) {
	if (!stats || stats.outputCore === true) return;
	const td = typeof stats.turnDraw === "number" && !Number.isNaN(stats.turnDraw) ? stats.turnDraw : 0;
	const pd = typeof stats.prevTurnDraw === "number" && !Number.isNaN(stats.prevTurnDraw) ? stats.prevTurnDraw : 0;
	const tdm =
		typeof stats.turnDamageDealt === "number" && !Number.isNaN(stats.turnDamageDealt) ? stats.turnDamageDealt : 0;
	const pdm =
		typeof stats.prevTurnDamageDealt === "number" && !Number.isNaN(stats.prevTurnDamageDealt)
			? stats.prevTurnDamageDealt
			: 0;

	const draw2 = td + pd;
	const dmg2 = tdm + pdm;
	if (draw2 <= 0 && dmg2 <= 0) return;

	const drawTh = normalizeThreshold(cfg?.outputCoreDrawThreshold, OUTPUT_CORE_DRAW_THRESHOLD_DEFAULT);
	const dmgTh = normalizeThreshold(cfg?.outputCoreDamageThreshold, OUTPUT_CORE_DAMAGE_THRESHOLD_DEFAULT);
	const passDraw = drawTh <= 0 ? draw2 > 0 : draw2 >= drawTh;
	const passDmg = dmgTh <= 0 ? dmg2 > 0 : dmg2 >= dmgTh;
	if (passDraw || passDmg) stats.outputCore = true;
}

/**
 * 确保玩家 storage 内存在 stats 结构，并返回它。
 *
 * @param {*} player
 * @returns {import("./lib/jsdoc_types.js").SlqjAiStats|null}
 */
export function ensureStats(player) {
	if (!player) return null;
	const st = ensureStorage(player);
	if (!st.stats || typeof st.stats !== "object") {
		st.stats = {
			draw: 0,
			damageDealt: 0,
			// 输出核心（本局内）：在任意两回合内达标后锁定为 true
			outputCore: false,
			// 两回合窗口：仅统计“自身回合”内的过牌/伤害
			turnDraw: 0,
			turnDamageDealt: 0,
			prevTurnDraw: 0,
			prevTurnDamageDealt: 0,
		};
	}
	if (typeof st.stats.draw !== "number") st.stats.draw = 0;
	if (typeof st.stats.damageDealt !== "number") st.stats.damageDealt = 0;
	if (typeof st.stats.outputCore !== "boolean") st.stats.outputCore = false;
	if (typeof st.stats.turnDraw !== "number" || Number.isNaN(st.stats.turnDraw)) st.stats.turnDraw = 0;
	if (typeof st.stats.turnDamageDealt !== "number" || Number.isNaN(st.stats.turnDamageDealt)) st.stats.turnDamageDealt = 0;
	if (typeof st.stats.prevTurnDraw !== "number" || Number.isNaN(st.stats.prevTurnDraw)) st.stats.prevTurnDraw = 0;
	if (typeof st.stats.prevTurnDamageDealt !== "number" || Number.isNaN(st.stats.prevTurnDamageDealt)) {
		st.stats.prevTurnDamageDealt = 0;
	}
	return st.stats;
}

/**
 * 获取玩家当前统计信息（缺失则返回默认值）。
 *
 * @param {*} player
 * @returns {import("./lib/jsdoc_types.js").SlqjAiStats}
 */
export function getStats(player) {
	if (!player || !player.storage) {
		return {
			draw: 0,
			damageDealt: 0,
			outputCore: false,
			turnDraw: 0,
			turnDamageDealt: 0,
			prevTurnDraw: 0,
			prevTurnDamageDealt: 0,
		};
	}
	const st = player.storage[STORAGE_KEY];
	const s = st && st.stats;
	if (!s || typeof s !== "object") {
		return {
			draw: 0,
			damageDealt: 0,
			outputCore: false,
			turnDraw: 0,
			turnDamageDealt: 0,
			prevTurnDraw: 0,
			prevTurnDamageDealt: 0,
		};
	}
	return {
		draw: typeof s.draw === "number" && !Number.isNaN(s.draw) ? s.draw : 0,
		damageDealt: typeof s.damageDealt === "number" && !Number.isNaN(s.damageDealt) ? s.damageDealt : 0,
		outputCore: typeof s.outputCore === "boolean" ? s.outputCore : false,
		turnDraw: typeof s.turnDraw === "number" && !Number.isNaN(s.turnDraw) ? s.turnDraw : 0,
		turnDamageDealt: typeof s.turnDamageDealt === "number" && !Number.isNaN(s.turnDamageDealt) ? s.turnDamageDealt : 0,
		prevTurnDraw: typeof s.prevTurnDraw === "number" && !Number.isNaN(s.prevTurnDraw) ? s.prevTurnDraw : 0,
		prevTurnDamageDealt:
			typeof s.prevTurnDamageDealt === "number" && !Number.isNaN(s.prevTurnDamageDealt) ? s.prevTurnDamageDealt : 0,
	};
}

/**
 * 增加摸牌统计。
 *
 * @param {*} player
 * @param {number} n
 * @param {*} [gameLike]
 * @returns {void}
 */
export function addDrawStat(player, n, gameLike) {
	const s = ensureStats(player);
	if (!s) return;
	const v = typeof n === "number" && !Number.isNaN(n) ? n : 0;
	if (v <= 0) return;
	s.draw += v;

	// 仅在“自身回合”内计入两回合窗口
	if (isInSelfTurn(player, gameLike)) {
		s.turnDraw += v;
		const g = resolveGame(gameLike);
		maybeLatchOutputCore(s, g?.__slqjAiPersona?.cfg);
	}
}

/**
 * 增加造成伤害统计。
 *
 * @param {*} player
 * @param {number} n
 * @param {*} [gameLike]
 * @returns {void}
 */
export function addDamageDealtStat(player, n, gameLike) {
	const s = ensureStats(player);
	if (!s) return;
	const v = typeof n === "number" && !Number.isNaN(n) ? n : 0;
	if (v <= 0) return;
	s.damageDealt += v;

	// 仅在“自身回合”内计入两回合窗口
	if (isInSelfTurn(player, gameLike)) {
		s.turnDamageDealt += v;
		const g = resolveGame(gameLike);
		maybeLatchOutputCore(s, g?.__slqjAiPersona?.cfg);
	}
}

/**
 * 在玩家回合开始时推进“输出核心两回合窗口”（将本回合统计滚入上一回合，并清空本回合计数）。
 *
 * @param {*} player
 * @returns {void}
 */
export function rollOutputCoreTurnWindow(player) {
	const s = ensureStats(player);
	if (!s) return;
	s.prevTurnDraw = s.turnDraw;
	s.prevTurnDamageDealt = s.turnDamageDealt;
	s.turnDraw = 0;
	s.turnDamageDealt = 0;
}

/**
 * 用“输出贡献”近似衡量一个玩家的核心输出能力（用于面板展示/偏好逻辑）。
 *
 * @param {{draw?:number, damageDealt?:number}|null|undefined} stats
 * @returns {number}
 */
export function getOutputCoreScore(stats) {
	const draw = typeof stats?.draw === "number" && !Number.isNaN(stats.draw) ? stats.draw : 0;
	const dmg = typeof stats?.damageDealt === "number" && !Number.isNaN(stats.damageDealt) ? stats.damageDealt : 0;
	return draw * CORE_SCORE_DRAW_W + dmg * CORE_SCORE_DAMAGE_W;
}

/**
 * 判断一个玩家是否达到“输出核心”阈值（任意一项达标即可）。
 *
 * 说明：
 * - 达标口径：在任意连续两回合（自身回合）内累计过牌/伤害达到阈值，即在本局内视为输出核心
 * - 默认阈值：两回合过牌≥8 或 两回合伤害≥3
 * - 当阈值配置为 0 时，表示“只要该项为正数就算达标”（避免 0 也触发）
 *
 * @param {import("./lib/jsdoc_types.js").SlqjAiStats|null|undefined} stats
 * @param {{outputCoreDrawThreshold?:number, outputCoreDamageThreshold?:number}|null|undefined} cfg
 * @returns {boolean}
 */
export function isOutputCore(stats, cfg) {
	if (!stats) return false;
	if (stats.outputCore === true) return true;

	const td = typeof stats.turnDraw === "number" && !Number.isNaN(stats.turnDraw) ? stats.turnDraw : 0;
	const pd = typeof stats.prevTurnDraw === "number" && !Number.isNaN(stats.prevTurnDraw) ? stats.prevTurnDraw : 0;
	const tdm =
		typeof stats.turnDamageDealt === "number" && !Number.isNaN(stats.turnDamageDealt) ? stats.turnDamageDealt : 0;
	const pdm =
		typeof stats.prevTurnDamageDealt === "number" && !Number.isNaN(stats.prevTurnDamageDealt)
			? stats.prevTurnDamageDealt
			: 0;

	const draw2 = td + pd;
	const dmg2 = tdm + pdm;
	if (draw2 <= 0 && dmg2 <= 0) return false;

	const drawTh = normalizeThreshold(cfg?.outputCoreDrawThreshold, OUTPUT_CORE_DRAW_THRESHOLD_DEFAULT);
	const dmgTh = normalizeThreshold(cfg?.outputCoreDamageThreshold, OUTPUT_CORE_DAMAGE_THRESHOLD_DEFAULT);

	const passDraw = drawTh <= 0 ? draw2 > 0 : draw2 >= drawTh;
	const passDmg = dmgTh <= 0 ? dmg2 > 0 : dmg2 >= dmgTh;
	return passDraw || passDmg;
}

/**
 * 将身份归为“阵营”（用于输出核心统计展示）。
 *
 * - zhu: 主公/忠臣/明忠
 * - fan: 反贼
 * - other: 内奸/未知/其他
 *
 * @param {string} identity
 * @returns {"zhu"|"fan"|"other"}
 */
export function getPlayerCamp(identity) {
	const id = String(identity || "");
	if (["zhu", "zhong", "mingzhong"].includes(id)) return "zhu";
	if (id === "fan") return "fan";
	return "other";
}

/**
 * 选出当前存活“某阵营”中输出贡献最高的玩家（需先达到“输出核心”阈值）。
 *
 * 若该阵营暂无任何输出核心，则返回 null。
 *
 * @param {*} game
 * @param {"zhu"|"fan"} camp
 * @returns {*|null}
 */
export function getCampOutputCorePlayer(game, camp) {
	const c = String(camp || "other");
	const players = (game && game.players) || [];
	const cfg = game?.__slqjAiPersona?.cfg;
	let best = null;
	let bestScore = -Infinity;
	for (const p of players) {
		if (!p) continue;
		if (p.isDead && p.isDead()) continue;
		if (getPlayerCamp(p.identity) !== c) continue;
		const stats = getStats(p);
		if (!isOutputCore(stats, cfg)) continue;
		const score = getOutputCoreScore(stats);
		if (score > bestScore) {
			bestScore = score;
			best = p;
		}
	}
	return best;
}
