import { isLocalAIPlayer, ensureStorage, getPid } from "../src/ai_persona/lib/utils.js";

/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 * @typedef {import("../src/ai_persona/lib/jsdoc_types.js").SlqjAiHookBus} SlqjAiHookBus
 */

/**
 * scripts 插件元信息（用于“脚本插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "友善互动：怒气丢鸡蛋",
	version: "1.1.2",
	description:
		"当本地 AI 对某玩家的定向怒气达到阈值时丢鸡蛋：阶段1丢1个；阶段2按人格高频连丢（2秒/10秒/10秒+随机回合追加）。额外：首回合极端速杀/打入濒死时，小概率触发“肢解鸡蛋大战”。",
};

/**
 * 插件参数（可在脚本内调整）。
 *
 * 注意：本插件只影响“表情投掷”(throwEmotion)，不改变 AI 出牌/策略。
 *
 * @type {{
 *  stage1Threshold:number,
 *  stage2Threshold:number,
 *  hysteresis:number,
 *  burstIntervalMs:number,
 *  stage2ShortMs:number,
 *  stage2LongMs:number,
 *  stage2ExtraPerRageMs:number,
 *  stage2ExtraCapMs:number,
 *  followupDelayTurnsMin:number,
 *  followupDelayTurnsMax:number,
 *  followupBurstMsMin:number,
 *  followupBurstMsMax:number,
 *  maxBurstTargets:number,
 *  retaliationEnable:boolean,
 *  retaliationCooldownMs:number,
 *  retaliationWindowMs:number,
 *  retaliationBaseChance:number,
 *  retaliationExtraChancePerHit:number,
 *  retaliationMaxChance:number,
 *  retaliationMaxPerTurnPerTarget:number,
 *  retaliationSuppressMs:number,
 *  retaliationDelayMsMin:number,
 *  retaliationDelayMsMax:number,
 *  allowDeadThrow:boolean,
 *  allowDeadTarget:boolean,
 *  instakillWarEnable:boolean,
 *  instakillWarChance:number,
 *  instakillWarPairMs:number,
 *  instakillWarCooldownMs:number,
 *  instakillWarDelayMsMin:number,
 *  instakillWarDelayMsMax:number,
 *  instakillWarBurstMs:number,
 *  instakillWarBurstIntervalMs:number,
 *  instakillWarAnnounce:boolean,
 *  instakillWarOnlyOncePerGame:boolean
 * }}
 */
const CFG = {
	// 阶段1：达到该怒气阈值时，丢 1 个鸡蛋
	stage1Threshold: 4,
	// 阶段2：达到该怒气阈值时，按人格高频连丢（较难达成）
	stage2Threshold: 7,
	// 阈值回落滞回：避免在阈值附近来回抖动导致反复触发
	hysteresis: 0.6,

	// 高频连丢：间隔（越小越“高频”）
	burstIntervalMs: 50,

	// 阶段2基准持续时间（不同人格在此基础上选择短/长）
	stage2ShortMs: 2000,
	stage2LongMs: 10000,

	// 怒气越多→连丢越久：每高于 stage2Threshold 1 点额外增加时长（并封顶）
	stage2ExtraPerRageMs: 250,
	stage2ExtraCapMs: 1500,

	// 追加连丢（petty）：随机在后续某回合再丢几秒
	followupDelayTurnsMin: 1,
	followupDelayTurnsMax: 4,
	followupBurstMsMin: 2000,
	followupBurstMsMax: 4500,

	// 防刷屏：同一 AI 同时最多对多少个目标处于“连丢中”
	maxBurstTargets: 2,

	// 被砸蛋反击：仅“有可能触发”，并通过冷却/回合上限防止无限对砸
	retaliationEnable: true,
	retaliationCooldownMs: 1400,
	retaliationWindowMs: 2000,
	retaliationBaseChance: 0.35,
	retaliationExtraChancePerHit: 0.18,
	retaliationMaxChance: 0.95,
	retaliationMaxPerTurnPerTarget: 2,
	retaliationSuppressMs: 1200,
	retaliationDelayMsMin: 120,
	retaliationDelayMsMax: 360,

	// 允许死亡角色也能扔鸡蛋/被扔鸡蛋（表现层互动；不影响结算）
	allowDeadThrow: true,
	allowDeadTarget: true,

	// 首回合“肢解鸡蛋大战”：满血被单人一回合内打到濒死/击杀，小概率进入无限互砸（直到游戏结束或到期）
	instakillWarEnable: true,
	instakillWarChance: 0.08,
	// 对砸持续时间：0=直到游戏结束；>0 则到期自动失效（单位 ms）
	instakillWarPairMs: 0,
	// “鸡蛋大战”模式下的反击节奏（更高频）：冷却 + 反击延迟
	instakillWarCooldownMs: 60,
	instakillWarDelayMsMin: 80,
	instakillWarDelayMsMax: 180,
	// 若对方不是本地 AI（无法自动反击），则由濒死方单方面连砸一段时间
	instakillWarBurstMs: 6500,
	instakillWarBurstIntervalMs: 180,
	// 触发时是否提示日志（便于确认该彩蛋是否生效）
	instakillWarAnnounce: true,
	// 是否每局只允许触发一次（更可控；默认开启）
	instakillWarOnlyOncePerGame: true,
};

/**
 * scripts 插件入口：安装“怒气丢鸡蛋”逻辑。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setupFriendlyRageEggThrow(ctx) {
	const { game, lib, hooks, _status } = ctx || {};
	if (!game || !lib) return;
	if (_status?.connectMode) return;

	const runtime = getOrCreateRuntime(game);
	if (!runtime || runtime.installed) return;
	runtime.installed = true;
	runtime._status = _status || runtime._status || null;

	installGlobalSkills({ game, lib });
	installEmotionHook({ game, hooks });
}

/**
 * 取得/创建脚本运行期对象（挂在 game.__slqjAiPersona 上，便于 skill.content 间接访问）。
 *
 * @param {*} game
 * @returns {{installed?:boolean,cfg:any,turnId:number,api:any}|null}
 */
