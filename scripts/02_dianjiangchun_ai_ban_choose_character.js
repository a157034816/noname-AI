/**
 * scripts: 兼容“点绛唇”扩展的【AI禁用】方案，把禁将处理从 gameStart 提前到“人机选将”阶段。
 *
 * 背景：
 * - 点绛唇的 `_AI禁用` 规则技默认在 `gameStart` 时检测 AI 是否拿到禁将，并在开局后强制更换
 * - 在部分模式下会造成“先选将→再换将”的观感，以及额外的换将动画/势力修正等副作用
 *
 * 本脚本在满足以下条件时生效：
 * - 已安装并启用扩展：点绛唇
 * - 点绛唇配置存在 `extension_点绛唇_plans_AI禁用` 列表（非空时才会实际干预）
 *
 * 行为：
 * - 在 `chooseCharacter` 阶段、对本地 AI 玩家：
 *   - 若候选列表 `list`（且存在候选池 `back`）包含 AI 禁将，则从 `back` 中抽取未禁用武将替换，
 *     并把被替换的禁将放回 `back`，直到候选中不再包含 AI 禁将（或无可用替换为止）
 *   - 若候选位于 `list2`（常见于部分模式的主公候选），则仅对 `list2` 做“移除禁将”处理
 *
 * @param {import("../src/scripts_loader.js").SlqjAiScriptContext} ctx
 */

import { isLocalAIPlayer } from "../src/ai_persona/lib/utils.js";

/**
 * scripts 插件元信息（用于“scripts 插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "点绛唇：AI禁将时机优化",
	version: "1.0.0",
	description: "检测点绛唇启用后，把 AI 禁将从 gameStart 提前到选将阶段：AI候选中若出现“AI禁用”武将则自动重抽替换，直到候选不含禁将。",
};

export default function setupDianjiangchunAiBanChooseCharacter(ctx) {
	const game = ctx && ctx.game;
	const lib = ctx && ctx.lib;
	const get = ctx && ctx.get;
	const _status = ctx && ctx._status;
	if (!game || !lib) return;
	if (game.__slqjAiDjcAiBanChooseCharacterInstalled) return;
	game.__slqjAiDjcAiBanChooseCharacterInstalled = true;

	const logger = createLogger(lib);
	logger.info("init");

	try {
		patchCreateEvent({ game, lib, get, _status, logger });
	} catch (e) {
		try {
			console.error("[身临其境的AI][scripts] dianjiangchun_ai_ban_choose_character init failed", e);
		} catch (e2) {}
	}
}

/**
 * @param {{game:any,lib:any,get:any,_status:any,logger:any}} env
 * @returns {boolean}
 */
function patchCreateEvent(env) {
	const game = env && env.game;
	if (!game || typeof game.createEvent !== "function") return false;
	if (game.createEvent.__slqjAiDjcAiBanChooseCharacterWrapped) return true;

	const originalCreateEvent = game.createEvent;
	game.createEvent = function (name) {
		const ev = originalCreateEvent.apply(this, arguments);
		try {
			if (name === "chooseCharacter") {
				installChooseCharacterAiWrapper(ev, env);
			}
		} catch (e) {
			env.logger && env.logger.warn && env.logger.warn("patch chooseCharacter event failed:", e);
		}
		return ev;
	};
	game.createEvent.__slqjAiDjcAiBanChooseCharacterWrapped = true;
	game.createEvent.__slqjAiDjcAiBanChooseCharacterOriginal = originalCreateEvent;
	env.logger && env.logger.info && env.logger.info("wrapped game.createEvent");
	return true;
}

/**
 * 在 `chooseCharacter` 事件对象上安装一次性的 `ai` 包装器：
 * - 仅包装“模式/引擎写入的基础 ai 函数”
 * - 后续 scripts 若再次包装 `ev.ai`，会自然形成：外层 scripts → 本脚本 → 基础 ai 的调用链
 *
 * @param {*} ev
 * @param {{game:any,lib:any,get:any,_status:any,logger:any}} env
 * @returns {void}
 */
