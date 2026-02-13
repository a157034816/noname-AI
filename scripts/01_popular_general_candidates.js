/**
 * scripts: 影响“开局 AI 选将”的候选与倾向，让热门/强势武将更容易被 AI 选中。
 *
 * 机制（可按需改概率）：
 * - 开局时随机抽取 AI 玩家的一半进入“概率判定池”（不含人类玩家）
 * - 进入判定池后：每个玩家独立 {启用概率}% 概率启用热门/强势武将偏置（否则完全不改动候选）
 *
 * 说明：通过包装 `game.chooseCharacter()` 及捕获 `game.createEvent('chooseCharacter')`
 * 取得事件对象，进而包装 `event.ai(player, list, list2, back)` 来重排/替换候选列表；
 * 不改动引擎的 AI 评估函数，仅影响“AI 在开局会选择哪些候选”。
 *
 * @param {import("../src/scripts_loader.js").SlqjAiScriptContext} ctx
 */

import { isLocalAIPlayer } from "../src/ai_persona/lib/utils.js";
/**
 * scripts 插件元信息（用于“scripts 插件管理”UI 友好展示）。
 *
 * 约定：
 * - 插件管理 UI 只读取该对象，不会自动调用入口函数
 * - 建议脚本在模块顶层避免副作用（仅导出函数/常量），把注册逻辑放到入口函数内
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "热门武将候选偏置",
	version: "1.0.3",
	description: "影响开局 AI 选将候选列表：让热门/强势武将更容易进入候选并被选择。",
};

const 启用概率 = 1;
const 启用比例 = 0.5;

export default function setupPopularGeneralCandidates(ctx) {
	const game = ctx && ctx.game;
	const lib = ctx && ctx.lib;
	const get = ctx && ctx.get;
	const _status = ctx && ctx._status;
	if (!game || !lib) return;
	if (game.__slqjAiPopularGeneralCandidatesInstalled) return;
	game.__slqjAiPopularGeneralCandidatesInstalled = true;

	const logger = createLogger(lib);
	logger.info("init");
	patchCharacterReplaceRandomGetExact(lib, _status, logger);

	// 热门/强势武将 key（手工维护；不存在于当前环境时会自动跳过）
	const POPULAR_KEYS = [
		"guansuo", "zhaoxiang", "liuzan", "puyuan", "xin_lingtong", "xushao", "guozhao", "wanglang",
		"re_nanhualaoxian", "zhouyi", "caojinyu", "re_sunyi", "shen_jiangwei", "caomao", "shen_machao", "dc_liuba",
		"zhangxuan", "dingshangwan", "shen_zhangfei", "dc_zhouxuan", "xuelingyun", "dc_tengfanglan", "zerong", "wu_zhugeliang", "yue_caiwenji", "zhoubuyi", "wu_luxun", "dc_xujing", "star_caoren",
		"bailingyun", "dc_sb_simayi", "caofang", "dc_shen_huatuo", "wu_guanyu", "dc_sb_jiaxu", "yue_miheng", "shen_huangzhong", "ol_wenqin", "yuanyin",
		// 补充
		"tenggongzhu", "dc_liuye", "luyi", "panghui", "zhujianping", "dc_ruiji", "guanning", "shen_dengai", "sunlingluan", "dc_zhangmancheng", "chenshi", "dc_sunchen", "yue_xiaoqiao", "caoxian", "dc_simashi", "sp_zhenji", "wupu", "zhugejing", "dc_huangwudie", "dc_qinghegongzhu", "yue_diaochan", "pangfengyi", "v_zhangliao", "lvju",
		// 手杀
		"mb_cuilingyi", "re_xusheng",
		// 排位
		"pot_taishici", "mb_luyusheng", "pot_weiyan", "pot_yuji", "pot_xinxianying",
		// 地主
		"pot_weiyan", "friend_xushu", "friend_zhugeliang",
		// 农民
		"pot_yuji", "guoyuan", "sb_sp_zhugeliang",
		// 其他
		"re_jushou", "db_wenyang", "mb_zhangfen", "mb_simafu", "liujinliupei", "ganfurenmifuren", "dc_sb_dengai", "yue_daqiao", "yue_xiaoqiao", "xizhicai", "xin_yuji"
	];
	const popular = new Set(POPULAR_KEYS);
	// 兼容：不同模式/替换表下可能传入“源武将”key（被替换/同名不同前缀等）
	try {
		if (get && typeof get.sourceCharacter === "function") {
			for (const k of POPULAR_KEYS) popular.add(get.sourceCharacter(k));
		}
	} catch (e) { }
	logger.info("popular keys:", popular.size);

	let tries = 0;
	(function retry() {
		// 部分环境下 characterReplace 初始化可能略晚；在重试期间兜底一次
		patchCharacterReplaceRandomGetExact(lib, _status, logger);
		if (wrapChooseCharacter({ game, lib, get, _status, popular, logger })) return;
		tries++;
		if (tries > 50) {
			logger.warn("wrap game.chooseCharacter timeout");
			return;
		}
		setTimeout(retry, 100);
	})();
}

/**
 * @param {{game:any,lib:any,get:any,_status:any,popular:Set<string>,logger:any}} env
 */
