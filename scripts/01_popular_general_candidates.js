/**
 * scripts: 影响“开局 AI 选将”的候选与倾向，让热门/强势武将更容易被 AI 选中。
 *
 * 机制（可按需改概率）：
 * - 开局时随机抽取 AI 玩家的一半进入“概率判定池”（不含人类玩家）
 * - 进入判定池后：每个玩家独立 {启用概率}% 概率启用热门/强势武将影响（否则完全不改动候选）
 *
 * 说明：通过包装 `game.createEvent()` 捕获 `game.createEvent('chooseCharacter')`
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
	version: "1.0.8",
	description:
		"影响开局 AI 选将候选列表：让热门/强势武将更容易进入候选并被选择（不会换入禁将/仅点将可用/点绛唇AI禁用武将）。",
};

/**
 * scripts 插件配置（用于“脚本插件管理 -> 配置(⚙)”）。
 *
 * @type {{version:1, items:Array<{key:string,name:string,type:"number",default:number,min:number,max:number,step:number,description?:string}>}}
 */
export const slqjAiScriptConfig = {
	version: 1,
	items: [
		{
			key: "enableProbability",
			name: "启用概率",
			type: "number",
			default: 1,
			min: 0,
			max: 1,
			step: 0.05,
			description: "对进入判定池的 AI：每个玩家独立按该概率启用“热门候选影响”。",
		},
		{
			key: "poolRatio",
			name: "启用比例",
			type: "number",
			default: 0.5,
			min: 0,
			max: 1,
			step: 0.05,
			description: "开局随机抽取 AI 玩家中，进入“概率判定池”的比例（不含人类玩家）。",
		},
	],
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

	const cfg = (ctx && ctx.scriptConfig) || {};
	const enableProbability = typeof cfg.enableProbability === "number" ? cfg.enableProbability : 启用概率;
	const poolRatio = typeof cfg.poolRatio === "number" ? cfg.poolRatio : 启用比例;

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

	const env = { game, lib, get, _status, popular, logger, enableProbability, poolRatio };
	wrapPlayerInitForChooseCharacterFallback(env);

	let tries = 0;
	(function retry() {
		// 部分环境下 characterReplace 初始化可能略晚；在重试期间兜底一次
		patchCharacterReplaceRandomGetExact(lib, _status, logger);
		wrapPlayerInitForChooseCharacterFallback(env);
		if (wrapCreateEvent(env)) return;
		tries++;
		if (tries > 50) {
			logger.warn("wrap game.createEvent timeout");
			return;
		}
		setTimeout(retry, 100);
	})();
}

/**
 * @param {{game:any,lib:any,get:any,_status:any,popular:Set<string>,logger:any,enableProbability:number,poolRatio:number}} env
 * @returns {boolean}
 */
function wrapCreateEvent(env) {
	const game = env && env.game;
	if (!game || typeof game.createEvent !== "function") return false;
	if (game.createEvent.__slqjAiPopularGeneralCandidatesWrapped) return true;

	const originalCreateEvent = game.createEvent;
	game.createEvent = function (name) {
		const ev = originalCreateEvent.apply(this, arguments);
		try {
			if (name === "chooseCharacter") {
				// 确保在选将开始前已安装“严格全匹配”补丁（防止后加载的 characterReplace 条目漏补丁）
				try {
					patchCharacterReplaceRandomGetExact(env.lib, env._status, env.logger);
				} catch (e) { }

				queuePatchChooseCharacterEvent(ev, env);
			}
		} catch (e) {
			env.logger && env.logger.warn && env.logger.warn("patch chooseCharacter event failed:", e);
		}
		return ev;
	};
	game.createEvent.__slqjAiPopularGeneralCandidatesWrapped = true;
	game.createEvent.__slqjAiPopularGeneralCandidatesOriginal = originalCreateEvent;
	env.logger && env.logger.info && env.logger.info("wrapped game.createEvent");
	return true;
}

