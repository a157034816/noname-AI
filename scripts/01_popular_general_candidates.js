/**
 * scripts: 影响“开局 AI 选将”的候选与倾向，让热门/强势武将更容易被 AI 选中。
 *
 * 机制（可按需改概率）：
 * - 开局时随机抽取 AI 玩家的一半进入“概率判定池”（不含人类玩家）
 * - 进入判定池后：每个玩家独立 {启用概率}% 概率启用热门/强势武将影响（否则完全不改动候选）
 *
 * 说明：通过包装 `game.chooseCharacter()` 及捕获 `game.createEvent('chooseCharacter')`
 * 取得事件对象，进而包装 `event.ai(player, list, list2, back)` 来重排/替换候选列表；
 * 不改动引擎的 AI 评估函数，仅影响“AI 在开局会选择哪些候选”。
 *
 * @param {import("../src/scripts_loader.js").SlqjAiScriptContext} ctx
 */

import { isLocalAIPlayer } from "../src/ai_persona/lib/utils.js";
/**
 * scripts 插件元信息（用于“脚本插件管理”UI 友好展示）。
 *
 * 约定：
 * - 插件管理 UI 只读取该对象，不会自动调用入口函数
 * - 建议脚本在模块顶层避免副作用（仅导出函数/常量），把注册逻辑放到入口函数内
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "热门武将候选影响",
	version: "1.0.4",
	description: "影响开局 AI 选将候选列表：让热门/强势武将更容易进入候选并被选择（不会换入禁将/点绛唇AI禁用武将）。",
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

					const djcAiBanSet = getDianjiangchunAiBanSet(env.lib);
					if (Array.isArray(list) && Array.isArray(back)) {
						biasCandidateList(list, back, env, player, djcAiBanSet);
					} else if (Array.isArray(list2) && !Array.isArray(back)) {
						// 部分模式（如身份局主公）会把候选放在 list2；此处只重排，不动全局池子
						reorderPopularFirst(list2, env, player, djcAiBanSet);
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
 * 热门武将影响策略（仅本局生效）：
 * - 随机抽取 AI 玩家的一半进入“概率判定池”（不含人类玩家）
 * - 对于进入判定池的玩家：每个玩家独立 {启用概率}% 概率启用热门/强势武将影响（否则完全不改动候选）
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
 * 点绛唇必须“已安装且启用”。
 *
 * @param {*} lib
 * @returns {boolean}
 */
function isDianjiangchunEnabled(lib) {
	try {
		const exts = lib && lib.config && lib.config.extensions;
		if (!exts || typeof exts.includes !== "function") return false;
		if (!exts.includes("点绛唇")) return false;
		// 点绛唇启用开关可能未写入（未显式设置）：
		// - 显式 false：视为禁用
		// - true/undefined/其他：视为启用
		const flag = lib.config ? lib.config["extension_点绛唇_enable"] : undefined;
		return flag !== false;
	} catch (e) { }
	return false;
}

/**
 * 读取点绛唇的【AI禁用】列表（不存在则回退为空 Set）。
 *
 * @param {*} lib
 * @returns {Set<string>}
 */
function getDianjiangchunAiBanSet(lib) {
	try {
		if (!isDianjiangchunEnabled(lib)) return new Set();
		const list = lib && lib.config && lib.config["extension_点绛唇_plans_AI禁用"];
		if (!Array.isArray(list) || !list.length) return new Set();
		return new Set(list.map((x) => String(x || "")).filter(Boolean));
	} catch (e) {
		return new Set();
	}
}

/**
 * 从候选项中提取武将 key（尽量兼容不同模式的候选结构）。
 *
 * @param {*} candidate
 * @param {*} get
 * @returns {string}
 */
function getCandidateCharacterKey(candidate, get) {
	if (!candidate) return "";
	if (typeof candidate === "string") return candidate;
	if (Array.isArray(candidate)) return String(candidate[0] || "");
	if (typeof candidate === "object") {
		// 常见结构：{name:'xxx'} / {link:'xxx'}
		// @ts-ignore
		if (typeof candidate.name === "string") return candidate.name;
		// @ts-ignore
		if (typeof candidate.link === "string") return candidate.link;
	}
	return String(candidate || "");
}