function wrapChooseCharacter(env) {
	const originalChooseCharacter = env.game && env.game.chooseCharacter;
	if (typeof originalChooseCharacter !== "function") return false;
	if (originalChooseCharacter.__slqjAiPopularGeneralCandidatesWrapped) return true;
	originalChooseCharacter.__slqjAiPopularGeneralCandidatesWrapped = true;

	env.game.chooseCharacter = function () {
		// 确保在选将开始前已安装“严格全匹配”补丁（防止后加载的 characterReplace 条目漏补丁）
		try {
			patchCharacterReplaceRandomGetExact(env.lib, env._status, env.logger);
		} catch (e) { }

		const originalCreateEvent = env.game && env.game.createEvent;
		let capturedChooseCharacterEvent = null;
		if (typeof originalCreateEvent === "function") {
			env.game.createEvent = function (name) {
				const ev = originalCreateEvent.apply(this, arguments);
				if (name === "chooseCharacter") capturedChooseCharacterEvent = ev;
				return ev;
			};
		}

		let ret;
		try {
			ret = originalChooseCharacter.apply(this, arguments);
		} finally {
			if (env.game && env.game.createEvent !== originalCreateEvent) env.game.createEvent = originalCreateEvent;
		}

		try {
			patchChooseCharacterEvent(ret || capturedChooseCharacterEvent, env);
		} catch (e) {
			try {
				console.error("[身临其境的AI][scripts] popular_general_candidates patch failed", e);
			} catch (e2) { }
		}
		return ret;
	};
	env.logger.info("wrapped game.chooseCharacter");
	return true;
}

/**
 * @param {*} ev
 * @param {{game:any,lib:any,get:any,_status:any,popular:Set<string>,logger:any}} env
 */
function patchChooseCharacterEvent(ev, env) {
	if (!ev || typeof ev.ai !== "function") return;
	if (ev.__slqjAiPopularGeneralCandidatesPatched) return;
	ev.__slqjAiPopularGeneralCandidatesPatched = true;

	const originalAi = ev.ai;
	ev.ai = function (player, list, list2, back) {
		try {
			// 仅在 chooseCharacter 阶段，且仅对 AI 生效（不影响玩家自己的候选）
			if (env._status && env._status.event && env._status.event.name === "chooseCharacter") {
				if (player && isLocalAIPlayer(player, env.game, env._status)) {
					const decision = getPopularBiasDecision(player, env);
					if (!decision.applyPopular) return originalAi.apply(this, arguments);
					if (Array.isArray(list) && Array.isArray(back)) {
						biasCandidateList(list, back, env, player);
					} else if (Array.isArray(list2) && !Array.isArray(back)) {
						// 部分模式（如身份局主公）会把候选放在 list2；此处只重排，不动全局池子
						reorderPopularFirst(list2, env, player);
					}
				}
			}
		} catch (e) {
			try {
				console.error("[身临其境的AI][scripts] popular_general_candidates ai hook failed", e);
			} catch (e2) { }
		}
		return originalAi.apply(this, arguments);
	};
	env.logger.debug("patched chooseCharacter event");
}