/**
 * 在 `chooseCharacter` 事件对象上“尽快”安装 `ai` 包装器：
 * - 不使用 `Object.defineProperty` 劫持 setter（避免与其他 scripts 冲突，如点绛唇 AI禁用脚本）
 * - 采用“微任务 + 短轮询”方式，等待 `ev.ai` 出现后再包装
 *
 * @param {*} ev
 * @param {{game:any,lib:any,get:any,_status:any,popular:Set<string>,logger:any,enableProbability:number,poolRatio:number}} env
 * @returns {void}
 */
function queuePatchChooseCharacterEvent(ev, env) {
	if (!ev || ev.__slqjAiPopularGeneralCandidatesPatchQueued) return;
	ev.__slqjAiPopularGeneralCandidatesPatchQueued = true;

	const tryPatch = () => {
		try {
			patchChooseCharacterEvent(ev, env);
		} catch (e) {
			try {
				console.error("[身临其境的AI][scripts] popular_general_candidates patch failed", e);
			} catch (e2) { }
		}
	};

	// 微任务：让外层 createEvent 包装（如点绛唇）先完成安装，再尝试 patch
	try {
		Promise.resolve().then(tryPatch);
	} catch (e) {
		setTimeout(tryPatch, 0);
	}

	// 兜底：极少数情况下 ai 写入会更晚，做短轮询等待
	let tries = 0;
	const maxTries = 50;
	(function poll() {
		tries++;
		if (!ev) return;
		if (ev.__slqjAiPopularGeneralCandidatesPatched) return;
		if (typeof ev.ai === "function") {
			tryPatch();
			if (ev.__slqjAiPopularGeneralCandidatesPatched) return;
		}
		if (tries >= maxTries) return;
		setTimeout(poll, 0);
	})();
}

/**
 * @param {*} ev
 * @param {{game:any,lib:any,get:any,_status:any,popular:Set<string>,logger:any,enableProbability:number,poolRatio:number}} env
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
 * 兜底覆盖“非 event.ai 路径”的开局选将：
 * - 典型场景：斗转星移的欢乐斗地主 `chooseCharacterHuanle`（`event.map[pid] + randomGet + player.init`）
 * - 以及部分对决/自定义流程（`event.list.randomRemove() + player.init`）
 *
 * 设计目标：
 * - 仅在 chooseCharacter 阶段触发
 * - 仅影响本地 AI（且显式跳过 `game.me`），不改动玩家候选界面
 * - 若可从 `event.map[pid]` 获取候选，则优先在候选内挑选热门/安全项；否则从 `event.list` 做安全交换
 *
 * @param {{game:any,lib:any,get:any,_status:any,popular:Set<string>,logger:any,enableProbability:number,poolRatio:number}} env
 * @returns {boolean}
 */
