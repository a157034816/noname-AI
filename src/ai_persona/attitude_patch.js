import { STORAGE_KEY } from "./lib/constants.js";
import { clamp, lerp, getPid } from "./lib/utils.js";
import { explainGuessIdentityFor } from "./guess_identity.js";
import logManager from "../logger/manager.js";

let originalGetAttitude = null;

/**
 * 取得态度变化日志缓存（存于 `game.__slqjAiPersona` 上）。
 *
 * 说明：
 * - 新开一局时 `game.roundNumber` 通常会重置；此时会清空缓存，避免跨局误判为“变化”导致开局刷屏。
 *
 * @param {*} game
 * @returns {Map<string, number>|null}
 */
function getAttitudeLogCache(game) {
	const root = game?.__slqjAiPersona;
	if (!root || typeof root !== "object") return null;
	const round =
		typeof game?.roundNumber === "number" && Number.isFinite(game.roundNumber)
			? game.roundNumber
			: null;
	if (typeof round === "number") {
		const lastRound =
			typeof root._attitudeLogCacheRound === "number" && Number.isFinite(root._attitudeLogCacheRound)
				? root._attitudeLogCacheRound
				: null;
		if (typeof lastRound === "number" && round < lastRound) {
			root._attitudeLogCache = new Map();
		}
		root._attitudeLogCacheRound = round;
	}

	root._attitudeLogCache ??= new Map();
	return root._attitudeLogCache;
}

/**
 * 将态度值归一化为可稳定比较的数值（保留 2 位小数）。
 *
 * @param {any} n
 * @returns {number|null}
 */
function normalizeAttitudeNumber(n) {
	if (typeof n !== "number" || Number.isNaN(n) || !Number.isFinite(n)) return null;
	return Math.round(n * 100) / 100;
}

/**
 * 构建“from→to@mode”的稳定 key。
 *
 * @param {*} from
 * @param {*} to
 * @param {string} mode
 * @returns {string}
 */
function buildAttitudeLogKey(from, to, mode) {
	const fp = getPid(from);
	const tp = getPid(to);
	return `${fp}→${tp}@${String(mode || "")}`;
}

/**
 * 当态度数值发生变化时输出日志（通过 `logManager` 广播）。
 *
 * 输出内容：
 * - 中文白话：`{谁}对{谁}的态度增加/减少{x}`
 * - 结构化对象：便于弹幕层/面板等二次消费
 *
 * @param {{
 *  from:any,
 *  to:any,
 *  mode:string,
 *  base:number,
 *  perceived:(number|null),
 *  reason:string,
 *  result:number,
 *  game:any,
 *  get:any,
 * }} args
 * @returns {void}
 */
function maybeLogAttitudeChange(args) {
	try {
		const from = args?.from;
		const to = args?.to;
		if (!from || !to || from === to) return;

		const game = args?.game;
		const cache = getAttitudeLogCache(game);
		if (!cache) return;

		const mode = String(args?.mode || "");
		const key = buildAttitudeLogKey(from, to, mode);

		const now = normalizeAttitudeNumber(args?.result);
		if (now == null) return;

		const last = cache.get(key);
		// 首次出现仅记录，不视为“变化”（避免开局刷屏）。
		if (typeof last !== "number") {
			cache.set(key, now);
			return;
		}
		if (last === now) return;
		cache.set(key, now);

		/** @type {(p:any)=>string} */
		const tr = (p) => {
			try {
				const g = args?.get;
				if (typeof g?.translation === "function") {
					const s = String(g.translation(p) || "").trim();
					if (s) return s;
				}
			} catch (e) {}
			try {
				const s = String(p?.name || p?.playerid || p?.dataset?.position || "").trim();
				if (s) return s;
			} catch (e) {}
			try {
				const s = String(getPid(p) || "").trim();
				if (s) return s;
			} catch (e) {}
			return "未知角色";
		};

		const deltaRaw = normalizeAttitudeNumber(now - last);
		if (deltaRaw == null) return;
		const deltaAbs = normalizeAttitudeNumber(Math.abs(deltaRaw));
		if (deltaAbs == null || deltaAbs <= 0) return;

		const payload = {
			from: tr(from),
			to: tr(to),
			mode,
			prev: last,
			next: now,
			delta: deltaRaw,
			base: normalizeAttitudeNumber(args?.base),
			perceived: normalizeAttitudeNumber(args?.perceived),
			reason: String(args?.reason || ""),
		};

		const plainZh = `${payload.from}对${payload.to}的态度${deltaRaw > 0 ? "增加" : "减少"}${deltaAbs}`;
		// 保留原先结构化输出，便于脚本/面板二次消费。
		logManager.log("attitude", payload);
		// 追加中文白话输出，便于直接读日志/弹幕层展示。
		logManager.log("态度变更", plainZh);
	} catch (e) {}
}