/**
 * 热门武将偏置策略（仅本局生效）：
 * - 随机抽取 AI 玩家的一半进入“概率判定池”（不含人类玩家）
 * - 对于进入判定池的玩家：每个玩家独立 {启用概率}% 概率启用热门/强势武将偏置（否则完全不改动候选）
 *
 * @param {*} player
 * @param {{game:any,logger:any,_status:any}} env
 * @returns {{selectedForCheck:boolean,applyPopular:boolean}}
 */
function getPopularBiasDecision(player, env) {
	const game = env && env.game;
	if (!game || !player) return { selectedForCheck: false, applyPopular: false };
	if (!game.__slqjAiPopularGeneralCandidatesBiasState) {
		game.__slqjAiPopularGeneralCandidatesBiasState = {
			/** @type {WeakMap<object, {selectedForCheck:boolean,applyPopular:boolean}>} */
			map: new WeakMap(),
			/** @type {WeakSet<object>} */
			selected: new WeakSet(),
			initialized: false,
		};
	}
	const state = game.__slqjAiPopularGeneralCandidatesBiasState;
	const cached = state.map.get(player);
	if (cached) return cached;

	if (!state.initialized) {
		state.initialized = true;
		try {
			const all = Array.isArray(game.players) ? game.players.slice(0) : [];
			const aiPlayers = all.filter((p) => isLocalAIPlayer(p, game, env?._status));
			const pick = Math.floor(aiPlayers.length * 启用比例);
			for (let i = aiPlayers.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				const tmp = aiPlayers[i];
				aiPlayers[i] = aiPlayers[j];
				aiPlayers[j] = tmp;
			}
			for (let i = 0; i < pick; i++) state.selected.add(aiPlayers[i]);
			env.logger &&
				env.logger.debug &&
				env.logger.debug("bias pool:", "ai=", aiPlayers.length, "picked=", pick);
		} catch (e) {
			// fallback：不阻断流程；后续对未初始化/异常场景采用“50%”近似
		}
	}

	let selectedForCheck = false;
	try {
		selectedForCheck = state.selected.has(player);
	} catch (e) {
		selectedForCheck = Math.random() < 0.5;
	}
	const applyPopular = selectedForCheck && Math.random() < 启用概率;
	const decision = { selectedForCheck, applyPopular };
	state.map.set(player, decision);
	try {
		env.logger &&
			env.logger.debug &&
			env.logger.debug(
				"bias decision:",
				"selected=",
				selectedForCheck,
				"applyPopular=",
				applyPopular,
				"player:",
				safePlayerName(player)
			);
	} catch (e) { }
	return decision;
}

/**
 * 将 pool 中的热门武将“换入”候选 list（保持总量不变，并把被换出的候选放回 pool）。
 * @param {string[]} list
 * @param {string[]} pool
 * @param {{lib:any,get:any,popular:Set<string>,logger:any}} env
 * @param {*} player
 */
function biasCandidateList(list, pool, env, player) {
	if (!list.length || !pool.length) return reorderPopularFirst(list, env, player);
	let want = 1;
	try {
		if (env.get && typeof env.get.config === "function" && env.get.config("double_character")) want = 2;
	} catch (e) { }
	want = Math.min(want, list.length);

	for (let i = 0; i < want; i++) {
		if (isPopular(list[i], env)) continue;
		const idx = pool.findIndex((c) => isPopular(c, env));
		if (idx < 0) break;
		const hot = pool[idx];
		pool.splice(idx, 1);
		const replaced = list[i];
		pool.push(replaced);
		list[i] = hot;
		env.logger.debug("swap in hot:", hot, "swap out:", replaced, "slot:", i, "player:", safePlayerName(player));
	}
	reorderPopularFirst(list, env, player);
}

/**
 * @param {string[]} list
 * @param {{get:any,popular:Set<string>,logger:any}} env
 * @param {*} player
 */