function wrapPlayerInitForChooseCharacterFallback(env) {
	const lib = env && env.lib;
	const game = env && env.game;
	if (!lib || !game) return false;
	const proto = lib && lib.element && lib.element.Player && lib.element.Player.prototype;
	if (!proto || typeof proto.init !== "function") return false;
	if (proto.init.__slqjAiPopularGeneralCandidatesChooseCharFallbackWrapped) return true;

	const originalInit = proto.init;
	proto.init = function (character, character2, skill, update) {
		try {
			// 仅 chooseCharacter 阶段：
			// - 若存在 event.ai（常规路径）：仅做“禁将兜底”（避免随机替换落到禁将）
			// - 若不存在 event.ai（非标准路径）：按配置概率执行“热门偏置”，并同样确保不 init 禁将
			const st = (env && env._status) || globalThis?._status;
			const ev = st && st.event;
			if (!ev || ev.name !== "chooseCharacter") return originalInit.apply(this, arguments);

			// 明确跳过玩家本人（无论是否托管）：不影响玩家候选界面/体验
			if (this === game.me) return originalInit.apply(this, arguments);

			// 仅影响本地 AI（联机/观战不生效）
			if (!isLocalAIPlayer(this, game, st)) return originalInit.apply(this, arguments);

			const djcAiBanSet = getDianjiangchunAiBanSet(lib);
			const originalKey = getCandidateCharacterKey(character, env && env.get);
			if (!originalKey) return originalInit.apply(this, arguments);

			const originalKey2 = getCandidateCharacterKey(character2, env && env.get);
			const forbid1 = isForbiddenCandidate(originalKey, env, djcAiBanSet);
			const forbid2 = !!originalKey2 && isForbiddenCandidate(originalKey2, env, djcAiBanSet);

			const hasEventAi = typeof ev.ai === "function";
			const decision = getPopularBiasDecision(this, env);
			const applyPopular = !hasEventAi && decision.applyPopular;
			if (!applyPopular && !forbid1 && !forbid2) return originalInit.apply(this, arguments);

			let final1 = originalKey;
			let final2 = originalKey2;
			if (originalKey2) {
				// 双将：分别替换（尽量避免与另一半重复）
				if (applyPopular || forbid1) final1 = pickBiasedInitCharacter(originalKey, this, ev, env, djcAiBanSet, new Set([originalKey2]));
				if (applyPopular || forbid2) final2 = pickBiasedInitCharacter(originalKey2, this, ev, env, djcAiBanSet, new Set([final1]));
			} else {
				// 单将
				if (applyPopular || forbid1) final1 = pickBiasedInitCharacter(originalKey, this, ev, env, djcAiBanSet, null);
			}

			// 禁将兜底：若原本就是禁将但最终仍为禁将，说明候选池里没有安全项（best effort 不阻断流程）
			if (forbid1 && isForbiddenCandidate(final1, env, djcAiBanSet)) final1 = originalKey;
			if (forbid2 && isForbiddenCandidate(final2, env, djcAiBanSet)) final2 = originalKey2;

			if (final1 === originalKey && final2 === originalKey2) return originalInit.apply(this, arguments);

			env.logger &&
				env.logger.debug &&
				env.logger.debug(
					"chooseCharacter init fallback:",
					"from=",
					originalKey,
					originalKey2 ? "," : "",
					originalKey2 || "",
					"to=",
					final1,
					final2 ? "," : "",
					final2 || "",
					"player:",
					safePlayerName(this)
				);

			const args = Array.from(arguments);
			args[0] = final1;
			if (originalKey2) args[1] = final2;
			return originalInit.apply(this, args);
		} catch (e) {
			try {
				console.error("[身临其境的AI][scripts] popular_general_candidates init fallback failed", e);
			} catch (e2) { }
			return originalInit.apply(this, arguments);
		}
	};
	proto.init.__slqjAiPopularGeneralCandidatesChooseCharFallbackWrapped = true;
	proto.init.__slqjAiPopularGeneralCandidatesChooseCharFallbackOriginal = originalInit;
	env.logger && env.logger.info && env.logger.info("wrapped player.init (chooseCharacter fallback)");
	return true;
}

/**
 * 为非 `event.ai` 路径提供“最终 init 角色”兜底选择：
 * - 优先从 `event.map[pid]` 的候选中挑选热门/安全项
 * - 若无法获取候选，则尝试从 `event.list` 做“换入热门”的安全交换（保持池大小不变）
 *
 * @param {string} originalKey
 * @param {*} player
 * @param {*} ev
 * @param {{game:any,lib:any,get:any,_status:any,popular:Set<string>,logger:any}} env
 * @param {Set<string>} djcAiBanSet
 * @param {Set<string>|null} excludeSet
 * @returns {string}
 */