function getOrCreateRuntime(game) {
	if (!game) return null;
	try {
		game.__slqjAiPersona ??= Object.create(null);
	} catch (e) {
		return null;
	}
	const root = game.__slqjAiPersona;
	root.friendlyRageEggThrow ??= Object.create(null);
	const rt = root.friendlyRageEggThrow;
	if (typeof rt.turnId !== "number" || Number.isNaN(rt.turnId)) rt.turnId = 0;
	if (typeof rt.turnRoundNumber !== "number" || Number.isNaN(rt.turnRoundNumber)) rt.turnRoundNumber = 0;
	if (typeof rt.turnPlayerPid !== "string") rt.turnPlayerPid = "";
	if (!rt.hpAtTurnStartByPid || typeof rt.hpAtTurnStartByPid !== "object") rt.hpAtTurnStartByPid = Object.create(null);
	if (!rt.hpLossSourceByVictimPid || typeof rt.hpLossSourceByVictimPid !== "object")
		rt.hpLossSourceByVictimPid = Object.create(null);
	if (!rt.hpLossDirtyVictims || typeof rt.hpLossDirtyVictims !== "object") rt.hpLossDirtyVictims = Object.create(null);
	if (!rt.suppressedPairs || typeof rt.suppressedPairs !== "object") rt.suppressedPairs = Object.create(null);
	if (!rt.warPairs || typeof rt.warPairs !== "object") rt.warPairs = Object.create(null);
	if (typeof rt.instakillWarTriggered !== "boolean") rt.instakillWarTriggered = false;
	if (typeof rt.hookInstalled !== "boolean") rt.hookInstalled = false;
	if (typeof rt._status !== "object") rt._status = null;
	rt.cfg = CFG;
	rt.api ??= createApi();
	return rt;
}

/**
 * 尽力取得 _status（优先使用运行期缓存，其次回退 globalThis._status，最后回退兜底对象）。
 *
 * @param {*} game
 * @returns {{connectMode?:boolean, over?:boolean}}
 */
function pickStatus(game) {
	const rt = game?.__slqjAiPersona?.friendlyRageEggThrow || null;
	const st1 = rt && typeof rt._status === "object" ? rt._status : null;
	// 兼容：dev 模式可能会暴露 window._status
	const st2 = typeof globalThis !== "undefined" ? globalThis._status : null;
	if (st1) return st1;
	if (st2 && typeof st2 === "object") return st2;
	return { connectMode: false, over: false };
}

/**
 * 安装投掷表情 hook：用于“被砸蛋有可能触发砸蛋反击”，并做反递归/限频防止无限对砸。
 *
 * @param {{game:any,hooks:SlqjAiHookBus|null|undefined}} env
 * @returns {void}
 */
function installEmotionHook(env) {
	const game = env && env.game;
	const hooks = env && env.hooks;
	if (!game || !hooks || typeof hooks.on !== "function") return;

	const rt = getOrCreateRuntime(game);
	if (!rt || rt.hookInstalled) return;
	rt.hookInstalled = true;

	hooks.on("slqj_ai_emotion_throw", (ctx) => {
		try {
			onEmotionThrowHook(ctx, game, pickStatus(game));
		} catch (e) {}
	});
}