function reorderPopularFirst(list, env, player) {
	if (!Array.isArray(list) || list.length <= 1) return;
	const hot = [];
	const cold = [];
	for (const c of list) (isPopular(c, env) ? hot : cold).push(c);
	if (!hot.length || !cold.length) return;
	const before = env.logger.isVerbose ? list.slice(0, 6) : null;
	list.length = 0;
	list.push(...hot, ...cold);
	if (env.logger.isVerbose) {
		env.logger.debug(
			"reorder popular first:",
			"hot=",
			hot.length,
			"total=",
			hot.length + cold.length,
			"player:",
			safePlayerName(player),
			"head:",
			before,
			"=>",
			list.slice(0, 6)
		);
	}
}

/**
 * @param {string} key
 * @param {{get:any,popular:Set<string>}} env
 */
function isPopular(key, env) {
	if (!key) return false;
	let base = String(key);
	if (env.get && typeof env.get.sourceCharacter === "function") {
		try {
			base = env.get.sourceCharacter(base);
		} catch (e) { }
	}
	return env.popular.has(base);
}

/**
 * @param {*} player
 * @returns {string}
 */
function safePlayerName(player) {
	try {
		if (!player) return "unknown";
		return String(player.name || player.name1 || player.nickname || player.playerid || "unknown");
	} catch (e) {
		return "unknown";
	}
}

/**
 * 防止“武将切换表”导致开局选将时把候选武将随机替换为其变体（如 `xuelingyun` -> `ol_xuelingyun`）。
 *
 * 背景：部分模式（例如 identity）在 AI 选将时会执行：
 * `choice = lib.characterReplace[choice].randomGet()`，导致候选列表里的 key 与最终 init 的 key 不一致。
 *
 * 目标：只要候选里是哪个 key，最终就必须 init 哪个 key（严格全匹配，不做“同源/模糊”替换）。
 *
 * 实现：遍历 `lib.characterReplace` 的每个数组，覆写其 `randomGet()`：
 * - 仅在 chooseCharacter / chooseCharacterOL 阶段返回“源 key”（即 `characterReplace` 的字段名）
 * - 其他阶段仍走原本的 `randomGet()` 行为，尽量减少副作用
 *
 * @param {*} lib
 * @param {*} _status
 * @param {{info:Function, warn:Function, debug:Function}} logger
 */
function patchCharacterReplaceRandomGetExact(lib, _status, logger) {
	try {
		if (!lib || !lib.characterReplace) return;
		const map = lib.characterReplace;
		for (const key in map) {
			const arr = map[key];
			if (!Array.isArray(arr)) continue;

			if (arr.__slqjAiPopularGeneralCandidatesExactPatched) continue;
			const originalRandomGet = arr.randomGet;
			if (typeof originalRandomGet !== "function") continue;
			arr.__slqjAiPopularGeneralCandidatesExactPatched = true;
			arr.__slqjAiPopularGeneralCandidatesOriginalRandomGet = originalRandomGet;
			arr.randomGet = function () {
				try {
					const evName = _status && _status.event && _status.event.name;
					if (evName === "chooseCharacter" || evName === "chooseCharacterOL") {
						// 某些环境下 characterReplace 的“源 key”本身可能并不存在于 lib.character；
						// 此时若强制返回源 key，会导致 identity 等模式后续读取 lib.character[key][1] 时报错。
						// 因此仅在源 key 可用时才做“严格全匹配”，否则回退到原本随机替换逻辑。
						if (lib && lib.character && lib.character[key]) return key;
					}
				} catch (e) { }
				return originalRandomGet.apply(this, arguments);
			};
		}
		logger && logger.info && logger.info("patch characterReplace.randomGet: exact match during chooseCharacter");
	} catch (e) { }
}

/**
 * @param {*} lib
 */
function createLogger(lib) {
	const prefix = "[身临其境的AI][scripts][popular_general_candidates]";
	const isVerbose = !!(
		lib &&
		lib.config &&
		(lib.config.dev || lib.config.slqj_ai_scripts_debug)
	);
	function out(level, args) {
		try {
			const fn = console && console[level] ? console[level] : console.log;
			fn.apply(console, [prefix].concat(args));
		} catch (e) { }
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
