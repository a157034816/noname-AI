import { STORAGE_KEY } from "./lib/constants.js";
import { getPid, isLocalAIPlayer, clamp } from "./lib/utils.js";

let installed = false;
let original = null;

/**
 * @param {*} player
 * @returns {import("./lib/jsdoc_types.js").Persona|null}
 */
function getPersona(player) {
	return player?.storage?.[STORAGE_KEY]?.persona;
}

/**
 * @param {*} player
 * @returns {import("./lib/jsdoc_types.js").SlqjAiMemory|null}
 */
function getMemory(player) {
	return player?.storage?.[STORAGE_KEY]?.memory;
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
	if (typeof hooks.has === "function" && !hooks.has("slqj_ai_score")) return null;
	return hooks;
}

/**
 * @param {*} game
 * @returns {any|null}
 */
function getCfg(game) {
	return game?.__slqjAiPersona?.cfg || null;
}

/**
 * 判断是否处于“盲选他人手牌”场景（反全知）：不可见手牌不应按真实牌面做最优解。
 *
 * @param {*} player
 * @param {*} button
 * @param {*} get
 * @param {*} game
 * @param {*} _status
 * @returns {boolean}
 */
function shouldRandomizeBlindHandcard(player, button, get, game, _status) {
	const cfg = getCfg(game);
	if (!cfg?.blindHandcardRandom) return false;

	const event = _status?.event;
	if (!event) return false;
	if (event.name !== "choosePlayerCard" && event.name !== "discardPlayerCard") return false;
	if (!event.target) return false;
	if (typeof event.position !== "string" || !event.position.includes("h")) return false;

	// 与引擎在 choosePlayerCard/discardPlayerCard 中的可见判定保持一致
	if (event.visible === true) return false;
	if (typeof event.target?.isUnderControl === "function" && event.target.isUnderControl(true)) return false;
	if (player && typeof player.hasSkillTag === "function") {
		try {
			if (player.hasSkillTag("viewHandcard", null, event.target, true)) return false;
		} catch (e) {
			// ignore
		}
	}

	const link = button?.link;
	if (!link) return false;
	if (typeof get?.position !== "function") return false;
	try {
		if (get.position(link) !== "h") return false;
	} catch (e) {
		return false;
	}

	// 已明示的手牌允许正常精确选择
	if (get?.is && typeof get.is.shownCard === "function") {
		try {
			if (get.is.shownCard(link)) return false;
		} catch (e) {
			// ignore
		}
	}

	return true;
}

/**
 * 给评分加入少量噪声（仅 impulsive，且受配置项控制）。
 *
 * @param {*} player
 * @param {number} baseScore
 * @param {*} game
 * @returns {number}
 */
function addNoise(player, baseScore, game) {
	const cfg = getCfg(game);
	if (!cfg?.scoreNoiseEnable) return 0;

	const persona = getPersona(player);
	// 仅 impulsive 会给评分加少量噪声（且默认不启用，受配置项控制）
	if (persona?.id !== "impulsive") return 0;

	// 保守策略：不允许把 0/负收益“抬成正收益”，避免出现明显不合理的选择
	if (typeof baseScore !== "number" || Number.isNaN(baseScore) || baseScore <= 0) return 0;

	const r = persona?.traits?.randomness ?? 0;
	if (!r) return 0;

	// 小幅对称噪声：幅度与 traits.randomness 成正比
	return (Math.random() - 0.5) * r * 0.2;
}

/**
 * 小心眼（petty）：对仇恨目标额外增加敌对倾向。
 *
 * @param {*} player
 * @param {*} target
 * @param {*} get
 * @returns {number}
 */
function pettyBias(player, target, get) {
	const persona = getPersona(player);
	if (persona?.id !== "petty") return 0;
	const mem = getMemory(player);
	if (!mem) return 0;
	const g = mem.grudge?.[getPid(target)] || 0;
	// 只在“本就偏敌对”的情况下加速报复
	if (typeof get?.attitude === "function" && get.attitude(player, target) >= 0) return 0;
	return clamp(g * 0.12, 0, 2);
}

/**
 * 包装 ai.basic.* 的 check 函数：在原评分基础上加入 hook + 内置策略（反全知/噪声/小心眼）。
 *
 * @param {*} player
 * @param {Function} check
 * @param {*} get
 * @param {*} game
 * @param {*} _status
 * @param {"chooseCard"|"chooseTarget"|"chooseButton"|string} kind
 * @returns {(candidate:any, all:any)=>number}
 */