/**
 * 判断某武将是否属于“引擎禁用/禁将”范围。
 *
 * 说明：
 * - 统一使用 `lib.filter.characterDisabled/characterDisabled2`（若存在）
 * - 其中会包含：模式禁将、双将禁将、AI禁用（forbidai/isAiForbidden）等
 *
 * @param {*} key
 * @param {*} lib
 * @returns {boolean}
 */
function isEngineCharacterDisabled(key, lib) {
	const name = getCandidateCharacterKey(key, null);
	if (!name) return true;
	try {
		const fn = lib && lib.filter && lib.filter.characterDisabled;
		if (typeof fn === "function" && fn(name)) return true;
	} catch (e) { }
	try {
		const fn2 = lib && lib.filter && lib.filter.characterDisabled2;
		if (typeof fn2 === "function" && fn2(name)) return true;
	} catch (e) { }
	return false;
}

/**
 * 判断某武将是否属于点绛唇的【AI禁用】范围。
 *
 * 兼容：同时检查原 key 与 `get.sourceCharacter(key)`（若存在）。
 *
 * @param {*} key
 * @param {Set<string>} bannedSet
 * @param {*} get
 * @returns {boolean}
 */
function isDianjiangchunAiBanned(key, bannedSet, get) {
	if (!bannedSet || !bannedSet.size) return false;
	const name = getCandidateCharacterKey(key, get);
	if (!name) return false;
	if (bannedSet.has(name)) return true;
	try {
		if (get && typeof get.sourceCharacter === "function") {
			const src = get.sourceCharacter(name);
			if (src && bannedSet.has(src)) return true;
		}
	} catch (e) { }
	return false;
}

/**
 * 判断某候选项是否“禁止出现在 AI 候选中”。
 *
 * 规则：
 * - 引擎禁将/禁用（含模式禁将、forbidai 等）
 * - 点绛唇 AI禁用（仅当点绛唇启用且配置了列表时）
 *
 * @param {*} candidate
 * @param {{lib:any,get:any}} env
 * @param {Set<string>} djcAiBanSet
 * @returns {boolean}
 */
function isForbiddenCandidate(candidate, env, djcAiBanSet) {
	const key = getCandidateCharacterKey(candidate, env && env.get);
	if (!key) return true;
	if (isEngineCharacterDisabled(key, env && env.lib)) return true;
	if (isDianjiangchunAiBanned(key, djcAiBanSet, env && env.get)) return true;
	return false;
}

/**
 * 从 pool 中挑选一个可用于替换的“未禁用且不与 list 冲突”的索引。
 *
 * @param {any[]} pool
 * @param {any[]} list
 * @param {{lib:any,get:any}} env
 * @param {Set<string>} djcAiBanSet
 * @param {boolean} allowDuplicate
 * @returns {number}
 */