function pickBiasedInitCharacter(originalKey, player, ev, env, djcAiBanSet, excludeSet) {
	// 1) event.map 路径：仅在候选中偏热门/保底安全，不触碰全局池子（避免影响玩家候选）
	try {
		const pid = player && player.playerid;
		const map = ev && ev.map;
		const list = pid && map && map[pid];
		if (Array.isArray(list) && list.length) {
			const picked = pickPreferredFromCandidates(originalKey, list, env, player, djcAiBanSet, excludeSet);
			// 候选内能挑到安全项 → 直接返回；若候选全不安全则继续走 pool 兜底（best effort）
			if (picked &&
				!isForbiddenCandidate(picked, env, djcAiBanSet) &&
				!(excludeSet && excludeSet.has(picked))) return picked;
		}
	} catch (e) { }

	// 2) event.list 路径：通过交换把热门换入（保持池大小不变）
	try {
		const pool = ev && ev.list;
		if (Array.isArray(pool) && pool.length) {
			return swapInPreferredFromPool(originalKey, pool, env, player, djcAiBanSet, excludeSet);
		}
	} catch (e) { }

	return originalKey;
}

/**
 * 从候选列表中挑选“更优”的 init 角色：
 * - 若原角色已是热门且安全 → 保持不变
 * - 否则优先挑选热门且安全的候选；再不行则挑选任意安全候选
 *
 * @param {string} originalKey
 * @param {string[]} candidates
 * @param {{lib:any,get:any,popular:Set<string>,logger:any}} env
 * @param {*} player
 * @param {Set<string>} djcAiBanSet
 * @param {Set<string>|null} excludeSet
 * @returns {string}
 */
function pickPreferredFromCandidates(originalKey, candidates, env, player, djcAiBanSet, excludeSet) {
	if (!Array.isArray(candidates) || !candidates.length) return originalKey;
	const excludedOriginal = !!(excludeSet && excludeSet.has(originalKey));
	if (!excludedOriginal && isPopular(originalKey, env) && !isForbiddenCandidate(originalKey, env, djcAiBanSet)) return originalKey;

	const hotSafe = [];
	const safe = [];
	for (const c of candidates) {
		if (!c) continue;
		if (excludeSet && excludeSet.has(c)) continue;
		if (isForbiddenCandidate(c, env, djcAiBanSet)) continue;
		if (isPopular(c, env)) hotSafe.push(c);
		else safe.push(c);
	}
	if (hotSafe.length) return hotSafe[Math.floor(Math.random() * hotSafe.length)];
	if (!excludedOriginal && !isForbiddenCandidate(originalKey, env, djcAiBanSet)) return originalKey;
	if (safe.length) return safe[Math.floor(Math.random() * safe.length)];
	return originalKey;
}

/**
 * 从池子中“换入”一个更优候选：优先热门且安全，保持池大小不变。
 *
 * 注意：该池子通常是 chooseCharacter 阶段用于后续分配的剩余候选；
 * 仅对非 `game.me` 的 AI init 触发（外层已强约束），避免影响玩家候选界面。
 *
 * @param {string} originalKey
 * @param {any[]} pool
 * @param {{lib:any,get:any,popular:Set<string>,logger:any}} env
 * @param {*} player
 * @param {Set<string>} djcAiBanSet
 * @param {Set<string>|null} excludeSet
 * @returns {string}
 */