function wrapCheck(player, check, get, game, _status, kind) {
	return function (candidate, all) {
		let base = 0;
		try {
			base = check(candidate, all);
		} catch (e) {
			base = 0;
		}

		// 反全知：在“盲选他人手牌”场景，不用真实牌面做最优解，而改为随机选择手牌
		if (kind === "chooseButton" && shouldRandomizeBlindHandcard(player, candidate, get, game, _status)) {
			// 保留“是否应该选/是否应取消”的符号信息：base<=0 时不改动，避免把负收益误判为正收益
			if (typeof base === "number" && !Number.isNaN(base) && base > 0) {
				base = 0.000001 + Math.random();
			}
		}

		const hooks = getHooks(game);
		let ctx = {
			kind: kind || "unknown",
			stage: "base",
			player,
			candidate,
			all,
			base,
			score: base,
			extra: 0,
			event: _status?.event || null,
			game,
			get,
			stop: false,
		};
		if (hooks) ctx = hooks.emit("slqj_ai_score", ctx) || ctx;

		let extra = 0;
		if (!ctx?.skipBuiltin) {
			extra += addNoise(player, base, game);
			if (typeof get?.itemtype === "function" && get.itemtype(candidate) === "player") {
				extra += pettyBias(player, candidate, get);
			}
		}

		if (!ctx || typeof ctx !== "object") ctx = { score: base, base };
		ctx.extra = extra;
		ctx.score = (typeof ctx.score === "number" ? ctx.score : base) + extra;
		ctx.stage = "builtin";
		if (hooks) ctx = hooks.emit("slqj_ai_score", ctx) || ctx;

		ctx.stage = "final";
		if (hooks) ctx = hooks.emit("slqj_ai_score", ctx) || ctx;

		if (ctx && typeof ctx.score === "number" && !Number.isNaN(ctx.score)) return ctx.score;
		return base + extra;
	};
}

/**
 * 安装选择器补丁：包装 ai.basic.chooseCard/chooseTarget/chooseButton。
 *
 * @param {{ai:any, get:any, game:any, _status:any}} opts
 * @returns {void}
 */
export function installSelectorPatch({ ai, get, game, _status }) {
	if (installed) return;
	if (!ai?.basic) return;
	installed = true;

	original = {
		chooseCard: ai.basic.chooseCard?.bind(ai.basic),
		chooseTarget: ai.basic.chooseTarget?.bind(ai.basic),
		chooseButton: ai.basic.chooseButton?.bind(ai.basic),
	};

	if (original.chooseCard) {
		ai.basic.chooseCard = function (check) {
			const player = _status.event?.player;
			if (!isLocalAIPlayer(player, game, _status) || !getPersona(player)) {
				return original.chooseCard(check);
			}
			return original.chooseCard(wrapCheck(player, check, get, game, _status, "chooseCard"));
		};
	}

	if (original.chooseTarget) {
		ai.basic.chooseTarget = function (check) {
			const player = _status.event?.player;
			if (!isLocalAIPlayer(player, game, _status) || !getPersona(player)) {
				return original.chooseTarget(check);
			}
			return original.chooseTarget(wrapCheck(player, check, get, game, _status, "chooseTarget"));
		};
	}

	if (original.chooseButton) {
		ai.basic.chooseButton = function (check) {
			const player = _status.event?.player;
			if (!isLocalAIPlayer(player, game, _status) || !getPersona(player)) {
				return original.chooseButton(check);
			}
			return original.chooseButton(wrapCheck(player, check, get, game, _status, "chooseButton"));
		};
	}
}

/**
 * 卸载选择器补丁：恢复 ai.basic 原实现。
 *
 * @param {{ai:any}} opts
 * @returns {void}
 */
export function uninstallSelectorPatch({ ai }) {
	if (!installed) return;
	installed = false;
	if (!ai?.basic || !original) return;
	if (original.chooseCard) ai.basic.chooseCard = original.chooseCard;
	if (original.chooseTarget) ai.basic.chooseTarget = original.chooseTarget;
	if (original.chooseButton) ai.basic.chooseButton = original.chooseButton;
	original = null;
}