/**
 * 从 game 上取得 Hook Bus（若未启用对应事件则返回 null）。
 *
 * @param {*} game
 * @returns {import("./lib/jsdoc_types.js").SlqjAiHookBus|null}
 */
function getHooks(game) {
	const hooks = game?.__slqjAiPersona?.hooks || game?.slqjAiHooks;
	if (!hooks || typeof hooks.emit !== "function") return null;
	if (typeof hooks.has === "function" && !hooks.has("slqj_ai_attitude")) return null;
	return hooks;
}

/**
 * @param {*} player
 * @returns {import("./lib/jsdoc_types.js").Persona|null}
 */
function getPersona(player) {
	return player?.storage?.[STORAGE_KEY]?.persona;
}

/**
 * @param {*} player
 * @returns {import("./lib/jsdoc_types.js").SlqjAiRuntime|null}
 */
function getRuntime(player) {
	return player?.storage?.[STORAGE_KEY]?.runtime;
}

/**
 * @param {*} player
 * @returns {import("./lib/jsdoc_types.js").SlqjAiMemory|null}
 */
function getMemory(player) {
	return player?.storage?.[STORAGE_KEY]?.memory;
}

/**
 * 在身份未明置时，根据第一印象/证据/仇恨/人格特质估算“感知态度”。
 *
 * @param {*} from
 * @param {*} to
 * @param {*} game
 * @returns {number}
 */
function computePerceivedAttitude(from, to, game) {
	const persona = getPersona(from);
	const traits = persona?.traits;
	const mem = getMemory(from);
	if (!traits || !mem) return 0;

	const pid = getPid(to);
	const impression = mem.firstImpression?.[pid] || 0;
	const evidence = mem.evidence?.[pid] || 0;
	const grudge = mem.grudge?.[pid] || 0;

	// identity 未明置时，默认中立 + 第一印象 + 证据 + 仇恨
	let att = 0;
	att += impression;
	att += evidence * (0.6 + traits.insight * 0.8);
	att -= grudge * (0.25 + traits.revengeWeight * 0.2);

	// 基础影响：越激进越容易把“未知”当作潜在敌人
	att -= traits.aggressiveness * 0.25;

	// 回合推进：前期更中立，后期更容易形成强态度
	const round = game.roundNumber || 1;
	const stage = clamp((round - 1) / 3, 0, 1);
	const certainty = lerp(0.6, 1, stage);

	// 简单局势缩放：优势越大越倾向进攻
	const hp = from.hp || 0;
	const hand = typeof from.countCards === "function" ? from.countCards("h") : 0;
	let aggrScale = 1 + Math.max(0, hp - 2) * 0.06 + Math.max(0, hand - 2) * 0.03;
	aggrScale = clamp(aggrScale, 0.85, 1.25);
	att *= lerp(0.9, 1.2, traits.aggressiveness) * aggrScale * certainty;

	return clamp(att, -10, 10);
}

/**
 * 伪装型（camouflage）：反贼前期压制对主公敌意，让其更像忠臣。
 *
 * @param {*} from
 * @param {*} to
 * @param {number} baseAtt
 * @returns {number}
 */