function swapInPreferredFromPool(originalKey, pool, env, player, djcAiBanSet, excludeSet) {
	if (!Array.isArray(pool) || !pool.length) return originalKey;
	if (!(excludeSet && excludeSet.has(originalKey)) &&
		isPopular(originalKey, env) &&
		!isForbiddenCandidate(originalKey, env, djcAiBanSet)) return originalKey;

	let idx = pool.findIndex((c) => {
		const key = getCandidateCharacterKey(c, env && env.get);
		if (!key) return false;
		if (excludeSet && excludeSet.has(key)) return false;
		return isPopular(key, env) && !isForbiddenCandidate(key, env, djcAiBanSet);
	});
	if (idx < 0 && isForbiddenCandidate(originalKey, env, djcAiBanSet)) {
		// 保底：原角色不安全时，尝试换入任意安全项
		idx = pool.findIndex((c) => {
			const key = getCandidateCharacterKey(c, env && env.get);
			if (!key) return false;
			if (excludeSet && excludeSet.has(key)) return false;
			return !isForbiddenCandidate(key, env, djcAiBanSet);
		});
	}
	if (idx < 0) return originalKey;

	const chosen = pool[idx];
	pool.splice(idx, 1);
	// 保持池大小不变：把原 key 放回池子（若池子里已存在则不重复添加）
	try {
		if (originalKey && !pool.includes(originalKey)) pool.push(originalKey);
	} catch (e) { }

	env.logger &&
		env.logger.debug &&
		env.logger.debug("swap in preferred from pool:", chosen, "swap out:", originalKey, "player:", safePlayerName(player));
	return getCandidateCharacterKey(chosen, env && env.get) || originalKey;
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

	const enableProbability =
		typeof (env && env.enableProbability) === "number" ? env.enableProbability : 启用概率;
	const poolRatio = typeof (env && env.poolRatio) === "number" ? env.poolRatio : 启用比例;

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
			let pick = Math.floor(aiPlayers.length * poolRatio);
			if (aiPlayers.length > 0 && poolRatio > 0 && pick === 0) pick = 1;
			if (pick > aiPlayers.length) pick = aiPlayers.length;
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
	const applyPopular = selectedForCheck && Math.random() < enableProbability;
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
 * 判断某武将是否属于当前模式的“禁将”范围。
 *
 * 说明：
 * - 优先读取运行期 `lib.config.banned`（通常由引擎从 `${mode}_banned` 派生）
 * - 兜底读取 `lib.config[mode + "_banned"]`（避免某些场景下 `banned` 未及时同步）
 * - 同时兼容 `get.sourceCharacter(key)`（若存在）
 *
 * @param {*} key
 * @param {*} lib
 * @param {*} get
 * @returns {boolean}
 */
function isModeBannedByConfig(key, lib, get) {
	const name = getCandidateCharacterKey(key, get);
	if (!name) return true;

	/** @type {string[]} */
	const variants = [name];
	try {
		if (get && typeof get.sourceCharacter === "function") {
			const src = get.sourceCharacter(name);
			if (src && src !== name) variants.push(src);
		}
	} catch (e) { }

	for (const n of variants) {
		try {
			const banned = lib && lib.config && lib.config.banned;
			if (Array.isArray(banned) && banned.includes(n)) return true;
		} catch (e) { }
		try {
			const mode = lib && lib.config && lib.config.mode;
			const list = mode ? lib.config[mode + "_banned"] : null;
			if (Array.isArray(list) && list.includes(n)) return true;
		} catch (e) { }
	}
	return false;
}

/**
 * 判断某武将是否被标记为“仅点将可用”（不可被随机/AI 选到）。
 *
 * 说明：
 * - 斗转星移等扩展会写入 `lib.config.forbidai_user`
 * - 引擎启动时会把 `forbidai_user` 合并到 `lib.config.forbidai`，但运行期可能不同步
 * - 同时兼容 `get.sourceCharacter(key)`（若存在）
 *
 * @param {*} key
 * @param {*} lib
 * @param {*} get
 * @returns {boolean}
 */
function isForbidAiUserOnlyPoint(key, lib, get) {
	const name = getCandidateCharacterKey(key, get);
	if (!name) return true;
	try {
		const list = lib && lib.config && lib.config.forbidai_user;
		if (Array.isArray(list) && list.includes(name)) return true;
	} catch (e) { }
	try {
		if (get && typeof get.sourceCharacter === "function") {
			const src = get.sourceCharacter(name);
			const list = lib && lib.config && lib.config.forbidai_user;
			if (src && Array.isArray(list) && list.includes(src)) return true;
		}
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
 * - 模式禁将（`banned` / `${mode}_banned`）
 * - 仅点将可用（`forbidai_user`）
 * - 引擎禁用（`forbidai` / `isAiForbidden` 等）
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
	if (isModeBannedByConfig(key, env && env.lib, env && env.get)) return true;
	if (isForbidAiUserOnlyPoint(key, env && env.lib, env && env.get)) return true;
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