/**
 * 处理投掷表情 hook：被“egg”命中时，可能触发反击。
 *
 * 防无限对砸策略：
 * - 只对“被砸的一方（目标）为本地 AI”生效
 * - 仅在怒气达到阈值时才可能反击
 * - 冷却 + 单回合上限
 * - 对“本插件触发的反击蛋”做 suppress（不再触发对方反击）
 *
 * @param {*} ctx
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
function onEmotionThrowHook(ctx, game, _status) {
	if (!ctx || typeof ctx !== "object") return;
	if (ctx.connectMode || ctx.online) return;
	if (_status?.connectMode) return;
	if (_status?.over) return;

	const emotion = String(ctx.emotion || "");
	if (emotion !== "egg") return;

	const from = ctx.from;
	const target = ctx.target;
	if (!from || !target) return;
	if (from === target) return;

	const fromPid = getPid(from);
	const targetPid = getPid(target);
	if (!fromPid || !targetPid) return;

	const rt = getOrCreateRuntime(game);
	if (!rt) return;
	const cfg = rt.cfg || CFG;
	const now = Date.now();
	const inWar = isWarPairActive(rt, fromPid, targetPid, now);

	// suppress：本插件触发的“反击蛋”不再触发进一步反击
	if (!inWar) {
		const supKey = `${fromPid}->${targetPid}`;
		const supUntil = safeNumber(rt.suppressedPairs[supKey]);
		if (supUntil && supUntil > now) {
			delete rt.suppressedPairs[supKey];
			return;
		}
	}

	// 仅“目标”为本地 AI 才可能反击（鸡蛋大战同样遵循该口径，避免强制玩家丢表情）
	if (!isLocalAIPlayer(target, game, _status)) return;

	// 鸡蛋大战：不看怒气/冷却/单回合上限，尽可能无限互砸（直到游戏结束或到期）
	if (inWar) {
		const tStorage = ensureStorage(target);
		const pr = ensurePairRuntime(tStorage, game);
		if (!pr) return;

		const cd = Math.max(0, safeNumber(cfg.instakillWarCooldownMs));
		const lastAt = safeNumber(pr.lastWarRetaliateAtByTarget?.[fromPid]);
		if (cd && now - lastAt < cd) return;

		pr.lastWarRetaliateAtByTarget ??= Object.create(null);
		pr.lastWarRetaliateAtByTarget[fromPid] = now;

		const delay = randInt(safeNumber(cfg.instakillWarDelayMsMin), safeNumber(cfg.instakillWarDelayMsMax));
		setTimeout(() => {
			try {
				if (_status?.over) return;
				if (!canThrowNow(target, from, game, _status)) return;
				safeThrowEgg(target, from);
			} catch (e) {}
		}, delay);
		return;
	}

	if (!cfg.retaliationEnable) return;

	const tStorage = ensureStorage(target);
	const mem = tStorage?.memory;
	if (!mem || !mem.rageTowards || typeof mem.rageTowards !== "object") return;

	const rage = safeNumber(mem.rageTowards[fromPid]);
	const stage1 = safeNumber(cfg.stage1Threshold);
	const stage2 = safeNumber(cfg.stage2Threshold);
	if (rage < stage1) return;

	const pr = ensurePairRuntime(tStorage, game);
	if (!pr) return;
	const turnId = safeNumber(rt.turnId);

	// 回合上限：每回合对同一目标最多反击 N 次
	if (pr.retaliateTurnId !== turnId) {
		pr.retaliateTurnId = turnId;
		pr.retaliateCountByTarget = Object.create(null);
	}
	const maxPerTurn = Math.max(0, Math.floor(safeNumber(cfg.retaliationMaxPerTurnPerTarget)));
	const used = safeNumber(pr.retaliateCountByTarget[fromPid]);
	if (maxPerTurn > 0 && used >= maxPerTurn) return;

	// 冷却：避免连砸导致无限对砸/刷屏
	const cd = Math.max(0, safeNumber(cfg.retaliationCooldownMs));
	const lastAt = safeNumber(pr.lastRetaliateAtByTarget[fromPid]);
	if (cd && now - lastAt < cd) return;

	// 统计“连砸”强度：在窗口内命中的次数越多，反击概率越高
	const win = Math.max(200, safeNumber(cfg.retaliationWindowMs));
	const hit = pr.eggHitBySource[fromPid] && typeof pr.eggHitBySource[fromPid] === "object" ? pr.eggHitBySource[fromPid] : null;
	let startedAt = safeNumber(hit?.startedAt);
	let count = safeNumber(hit?.count);
	if (!startedAt || now - startedAt > win) {
		startedAt = now;
		count = 0;
	}
	count += 1;
	pr.eggHitBySource[fromPid] = { startedAt, count };

	// 概率：rage>=stage2 时必反击；否则按“连砸次数”提高概率
	let chance = rage >= stage2 ? 1 : safeNumber(cfg.retaliationBaseChance);
	if (rage < stage2) {
		const extra = Math.max(0, count - 1) * Math.max(0, safeNumber(cfg.retaliationExtraChancePerHit));
		chance = Math.min(safeNumber(cfg.retaliationMaxChance), Math.max(0, chance + extra));
	}
	if (Math.random() > chance) return;

	pr.retaliateCountByTarget[fromPid] = used + 1;
	pr.lastRetaliateAtByTarget[fromPid] = now;

	const delay = randInt(safeNumber(cfg.retaliationDelayMsMin), safeNumber(cfg.retaliationDelayMsMax));
	setTimeout(() => {
		try {
			if (_status?.over) return;
			if (!canThrowNow(target, from, game, _status)) return;
			throwRetaliationEgg(target, from, game, cfg);
		} catch (e) {}
	}, delay);
}

/**
 * 投掷“反击蛋”（带 suppress 标记，避免触发对方无限反击）。
 *
 * @param {*} from
 * @param {*} target
 * @param {*} game
 * @param {*} cfg
 * @returns {void}
 */
function throwRetaliationEgg(from, target, game, cfg) {
	if (!from || !target || !game) return;
	const rt = getOrCreateRuntime(game);
	if (!rt) return;
	const fromPid = getPid(from);
	const targetPid = getPid(target);
	if (!fromPid || !targetPid) return;

	const ms = Math.max(150, safeNumber(cfg?.retaliationSuppressMs));
	rt.suppressedPairs[`${fromPid}->${targetPid}`] = Date.now() + ms;
	safeThrowEgg(from, target);
}

/**
 * 创建供 skill 调用的 API（避免 skill.content 依赖模块闭包变量）。
 *
 * @returns {any}
 */
function createApi() {
	return {
		onTurnTick,
		filterDamageEnd,
		onDamageEnd,
		filterRewriteDiscardResult,
		onRewriteDiscardResult,
		filterRewriteGainResult,
		onRewriteGainResult,
	};
}

/**
 * 安装全局技能：在关键事件后检查怒气阈值并触发丢鸡蛋。
 *
 * @param {{game:any,lib:any}} env
 * @returns {void}
 */