function installChooseCharacterAiWrapper(ev, env) {
	if (!ev || ev.__slqjAiDjcAiBanChooseCharacterAiWrapped) return;
	ev.__slqjAiDjcAiBanChooseCharacterAiWrapped = true;

	// 极少数情况下 ai 可能已存在（容错）：直接包装并返回
	if (typeof ev.ai === "function") {
		ev.ai = wrapBaseAi(ev.ai, env);
		return;
	}

	let aiValue = ev.ai;
	Object.defineProperty(ev, "ai", {
		configurable: true,
		enumerable: true,
		get() {
			return aiValue;
		},
		set(fn) {
			aiValue = fn;
			// 仅对首次写入的基础 ai 做包装；随后恢复为普通可写属性，避免拦截后续 scripts 包装造成“外层化”。
			const wrapped = typeof fn === "function" ? wrapBaseAi(fn, env) : fn;
			Object.defineProperty(ev, "ai", {
				value: wrapped,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		},
	});
}

/**
 * @param {Function} baseAi
 * @param {{game:any,lib:any,get:any,_status:any,logger:any}} env
 * @returns {Function}
 */
function wrapBaseAi(baseAi, env) {
	if (baseAi.__slqjAiDjcAiBanChooseCharacterWrapped) return baseAi;

	const wrapped = function (player, list, list2, back) {
		try {
			if (!shouldApplyToPlayer(player, env)) return baseAi.apply(this, arguments);

			const bannedList = getDianjiangchunAiBanList(env.lib);
			if (!bannedList.length) return baseAi.apply(this, arguments);

			const bannedSet = new Set(bannedList);

			// 常见口径：AI 候选在 list，候选池在 back（可“换入换出”保持总量不变）
			if (Array.isArray(list) && Array.isArray(back)) {
				rerollCandidatesUntilSafe(list, back, bannedSet, env);
				return baseAi.apply(this, arguments);
			}

			// 兼容口径：部分模式会把候选放在 list2（例如主公候选），此时仅做“移除禁将”
			if (Array.isArray(list2)) {
				const safeList2 = list2.filter((c) => !isAiBannedCharacter(c, bannedSet, env.get));
				if (safeList2.length) {
					// 不直接改写原数组（避免影响其他分支复用），仅替换入参
					const safeList = Array.isArray(list)
						? list.filter((c) => !isAiBannedCharacter(c, bannedSet, env.get))
						: list;
					return baseAi.call(this, player, safeList, safeList2, back);
				}
			}
		} catch (e) {
			env.logger && env.logger.warn && env.logger.warn("ai hook failed:", e);
		}
		return baseAi.apply(this, arguments);
	};
	wrapped.__slqjAiDjcAiBanChooseCharacterWrapped = true;
	wrapped.__slqjAiDjcAiBanChooseCharacterBase = baseAi;
	return wrapped;
}

/**
 * @param {*} player
 * @param {{game:any,lib:any,_status:any}} env
 * @returns {boolean}
 */
function shouldApplyToPlayer(player, env) {
	const game = env && env.game;
	const lib = env && env.lib;
	const _status = env && env._status;
	if (!game || !lib) return false;

	// 仅在选将阶段生效（避免影响其他事件的 ai 函数）
	try {
		const st = _status || globalThis?._status;
		if (!st || !st.event || st.event.name !== "chooseCharacter") return false;
	} catch (e) {
		return false;
	}

	// 仅对本地 AI 生效（不影响玩家手操；托管视为 AI）
	if (!isLocalAIPlayer(player, game, _status)) return false;
	try {
		if (player && typeof player.isOnline2 === "function" && player.isOnline2()) return false;
	} catch (e) {}

	// 点绛唇必须“已安装且启用”
	if (!isDianjiangchunEnabled(game, lib)) return false;
	return true;
}

/**
 * @param {*} game
 * @param {*} lib
 * @returns {boolean}
 */
function isDianjiangchunEnabled(game, lib) {
	try {
		const exts = lib && lib.config && lib.config.extensions;
		if (!exts || typeof exts.includes !== "function") return false;
		if (!exts.includes("点绛唇")) return false;
		// 点绛唇启用开关可能未写入（未显式设置）：
		// - 显式 false：视为禁用
		// - true/undefined/其他：视为启用（与引擎 hasExtension 的默认口径一致，但避免写配置副作用）
		const flag = lib.config ? lib.config["extension_点绛唇_enable"] : undefined;
		return flag !== false;
	} catch (e) {}
	return false;
}

/**
 * 读取点绛唇的【AI禁用】列表（不存在则回退为空数组）。
 *
 * @param {*} lib
 * @returns {string[]}
 */
function getDianjiangchunAiBanList(lib) {
	try {
		const list = lib && lib.config && lib.config["extension_点绛唇_plans_AI禁用"];
		if (!Array.isArray(list)) return [];
		return list.map((x) => String(x || "")).filter(Boolean);
	} catch (e) {
		return [];
	}
}

/**
 * 判断某武将是否属于点绛唇的【AI禁用】范围。
 *
 * 兼容：同时检查原 key 与 `get.sourceCharacter(key)`（若存在）。
 *
 * @param {string} key
 * @param {Set<string>} bannedSet
 * @param {*} get
 * @returns {boolean}
 */
function isAiBannedCharacter(key, bannedSet, get) {
	const name = String(key || "");
	if (!name) return false;
	if (bannedSet.has(name)) return true;
	try {
		if (get && typeof get.sourceCharacter === "function") {
			const src = get.sourceCharacter(name);
			if (src && bannedSet.has(src)) return true;
		}
	} catch (e) {}
	return false;
}

/**
 * 对 `list` 做“重抽替换”，直到不再包含 AI 禁将（或池子无法提供替换）。
 *
 * 约定：
 * - `list` 为本次 AI 候选
 * - `pool`（back）为剩余候选池
 * - 替换时保持数量不变：从 pool 抽 1 个未禁用的换入 list，并把禁将放回 pool
 *
 * @param {string[]} list
 * @param {string[]} pool
 * @param {Set<string>} bannedSet
 * @param {{get:any,logger:any}} env
 * @returns {void}
 */
function rerollCandidatesUntilSafe(list, pool, bannedSet, env) {
	if (!Array.isArray(list) || !list.length) return;
	if (!Array.isArray(pool) || !pool.length) return;

	const maxRounds = 20;
	for (let round = 0; round < maxRounds; round++) {
		const bannedIndexes = [];
		for (let i = 0; i < list.length; i++) {
			if (isAiBannedCharacter(list[i], bannedSet, env.get)) bannedIndexes.push(i);
		}
		if (!bannedIndexes.length) return;

		let changed = false;
		for (const idx of bannedIndexes) {
			const banned = list[idx];
			const repIndex = pickRandomReplacementIndex(pool, list, bannedSet, env.get);
			if (repIndex < 0) {
				env.logger && env.logger.warn && env.logger.warn("no replacement for banned candidate:", banned);
				return;
			}
			const replacement = pool[repIndex];
			pool.splice(repIndex, 1);
			pool.push(banned);
			list[idx] = replacement;
			changed = true;
		}
		if (!changed) return;
	}
	env.logger && env.logger.warn && env.logger.warn("reroll candidates timeout");
}

/**
 * 从 pool 中挑选一个可用于替换的“未禁用且不与 list 冲突”的索引。
 *
 * @param {string[]} pool
 * @param {string[]} list
 * @param {Set<string>} bannedSet
 * @param {*} get
 * @returns {number}
 */
function pickRandomReplacementIndex(pool, list, bannedSet, get) {
	const used = new Set(list.map((x) => String(x || "")).filter(Boolean));
	const candidates = [];
	for (let i = 0; i < pool.length; i++) {
		const c = pool[i];
		if (!c) continue;
		if (used.has(c)) continue;
		if (isAiBannedCharacter(c, bannedSet, get)) continue;
		candidates.push(i);
	}
	if (!candidates.length) return -1;
	return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * @param {*} lib
 * @returns {{isVerbose:boolean,info:Function,warn:Function,debug:Function}}
 */
function createLogger(lib) {
	const prefix = "[身临其境的AI][scripts][dianjiangchun_ai_ban_choose_character]";
	const isVerbose = !!(lib && lib.config && (lib.config.dev || lib.config.slqj_ai_scripts_debug));
	function out(level, args) {
		try {
			const fn = console && console[level] ? console[level] : console.log;
			fn.apply(console, [prefix].concat(args));
		} catch (e) {}
	}
	return {
		isVerbose,
		info: function () {
			out("log", Array.from(arguments));
		},
		warn: function () {
			out("warn", Array.from(arguments));
		},
		debug: function () {
			if (isVerbose) out("log", ["[debug]"].concat(Array.from(arguments)));
		},
	};
}