function applyCamouflageSuppression(from, to, baseAtt) {
	const persona = getPersona(from);
	if (persona?.id !== "camouflage") return baseAtt;
	if (from.identity !== "fan") return baseAtt;
	if (baseAtt >= 0) return baseAtt;

	const traits = persona.traits;
	const rt = getRuntime(from);
	const turns = rt?.turnsTaken || 0;
	const total = Math.max(1, traits?.camouflageRounds || 2);
	const t = clamp(turns / total, 0, 1);
	const damp = lerp(0.15, 1, t);
	return baseAtt * damp;
}

/**
 * 安装态度补丁：包装 get.attitude(from,to) 以引入“感知态度/伪装”等逻辑，并提供 hook 插入点。
 *
 * @param {{get:any, game:any, _status:any}} opts
 * @returns {void}
 */
export function installAttitudePatch({ get, game, _status }) {
	if (originalGetAttitude) return;
	if (!get?.attitude) return;
	originalGetAttitude = get.attitude;

	get.attitude = function (from, to) {
		if (!from || !to) return 0;
		if (_status.connectMode) return originalGetAttitude(from, to);

		const hooks = getHooks(game);
		const base = originalGetAttitude(from, to);
		let perceived = null;
		let reason = "original";
		let result = base;

		// 伪装：反贼前期压制对主公敌意（即便主公身份已明置）
		if (get.mode() === "identity" && game.zhu && to === game.zhu) {
			reason = "camouflage";
			result = applyCamouflageSuppression(from, to, base);
		}
		// 软暴露：当 ai.shown 足够高时，视为“身份基本明朗”，回退到引擎原态度（避免扩展长期中立）
		else if (get.mode() === "identity" && !to.identityShown && from !== to) {
			const shown = to.ai && typeof to.ai.shown === "number" ? to.ai.shown : 0;
			if (shown >= 0.85) {
				reason = "fallback_shown";
				result = base;
			}
			// identity 未明置：使用“感知态度”替代真实身份态度
			else {
				const st = from.storage?.[STORAGE_KEY];
				if (st?.persona && st?.memory) {
					reason = "perceived";
					perceived = computePerceivedAttitude(from, to, game);
					result = perceived;
				}
			}
		}

		// 反贼候选均已暴露后：剩余 unknown 软赋予为友军（仅扩展逻辑层），用于减少误伤/不救。
		if (get.mode() === "identity" && !to.identityShown && from !== to) {
			const g = explainGuessIdentityFor(from, to, game);
			const why = g && typeof g === "object" ? String(g.reason || "") : "";
			if (why === "soft_assigned_remaining_allies") {
				const selfId = String(from.identity || "");
				if (["zhu", "zhong", "mingzhong"].includes(selfId)) {
					reason = "soft_assigned";
					result = Math.max(result, 3);
				} else if (selfId === "fan") {
					reason = "soft_assigned";
					result = Math.min(result, -3);
				}
			}
		}

		let finalReason = reason;
		let finalPerceived = perceived;
		let final = result;

		if (hooks) {
			const ctx = {
				from,
				to,
				mode: get.mode(),
				base,
				perceived,
				reason,
				result,
				forceOriginal: false,
				stop: false,
				game,
				get,
			};
			hooks.emit("slqj_ai_attitude", ctx);
			finalReason = ctx && typeof ctx.reason !== "undefined" ? String(ctx.reason || "") : finalReason;
			finalPerceived =
				ctx && typeof ctx.perceived === "number" && !Number.isNaN(ctx.perceived)
					? ctx.perceived
					: finalPerceived;
			if (ctx.forceOriginal) final = base;
			else if (typeof ctx.result === "number" && !Number.isNaN(ctx.result)) final = ctx.result;
		}

		maybeLogAttitudeChange({
			from,
			to,
			mode: get.mode(),
			base,
			perceived: finalPerceived,
			reason: finalReason,
			result: final,
			game,
			get,
		});

		return final;
	};
}

/**
 * 卸载态度补丁：恢复 get.attitude 为原函数。
 *
 * @param {{get:any}} opts
 * @returns {void}
 */
export function uninstallAttitudePatch({ get }) {
	if (!originalGetAttitude) return;
	if (get?.attitude === originalGetAttitude) {
		originalGetAttitude = null;
		return;
	}
	get.attitude = originalGetAttitude;
	originalGetAttitude = null;
}