function installGlobalSkills(env) {
	const { game, lib } = env || {};
	if (!game || !lib) return;
	const rt = getOrCreateRuntime(game);
	if (!rt) return;

	// 1) 每回合 tick：用于触发“追加连丢”（随机回合）
	if (!lib.skill.slqj_ai_friendly_egg_turn_tick) {
		lib.skill.slqj_ai_friendly_egg_turn_tick = {
			trigger: { global: "phaseBeginStart" },
			forced: true,
			silent: true,
			popup: false,
			priority: Infinity,
			filter(event, player) {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.friendlyRageEggThrow?.api;
				if (!api || typeof api.onTurnTick !== "function") return false;
				return !!event && !!event.player;
			},
			content() {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.friendlyRageEggThrow?.api;
				if (!api || typeof api.onTurnTick !== "function") return;
				try {
					api.onTurnTick(trigger, g);
				} catch (e) {}
			},
		};
	}
	try {
		game.addGlobalSkill("slqj_ai_friendly_egg_turn_tick");
	} catch (e) {}

	// 2) 伤害：本地 AI 被伤害后，根据其对 source 的怒气判断是否丢鸡蛋
	if (!lib.skill.slqj_ai_friendly_egg_damage) {
		lib.skill.slqj_ai_friendly_egg_damage = {
			trigger: { player: "damageEnd" },
			forced: true,
			silent: true,
			popup: false,
			priority: -10,
			filter(event, player) {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.friendlyRageEggThrow?.api;
				if (!api || typeof api.filterDamageEnd !== "function") return false;
				try {
					return !!api.filterDamageEnd(event, player, g);
				} catch (e) {
					return false;
				}
			},
			content() {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.friendlyRageEggThrow?.api;
				if (!api || typeof api.onDamageEnd !== "function") return;
				try {
					api.onDamageEnd(trigger, player, g);
				} catch (e) {}
			},
		};
	}
	try {
		game.addGlobalSkill("slqj_ai_friendly_egg_damage");
	} catch (e) {}

	// 3) 过河拆桥：本地 AI 被拆牌后，根据其对拆牌者的怒气判断是否丢鸡蛋
	if (!lib.skill.slqj_ai_friendly_egg_guohe) {
		lib.skill.slqj_ai_friendly_egg_guohe = {
			trigger: { player: "rewriteDiscardResult" },
			forced: true,
			silent: true,
			popup: false,
			priority: -10,
			filter(event, player) {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.friendlyRageEggThrow?.api;
				if (!api || typeof api.filterRewriteDiscardResult !== "function") return false;
				try {
					return !!api.filterRewriteDiscardResult(event, player, g);
				} catch (e) {
					return false;
				}
			},
			content() {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.friendlyRageEggThrow?.api;
				if (!api || typeof api.onRewriteDiscardResult !== "function") return;
				try {
					api.onRewriteDiscardResult(trigger, player, g);
				} catch (e) {}
			},
		};
	}
	try {
		game.addGlobalSkill("slqj_ai_friendly_egg_guohe");
	} catch (e) {}

	// 4) 顺手牵羊：本地 AI 被顺牌后，根据其对顺牌者的怒气判断是否丢鸡蛋
	if (!lib.skill.slqj_ai_friendly_egg_shunshou) {
		lib.skill.slqj_ai_friendly_egg_shunshou = {
			trigger: { player: "rewriteGainResult" },
			forced: true,
			silent: true,
			popup: false,
			priority: -10,
			filter(event, player) {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.friendlyRageEggThrow?.api;
				if (!api || typeof api.filterRewriteGainResult !== "function") return false;
				try {
					return !!api.filterRewriteGainResult(event, player, g);
				} catch (e) {
					return false;
				}
			},
			content() {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.friendlyRageEggThrow?.api;
				if (!api || typeof api.onRewriteGainResult !== "function") return;
				try {
					api.onRewriteGainResult(trigger, player, g);
				} catch (e) {}
			},
		};
	}
	try {
		game.addGlobalSkill("slqj_ai_friendly_egg_shunshou");
	} catch (e) {}
}

/**
 * 每回合 tick：维护 turnId，并触发“追加连丢”（petty 人格的阶段2后续随机回合）。
 *
 * @param {*} trigger
 * @param {*} game
 * @returns {void}
 */
function onTurnTick(trigger, game) {
	if (!trigger || !game) return;
	const _status = pickStatus(game);
	if (_status?.connectMode) return;
	if (trigger._slqjAiFriendlyEggTurnTickDone) return;
	trigger._slqjAiFriendlyEggTurnTickDone = true;
	if (_status?.over) return;

	const rt = getOrCreateRuntime(game);
	if (!rt) return;
	rt.turnId = (rt.turnId || 0) + 1;
	rt.turnRoundNumber = typeof game.roundNumber === "number" && !Number.isNaN(game.roundNumber) ? game.roundNumber : 0;
	rt.turnPlayerPid = getPid(trigger.player) || "";

	// 记录回合开始时的 HP 快照（用于“首回合满血一回合内被单人击杀/打入濒死”的彩蛋判定）
	rt.hpAtTurnStartByPid = Object.create(null);
	for (const p of game.players || []) {
		const pid = getPid(p);
		if (!pid) continue;
		const hp = typeof p.hp === "number" && !Number.isNaN(p.hp) ? p.hp : 0;
		const maxHp = typeof p.maxHp === "number" && !Number.isNaN(p.maxHp) ? p.maxHp : 0;
		rt.hpAtTurnStartByPid[pid] = { hp, maxHp };
	}
	rt.hpLossSourceByVictimPid = Object.create(null);
	rt.hpLossDirtyVictims = Object.create(null);

	const cfg = rt.cfg || CFG;
	const alive = Array.isArray(game.players) ? game.players : [];
	const dead = Array.isArray(game.dead) ? game.dead : [];
	const includeDead = !!cfg.allowDeadThrow || !!cfg.allowDeadTarget;
	const all = includeDead ? alive.concat(dead) : alive;

	for (const aiPlayer of all) {
		if (!isLocalAIPlayer(aiPlayer, game, _status)) continue;
		processFollowups(aiPlayer, rt.turnId, game, _status);
		resetTurnTransient(aiPlayer, rt.turnId, game);
	}
}

/**
 * @param {*} event
 * @param {*} player
 * @param {*} game
 * @returns {boolean}
 */
function filterDamageEnd(event, player, game) {
	const _status = pickStatus(game);
	if (_status?.connectMode) return false;
	if (!event || !player) return false;
	if (!event.source || event.source === player) return false;
	return isLocalAIPlayer(player, game, _status);
}

