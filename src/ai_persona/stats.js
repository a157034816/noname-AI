import { STORAGE_KEY } from "./lib/constants.js";
import { ensureStorage } from "./lib/utils.js";

const CORE_SCORE_DRAW_W = 0.6;
const CORE_SCORE_DAMAGE_W = 2.2;

/**
 * 确保玩家 storage 内存在 stats 结构，并返回它。
 *
 * @param {*} player
 * @returns {{draw:number, damageDealt:number}|null}
 */
export function ensureStats(player) {
	if (!player) return null;
	const st = ensureStorage(player);
	if (!st.stats || typeof st.stats !== "object") {
		st.stats = { draw: 0, damageDealt: 0 };
	}
	if (typeof st.stats.draw !== "number") st.stats.draw = 0;
	if (typeof st.stats.damageDealt !== "number") st.stats.damageDealt = 0;
	return st.stats;
}

/**
 * 获取玩家当前统计信息（缺失则返回默认值）。
 *
 * @param {*} player
 * @returns {{draw:number, damageDealt:number}}
 */
export function getStats(player) {
	if (!player || !player.storage) return { draw: 0, damageDealt: 0 };
	const st = player.storage[STORAGE_KEY];
	const s = st && st.stats;
	if (!s || typeof s !== "object") return { draw: 0, damageDealt: 0 };
	return {
		draw: typeof s.draw === "number" && !Number.isNaN(s.draw) ? s.draw : 0,
		damageDealt: typeof s.damageDealt === "number" && !Number.isNaN(s.damageDealt) ? s.damageDealt : 0,
	};
}

/**
 * 增加摸牌统计。
 *
 * @param {*} player
 * @param {number} n
 * @returns {void}
 */
export function addDrawStat(player, n) {
	const s = ensureStats(player);
	if (!s) return;
	const v = typeof n === "number" && !Number.isNaN(n) ? n : 0;
	if (v > 0) s.draw += v;
}

/**
 * 增加造成伤害统计。
 *
 * @param {*} player
 * @param {number} n
 * @returns {void}
 */
export function addDamageDealtStat(player, n) {
	const s = ensureStats(player);
	if (!s) return;
	const v = typeof n === "number" && !Number.isNaN(n) ? n : 0;
	if (v > 0) s.damageDealt += v;
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
 * 选出当前存活“某阵营”中输出贡献最高的玩家。
 *
 * @param {*} game
 * @param {"zhu"|"fan"} camp
 * @returns {*|null}
 */
export function getCampOutputCorePlayer(game, camp) {
	const c = String(camp || "other");
	const players = (game && game.players) || [];
	let best = null;
	let bestScore = -Infinity;
	for (const p of players) {
		if (!p) continue;
		if (p.isDead && p.isDead()) continue;
		if (getPlayerCamp(p.identity) !== c) continue;
		const score = getOutputCoreScore(getStats(p));
		if (score > bestScore) {
			bestScore = score;
			best = p;
		}
	}
	return best;
}