function pickRandomSafeReplacementIndex(pool, list, env, djcAiBanSet, allowDuplicate) {
	const used = allowDuplicate
		? null
		: new Set(list.map((x) => getCandidateCharacterKey(x, env && env.get)).filter(Boolean));
	const candidates = [];
	for (let i = 0; i < pool.length; i++) {
		const c = pool[i];
		const key = getCandidateCharacterKey(c, env && env.get);
		if (!key) continue;
		if (used && used.has(key)) continue;
		if (isForbiddenCandidate(c, env, djcAiBanSet)) continue;
		candidates.push(i);
	}
	if (!candidates.length) return -1;
	return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * 尝试把 list 中的“禁用候选”从 pool（back）中重抽替换为安全候选，保持总量不变。
 *
 * @param {any[]} list
 * @param {any[]} pool
 * @param {{lib:any,get:any,logger:any}} env
 * @param {*} player
 * @param {Set<string>} djcAiBanSet
 * @returns {boolean} 是否已确保 list 不含禁用候选（best effort）
 */
function rerollForbiddenCandidatesUntilSafe(list, pool, env, player, djcAiBanSet) {
	if (!Array.isArray(list) || !list.length) return true;
	if (!Array.isArray(pool) || !pool.length) {
		for (const c of list) {
			if (isForbiddenCandidate(c, env, djcAiBanSet)) return false;
		}
		return true;
	}

	const maxRounds = 20;
	for (let round = 0; round < maxRounds; round++) {
		const forbiddenIndexes = [];
		for (let i = 0; i < list.length; i++) {
			if (isForbiddenCandidate(list[i], env, djcAiBanSet)) forbiddenIndexes.push(i);
		}
		if (!forbiddenIndexes.length) return true;

		let changed = false;
		for (const idx of forbiddenIndexes) {
			const forbidden = list[idx];
			let repIndex = pickRandomSafeReplacementIndex(pool, list, env, djcAiBanSet, false);
			if (repIndex < 0) repIndex = pickRandomSafeReplacementIndex(pool, list, env, djcAiBanSet, true);
			if (repIndex < 0) {
				env.logger &&
					env.logger.warn &&
					env.logger.warn("no replacement for forbidden candidate:", forbidden, "player:", safePlayerName(player));
				return false;
			}
			const replacement = pool[repIndex];
			pool.splice(repIndex, 1);
			pool.push(forbidden);
			list[idx] = replacement;
			changed = true;
		}
		if (!changed) return false;
	}
	env.logger && env.logger.warn && env.logger.warn("reroll forbidden candidates timeout");
	return false;
}

/**
 * 将 pool 中的热门武将“换入”候选 list（保持总量不变，并把被换出的候选放回 pool）。
 * @param {string[]} list
 * @param {string[]} pool
 * @param {{lib:any,get:any,popular:Set<string>,logger:any}} env
 * @param {*} player
 * @param {Set<string>} djcAiBanSet
 */
function biasCandidateList(list, pool, env, player, djcAiBanSet) {
	if (!list.length || !pool.length) return reorderPopularFirst(list, env, player, djcAiBanSet);
	// 先尝试把“禁用候选”替换出去：避免后续重排把禁用项推到前面造成误选
	try {
		rerollForbiddenCandidatesUntilSafe(list, pool, env, player, djcAiBanSet);
	} catch (e) { }
	let want = 1;
	try {
		if (env.get && typeof env.get.config === "function" && env.get.config("double_character")) want = 2;
	} catch (e) { }
	want = Math.min(want, list.length);

	for (let i = 0; i < want; i++) {
		if (isPopular(list[i], env) && !isForbiddenCandidate(list[i], env, djcAiBanSet)) continue;
		const idx = pool.findIndex((c) => isPopular(c, env) && !isForbiddenCandidate(c, env, djcAiBanSet));
		if (idx < 0) break;
		const hot = pool[idx];
		pool.splice(idx, 1);
		const replaced = list[i];
		pool.push(replaced);
		list[i] = hot;
		env.logger.debug("swap in hot:", hot, "swap out:", replaced, "slot:", i, "player:", safePlayerName(player));
	}
	reorderPopularFirst(list, env, player, djcAiBanSet);
}

/**
 * @param {string[]} list
 * @param {{lib:any,get:any,popular:Set<string>,logger:any}} env
 * @param {*} player
 * @param {Set<string>} djcAiBanSet
 */
function reorderPopularFirst(list, env, player, djcAiBanSet) {
	if (!Array.isArray(list) || list.length <= 1) return;
	const hotSafe = [];
	const safe = [];
	const forbidden = [];
	for (const c of list) {
		if (isForbiddenCandidate(c, env, djcAiBanSet)) forbidden.push(c);
		else if (isPopular(c, env)) hotSafe.push(c);
		else safe.push(c);
	}
	// 无需改动：全热/全非热，且也没有禁用项需要沉底
	if (!forbidden.length && (!hotSafe.length || !safe.length)) return;
	// 仅禁用项存在但已全沉底：无需重排
	if (forbidden.length && forbidden.length === list.length) return;
	const before = env.logger.isVerbose ? list.slice(0, 6) : null;
	list.length = 0;
	list.push(...hotSafe, ...safe, ...forbidden);
	if (env.logger.isVerbose) {
		env.logger.debug(
			"reorder popular first:",
			"hotSafe=",
			hotSafe.length,
			"forbidden=",
			forbidden.length,
			"total=",
			hotSafe.length + safe.length + forbidden.length,
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