/**
 * @param {*} trigger
 * @param {*} victim
 * @param {*} game
 * @returns {void}
 */
function onDamageEnd(trigger, victim, game) {
	if (!trigger || !victim || !game) return;
	const _status = pickStatus(game);
	if (_status?.connectMode) return;
	if (!isLocalAIPlayer(victim, game, _status)) return;
	const source = trigger.source;
	if (!source || source === victim) return;
	recordHpLossSourceThisTurn(victim, source, game);
	checkRageAndMaybeThrow(victim, source, game, _status);
	maybeTriggerInstakillEggWar(victim, source, game, _status);
}

/**
 * 记录“本回合内谁对 victim 造成过扣血（damage/loseHp）”：用于判定“一回合内被单人击杀/打入濒死”。
 *
 * @param {*} victim
 * @param {*} source
 * @param {*} game
 * @returns {void}
 */
function recordHpLossSourceThisTurn(victim, source, game) {
	const rt = getOrCreateRuntime(game);
	if (!rt) return;
	const vPid = getPid(victim);
	const sPid = getPid(source);
	if (!vPid || !sPid) return;

	const prev = String(rt.hpLossSourceByVictimPid[vPid] || "");
	if (!prev) rt.hpLossSourceByVictimPid[vPid] = sPid;
	else if (prev !== sPid) rt.hpLossSourceByVictimPid[vPid] = "*";
}

/**
 * 首回合彩蛋：若本地 AI 在首回合“满血被单人一回合内击杀/打入濒死”，小概率进入“肢解鸡蛋大战”。
 *
 * 行为：
 * - 标记该 pair 进入“鸡蛋大战”模式：双方互扔鸡蛋将触发无视怒气/限频的高频反击（直到游戏结束或到期）
 * - 额外：若对方不是本地 AI（无法自动反击），则由濒死方单方面连砸一段时间以形成“大战”观感
 *
 * @param {*} victim
 * @param {*} killer
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
function maybeTriggerInstakillEggWar(victim, killer, game, _status) {
	if (!victim || !killer || !game) return;
	if (_status?.connectMode) return;
	if (_status?.over) return;
	if (!isLocalAIPlayer(victim, game, _status)) return;

	const rt = getOrCreateRuntime(game);
	if (!rt) return;
	const cfg = rt.cfg || CFG;
	if (!cfg.instakillWarEnable) return;
	if (cfg.instakillWarOnlyOncePerGame && rt.instakillWarTriggered) return;

	// 仅首回合
	if (safeNumber(rt.turnRoundNumber) !== 1) return;

	const vPid = getPid(victim);
	const kPid = getPid(killer);
	if (!vPid || !kPid) return;
	if (vPid === kPid) return;

	// “被一个人一回合内击杀”：必须是当前回合玩家（turn owner）造成，并且本回合内仅该 source 对其造成过扣血
	if (rt.turnPlayerPid && rt.turnPlayerPid !== kPid) return;
	if (String(rt.hpLossSourceByVictimPid[vPid] || "") !== kPid) return;

	// “满血”：回合开始时必须满血
	const snap = rt.hpAtTurnStartByPid && typeof rt.hpAtTurnStartByPid === "object" ? rt.hpAtTurnStartByPid[vPid] : null;
	const startHp = safeNumber(snap?.hp);
	const startMax = safeNumber(snap?.maxHp);
	if (!startMax || startHp < startMax) return;

	// “击杀/打入濒死”：当前已进入濒死（hp<=0 或 isDying）
	const hp = safeNumber(victim.hp);
	const dying = hp <= 0 || (typeof victim.isDying === "function" && !!victim.isDying());
	if (!dying) return;

	// 同一受害者本回合只尝试一次（避免多段伤害反复触发抽签）
	const dirty = rt.hpLossDirtyVictims && typeof rt.hpLossDirtyVictims === "object" ? rt.hpLossDirtyVictims : null;
	if (dirty && dirty[vPid]) return;
	if (dirty) dirty[vPid] = true;

	const chance = Math.max(0, Math.min(1, safeNumber(cfg.instakillWarChance)));
	if (Math.random() > chance) return;

	rt.instakillWarTriggered = true;
	startInstakillEggWar(victim, killer, game, _status, cfg);
}

/**
 * 启动“肢解鸡蛋大战”。
 *
 * @param {*} victim 本地 AI（被速杀/濒死的一方）
 * @param {*} killer 造成者（通常是当前回合玩家）
 * @param {*} game
 * @param {*} _status
 * @param {*} cfg
 * @returns {void}
 */
function startInstakillEggWar(victim, killer, game, _status, cfg) {
	if (!victim || !killer || !game) return;
	if (_status?.connectMode) return;
	if (_status?.over) return;

	const rt = getOrCreateRuntime(game);
	if (!rt) return;
	const vPid = getPid(victim);
	const kPid = getPid(killer);
	if (!vPid || !kPid) return;

	const key = makePairKey(vPid, kPid);
	const ms = Math.max(0, safeNumber(cfg?.instakillWarPairMs));
	rt.warPairs[key] = {
		createdAt: Date.now(),
		endAt: ms > 0 ? Date.now() + ms : 0,
	};

	if (cfg?.instakillWarAnnounce && typeof game.log === "function") {
		try {
			game.log(victim, "被", killer, "肢解，鸡蛋大战开始！");
		} catch (e) {}
	}

	// 先扔 1 个蛋作为“开战信号”
	if (canThrowNow(victim, killer, game, _status)) safeThrowEgg(victim, killer);

	// 若对方不是本地 AI（不会自动反击），就由濒死方单方面连砸一会儿，形成“大战”观感
	if (!isLocalAIPlayer(killer, game, _status)) {
		const st = ensureStorage(victim);
		const pr = ensurePairRuntime(st, game);
		if (!pr) return;
		startBurst(
			victim,
			killer,
			safeNumber(cfg?.instakillWarBurstMs),
			safeNumber(cfg?.instakillWarBurstIntervalMs),
			pr,
			game,
			_status
		);
	}
}

