import { STORAGE_KEY } from "./constants.js";

/**
 * 将数字限制在 [min, max] 区间内。
 *
 * @param {number} num
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(num, min, max) {
	return Math.max(min, Math.min(max, num));
}

/**
 * 线性插值：a + (b-a)*t。
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
	return a + (b - a) * t;
}

/**
 * 获取玩家的“稳定标识”（用于 map key 等）：优先 playerid，其次 position，最后回退为 String(player)。
 *
 * @param {*} player
 * @returns {string}
 */
export function getPid(player) {
	return player?.playerid ?? player?.dataset?.position ?? String(player);
}

/**
 * 确保 player.storage[STORAGE_KEY] 存在并返回它。
 *
 * @param {{storage: Record<string, any>}} player
 * @returns {import("./jsdoc_types.js").SlqjAiStorage}
 */
export function ensureStorage(player) {
	if (!player) return /** @type {any} */ ({});
	player.storage ??= {};
	player.storage[STORAGE_KEY] ??= {};
	return player.storage[STORAGE_KEY];
}

/**
 * 判断玩家是否为“本地 AI 玩家”（默认不含玩家本人、不含联机）。
 *
 * 说明：
 * - 非自机玩家：沿用原规则（离线、非 connectMode、非 online）即视为“本地 AI”
 * - 自机玩家（game.me）：仅在托管（isAuto===true）时视为“本地 AI”（避免影响手操）
 *
 * 该函数主要用于“决策逻辑/脚本门槛”（例如 `slqj_ai_score`、scripts 插件等）。
 *
 * @param {*} player
 * @param {*} game
 * @param {*} _status
 * @returns {boolean}
 */
export function isLocalAIPlayer(player, game, _status) {
	if (!player) return false;
	const st = _status || globalThis?._status;
	if (st?.connectMode) return false;
	try {
		if (typeof player.isOnline === "function" && player.isOnline()) return false;
	} catch (e) {}

	// 玩家本人：默认不影响手操；仅在托管（isAuto===true）时视为“本地 AI”
	if (player === game?.me) {
		return player.isAuto === true;
	}
	return true;
}

/**
 * 判断玩家是否需要被“人格/心智模型”追踪（persona/memory/runtime 的初始化、事件记录与衰减）。
 *
 * 说明：
 * - 非自机玩家：沿用原规则（离线、非 connectMode、非 online）即追踪
 * - 自机玩家（game.me）：
 *   - 始终追踪（即便未托管），用于面板展示与托管接管的数据连续性
 *
 * @param {*} player
 * @param {*} game
 * @param {*} _status
 * @returns {boolean}
 */
export function isAiPersonaTrackedPlayer(player, game, _status) {
	if (!player) return false;
	const st = _status || globalThis?._status;
	if (st?.connectMode) return false;
	try {
		if (typeof player.isOnline === "function" && player.isOnline()) return false;
	} catch (e) {}

	if (player !== game?.me) return true;
	return true;
}