/**
 * @param {*} rt
 * @param {string} pidA
 * @param {string} pidB
 * @returns {boolean}
 */
function isWarPairActive(rt, pidA, pidB, now) {
	if (!rt || !pidA || !pidB) return false;
	const map = rt.warPairs && typeof rt.warPairs === "object" ? rt.warPairs : null;
	if (!map) return false;
	const key = makePairKey(pidA, pidB);
	const job = map[key];
	if (!job) return false;
	const endAt = safeNumber(job.endAt);
	if (endAt > 0 && now > endAt) {
		delete map[key];
		return false;
	}
	return true;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function makePairKey(a, b) {
	a = String(a || "");
	b = String(b || "");
	if (!a || !b) return "";
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * @param {*} event
 * @param {*} actor
 * @param {*} game
 * @returns {boolean}
 */
function filterRewriteDiscardResult(event, actor, game) {
	const _status = pickStatus(game);
	if (_status?.connectMode) return false;
	if (!event || !actor || !game) return false;
	const parent = typeof event.getParent === "function" ? event.getParent() : null;
	if (String(parent?.name || "") !== "guohe") return false;
	const target = event.target;
	if (!target || target === actor) return false;
	return isLocalAIPlayer(target, game, _status);
}

/**
 * @param {*} trigger
 * @param {*} actor
 * @param {*} game
 * @returns {void}
 */
function onRewriteDiscardResult(trigger, actor, game) {
	if (!trigger || !actor || !game) return;
	const _status = pickStatus(game);
	if (_status?.connectMode) return;
	const target = trigger.target;
	if (!target || target === actor) return;
	if (!isLocalAIPlayer(target, game, _status)) return;
	checkRageAndMaybeThrow(target, actor, game, _status);
}

/**
 * @param {*} event
 * @param {*} actor
 * @param {*} game
 * @returns {boolean}
 */
function filterRewriteGainResult(event, actor, game) {
	const _status = pickStatus(game);
	if (_status?.connectMode) return false;
	if (!event || !actor || !game) return false;
	const parent = typeof event.getParent === "function" ? event.getParent() : null;
	if (String(parent?.name || "") !== "shunshou") return false;
	const target = event.target;
	if (!target || target === actor) return false;
	return isLocalAIPlayer(target, game, _status);
}

/**
 * @param {*} trigger
 * @param {*} actor
 * @param {*} game
 * @returns {void}
 */
function onRewriteGainResult(trigger, actor, game) {
	if (!trigger || !actor || !game) return;
	const _status = pickStatus(game);
	if (_status?.connectMode) return;
	const target = trigger.target;
	if (!target || target === actor) return;
	if (!isLocalAIPlayer(target, game, _status)) return;
	checkRageAndMaybeThrow(target, actor, game, _status);
}

/**
 * 检查“AI 对 target 的定向怒气”是否达到阈值，并按阶段触发丢鸡蛋。
 *
 * @param {*} aiPlayer 本地 AI（丢鸡蛋者）
 * @param {*} target 被丢鸡蛋者
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
function checkRageAndMaybeThrow(aiPlayer, target, game, _status) {
	if (!aiPlayer || !target || !game) return;
	if (_status?.connectMode) return;
	if (aiPlayer === target) return;
	if (typeof aiPlayer.throwEmotion !== "function") return;

	const aiSt = ensureStorage(aiPlayer);
	const mem = aiSt?.memory;
	if (!mem || !mem.rageTowards || typeof mem.rageTowards !== "object") return;

	const targetPid = getPid(target);
	const rage = safeNumber(mem.rageTowards[targetPid]);
	if (rage <= 0) return;

	const stRt = ensurePairRuntime(aiSt, game);
	if (!stRt) return;

	// 先按 hysteresis 修正阶段（避免抖动）
	const h = safeNumber(stRt.cfg?.hysteresis);
	const stage1 = safeNumber(stRt.cfg?.stage1Threshold);
	const stage2 = safeNumber(stRt.cfg?.stage2Threshold);

	let stage = safeNumber(stRt.stageByTarget[targetPid]);
	if (rage < stage1 - h) stage = 0;
	else if (stage === 2 && rage < stage2 - h) stage = 1;
	stRt.stageByTarget[targetPid] = stage;

	// 阶段2：可能一次跨过阶段1（大额怒气增长），此时先补丢 1 个再进入高频
	if (rage >= stage2 && stage < 2) {
		if (stage < 1) safeThrowEgg(aiPlayer, target);
		stRt.stageByTarget[targetPid] = 2;
		startStage2Burst(aiPlayer, target, rage, stRt, game, _status);
		return;
	}

	// 阶段1：达到阈值丢 1 个
	if (rage >= stage1 && stage < 1) {
		stRt.stageByTarget[targetPid] = 1;
		safeThrowEgg(aiPlayer, target);
	}
}

/**
 * 启动阶段2的高频连丢（按人格选择持续时间与是否追加回合连丢）。
 *
 * @param {*} aiPlayer
 * @param {*} target
 * @param {number} rage
 * @param {*} pr
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
function startStage2Burst(aiPlayer, target, rage, pr, game, _status) {
	if (!aiPlayer || !target || !pr) return;
	if (_status?.connectMode) return;

	// 防刷屏：限制同时连丢目标数
	if (countActiveBursts(pr) >= safeNumber(pr.cfg?.maxBurstTargets)) return;

	const targetPid = getPid(target);
	if (pr.activeBurstByTarget[targetPid]) return;

	const personaId = String(aiPlayer?.storage?.slqj_ai?.persona?.id || "");
	const pattern = resolveStage2Pattern(personaId, pr.cfg);

	const extraMs = Math.min(
		safeNumber(pr.cfg?.stage2ExtraCapMs),
		Math.max(0, (rage - safeNumber(pr.cfg?.stage2Threshold)) * safeNumber(pr.cfg?.stage2ExtraPerRageMs))
	);
	const durationMs = safeNumber(pattern.baseDurationMs) + extraMs;

	startBurst(aiPlayer, target, durationMs, safeNumber(pr.cfg?.burstIntervalMs), pr, game, _status);

	// petty：10 秒 + 随机后续回合再丢几秒（若怒气已冷却到阶段1以下则不追加）
	if (pattern.followup) {
		scheduleFollowup(aiPlayer, target, pr, game);
	}
}

/**
 * @param {string} personaId
 * @param {*} cfg
 * @returns {{baseDurationMs:number, followup:boolean}}
 */
function resolveStage2Pattern(personaId, cfg) {
	const shortMs = safeNumber(cfg?.stage2ShortMs);
	const longMs = safeNumber(cfg?.stage2LongMs);
	// 约定映射：
	// - balanced/camouflage：更克制，2 秒
	// - impulsive：上头，10 秒
	// - petty：记仇，10 秒 + 未来随机回合再丢几秒
	if (personaId === "impulsive") return { baseDurationMs: longMs, followup: false };
	if (personaId === "petty") return { baseDurationMs: longMs, followup: true };
	if (personaId === "camouflage") return { baseDurationMs: shortMs, followup: false };
	return { baseDurationMs: shortMs, followup: false };
}

/**
 * 安排后续回合的“追加连丢”。
 *
 * @param {*} aiPlayer
 * @param {*} target
 * @param {*} pr
 * @param {*} game
 * @returns {void}
 */
function scheduleFollowup(aiPlayer, target, pr, game) {
	if (!aiPlayer || !target || !pr || !game) return;

	const targetPid = getPid(target);
	const turnId = safeNumber(game?.__slqjAiPersona?.friendlyRageEggThrow?.turnId);
	const delayMin = safeNumber(pr.cfg?.followupDelayTurnsMin);
	const delayMax = safeNumber(pr.cfg?.followupDelayTurnsMax);
	const dueTurnId = turnId + randInt(delayMin, delayMax);

	const msMin = safeNumber(pr.cfg?.followupBurstMsMin);
	const msMax = safeNumber(pr.cfg?.followupBurstMsMax);
	const durationMs = randInt(msMin, msMax);

	pr.followupByTarget[targetPid] = { dueTurnId, durationMs };
}

/**
 * 处理某 AI 的 followup 队列：到期则触发追加连丢。
 *
 * @param {*} aiPlayer
 * @param {number} currentTurnId
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
function processFollowups(aiPlayer, currentTurnId, game, _status) {
	if (!aiPlayer || !game) return;
	if (_status?.connectMode) return;
	if (typeof aiPlayer.throwEmotion !== "function") return;

	const st = ensureStorage(aiPlayer);
	const pr = ensurePairRuntime(st, game);
	if (!pr) return;

	for (const [targetPid, job] of Object.entries(pr.followupByTarget || {})) {
		const dueTurnId = safeNumber(job?.dueTurnId);
		if (!dueTurnId || dueTurnId > currentTurnId) continue;

		// 若怒气已明显冷却，则取消追加（避免无意义刷屏）
		const rage = safeNumber(st?.memory?.rageTowards?.[targetPid]);
		if (rage < safeNumber(pr.cfg?.stage1Threshold) - safeNumber(pr.cfg?.hysteresis)) {
			delete pr.followupByTarget[targetPid];
			continue;
		}

		const target = findPlayerByPid(game, targetPid);
		if (!target) {
			delete pr.followupByTarget[targetPid];
			continue;
		}

		// 若正在对该目标连丢，则顺延 1 回合
		if (pr.activeBurstByTarget[targetPid]) {
			pr.followupByTarget[targetPid] = {
				dueTurnId: currentTurnId + 1,
				durationMs: safeNumber(job?.durationMs),
			};
			continue;
		}

		startBurst(aiPlayer, target, safeNumber(job?.durationMs), safeNumber(pr.cfg?.burstIntervalMs), pr, game, _status);
		delete pr.followupByTarget[targetPid];
	}
}

/**
 * 启动一个“定时连丢”任务。
 *
 * @param {*} from
 * @param {*} target
 * @param {number} durationMs
 * @param {number} intervalMs
 * @param {*} pr
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
function startBurst(from, target, durationMs, intervalMs, pr, game, _status) {
	if (!from || !target || !pr) return;
	if (_status?.connectMode) return;
	if (_status?.over) return;
	if (typeof from.throwEmotion !== "function") return;

	const targetPid = getPid(target);
	if (pr.activeBurstByTarget[targetPid]) return;

	const ms = Math.max(300, safeNumber(intervalMs) || 300);
	const dur = Math.max(400, safeNumber(durationMs) || 400);
	const endAt = Date.now() + dur;

	const id = setInterval(() => {
		try {
			if (Date.now() >= endAt) {
				clearInterval(id);
				delete pr.activeBurstByTarget[targetPid];
				return;
			}
			if (!canThrowNow(from, target, game, _status)) {
				clearInterval(id);
				delete pr.activeBurstByTarget[targetPid];
				return;
			}
			safeThrowEgg(from, target);
		} catch (e) {
			try {
				clearInterval(id);
			} catch (e2) {}
			delete pr.activeBurstByTarget[targetPid];
		}
	}, ms);

	pr.activeBurstByTarget[targetPid] = { id, endAt };

	// 兜底：到点强制清理（防止 interval 丢失/异常不清）
	setTimeout(() => {
		try {
			const cur = pr.activeBurstByTarget[targetPid];
			if (!cur) return;
			if (cur.id !== id) return;
			clearInterval(id);
		} catch (e) {}
		delete pr.activeBurstByTarget[targetPid];
	}, dur + 250);
}

/**
 * @param {*} pr
 * @returns {number}
 */
function countActiveBursts(pr) {
	const map = pr && pr.activeBurstByTarget && typeof pr.activeBurstByTarget === "object" ? pr.activeBurstByTarget : null;
	if (!map) return 0;
	return Object.keys(map).length;
}

/**
 * 为某 AI 玩家确保存放状态的 runtime 字段存在。
 *
 * @param {*} aiStorage ensureStorage(aiPlayer) 的结果
 * @param {*} game
 * @returns {{cfg:any, stageByTarget:Record<string, number>, activeBurstByTarget:Record<string, any>, followupByTarget:Record<string, any>}}
 */
function ensurePairRuntime(aiStorage, game) {
	if (!aiStorage) return null;
	aiStorage.runtime ??= { turnsTaken: 0, installedAtRound: game?.roundNumber || 0 };
	const rt = aiStorage.runtime;
	rt.friendlyRageEggThrow ??= Object.create(null);
	const pr = rt.friendlyRageEggThrow;
	const rootCfg = game?.__slqjAiPersona?.friendlyRageEggThrow?.cfg;
	pr.cfg = rootCfg && typeof rootCfg === "object" ? rootCfg : CFG;
	if (!pr.stageByTarget || typeof pr.stageByTarget !== "object") pr.stageByTarget = Object.create(null);
	if (!pr.activeBurstByTarget || typeof pr.activeBurstByTarget !== "object") pr.activeBurstByTarget = Object.create(null);
	if (!pr.followupByTarget || typeof pr.followupByTarget !== "object") pr.followupByTarget = Object.create(null);
	if (!pr.eggHitBySource || typeof pr.eggHitBySource !== "object") pr.eggHitBySource = Object.create(null);
	if (!pr.lastRetaliateAtByTarget || typeof pr.lastRetaliateAtByTarget !== "object") pr.lastRetaliateAtByTarget = Object.create(null);
	if (!pr.lastWarRetaliateAtByTarget || typeof pr.lastWarRetaliateAtByTarget !== "object")
		pr.lastWarRetaliateAtByTarget = Object.create(null);
	if (!pr.retaliateCountByTarget || typeof pr.retaliateCountByTarget !== "object") pr.retaliateCountByTarget = Object.create(null);
	if (typeof pr.retaliateTurnId !== "number" || Number.isNaN(pr.retaliateTurnId)) pr.retaliateTurnId = 0;
	return pr;
}

/**
 * 重置“仅当前回合有效”的临时状态（用于反击限额等）。
 *
 * @param {*} aiPlayer
 * @param {number} turnId
 * @param {*} game
 * @returns {void}
 */
function resetTurnTransient(aiPlayer, turnId, game) {
	if (!aiPlayer || !game) return;
	const st = ensureStorage(aiPlayer);
	const pr = ensurePairRuntime(st, game);
	if (!pr) return;
	if (pr.retaliateTurnId === turnId) return;
	pr.retaliateTurnId = turnId;
	pr.retaliateCountByTarget = Object.create(null);
}

/**
 * 判断当前是否允许投掷表情（双方存活/方法存在/非联机）。
 *
 * @param {*} from
 * @param {*} target
 * @param {*} game
 * @param {*} _status
 * @returns {boolean}
 */
function canThrowNow(from, target, game, _status) {
	if (_status?.connectMode) return false;
	if (_status?.over) return false;
	if (!from || !target) return false;
	if (from === target) return false;
	if (typeof from.throwEmotion !== "function") return false;

	const cfg = game?.__slqjAiPersona?.friendlyRageEggThrow?.cfg || CFG;
	const allowDeadThrow = !!cfg.allowDeadThrow;
	const allowDeadTarget = !!cfg.allowDeadTarget;
	if (!allowDeadThrow && safeIsDead(from)) return false;
	if (!allowDeadTarget && safeIsDead(target)) return false;
	// 游戏对象缺失时保守放行（仅影响 UI 表情）
	if (!game) return true;
	return true;
}

/**
 * 安全投掷一个鸡蛋表情。
 *
 * @param {*} from
 * @param {*} target
 * @returns {void}
 */
function safeThrowEgg(from, target) {
	if (!from || !target) return;
	if (typeof from.throwEmotion !== "function") return;
	try {
		from.throwEmotion(target, "egg");
	} catch (e) {}
}

/**
 * @param {*} game
 * @param {string} pid
 * @returns {*|null}
 */
function findPlayerByPid(game, pid) {
	if (!game || !pid) return null;
	const all = (game.players || []).concat(game.dead || []);
	for (const p of all) {
		if (p && getPid(p) === pid) return p;
	}
	return null;
}

/**
 * @param {*} player
 * @returns {boolean}
 */
function safeIsDead(player) {
	try {
		if (!player) return true;
		if (typeof player.isDead === "function") return !!player.isDead();
		return !!player.dead;
	} catch (e) {
		return true;
	}
}

/**
 * @param {*} v
 * @returns {number}
 */
function safeNumber(v) {
	return typeof v === "number" && !Number.isNaN(v) ? v : 0;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function randInt(a, b) {
	a = Math.floor(safeNumber(a));
	b = Math.floor(safeNumber(b));
	if (a <= 0) a = 1;
	if (b < a) b = a;
	return a + Math.floor(Math.random() * (b - a + 1));
}
