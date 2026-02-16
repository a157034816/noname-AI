import { isLocalAIPlayer } from "../src/ai_persona/lib/utils.js";

/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 */

/**
 * scripts 插件元信息（用于“脚本插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "界沮授 AI 加强（出牌优先触发渐营）",
	version: "1.0.0",
	description:
		"仅对界沮授（xin_jushou）生效：出牌阶段尽可能选择与上一张牌点数/花色相同的出牌序列，以更频繁触发「渐营」（xinjianying_draw）摸牌。",
};

const GENERAL_KEY = "xin_jushou";

/**
 * 默认策略参数（可在脚本内调整）。
 *
 * @type {{
 *  hookPriority:number,
 *  onlyLocalAi:boolean,
 *  affectManagedMe:boolean,
 *  debug:boolean,
 *  matchBonus:number,
 *  setupBonus:number,
 *  badMetaPenalty:number
 * }}
 */
const DEFAULT_CFG = {
	hookPriority: 2,
	onlyLocalAi: true,
	affectManagedMe: true,
	debug: false,
	matchBonus: 2.4,
	setupBonus: 0.8,
	badMetaPenalty: 0.6,
};

/**
 * scripts 插件入口：安装界沮授（xin_jushou）出牌阶段「渐营」触发优先策略。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setup(ctx) {
	const { game, hooks, _status, lib } = ctx || {};
	if (!game || !hooks || !lib) return;
	if (_status?.connectMode) return;

	const runtime = getOrCreateRuntime(game);
	if (!runtime || runtime.installed) return;
	runtime.installed = true;
	runtime._status = _status || null;

	try {
		runtime.cfg.debug =
			runtime.cfg.debug === true || !!lib?.config?.dev || globalThis.__slqjAiXinJushouJianyingDebug === true;
	} catch (e) {}

	hooks.on(
		"slqj_ai_score",
		(scoreCtx) => {
			applyJianyingPriorityScore({ game, runtime, scoreCtx });
		},
		{ priority: runtime.cfg.hookPriority }
	);
}

/**
 * 获取（或创建）运行时对象，并挂载到 `game.__slqjAiPersona.xinJushouJianyingAi`。
 *
 * @param {*} game
 * @returns {{installed?:boolean, cfg:any, _status?:any}|null}
 */
function getOrCreateRuntime(game) {
	if (!game) return null;
	const root =
		game.__slqjAiPersona && typeof game.__slqjAiPersona === "object" ? game.__slqjAiPersona : (game.__slqjAiPersona = {});
	root.xinJushouJianyingAi ??= {};
	const runtime = root.xinJushouJianyingAi;
	runtime.cfg = normalizeCfg(runtime.cfg);
	return runtime;
}

/**
 * @param {any} input
 * @returns {typeof DEFAULT_CFG}
 */
function normalizeCfg(input) {
	const cfg = input && typeof input === "object" ? { ...DEFAULT_CFG, ...input } : { ...DEFAULT_CFG };
	if (typeof cfg.hookPriority !== "number") cfg.hookPriority = DEFAULT_CFG.hookPriority;
	if (typeof cfg.onlyLocalAi !== "boolean") cfg.onlyLocalAi = DEFAULT_CFG.onlyLocalAi;
	if (typeof cfg.affectManagedMe !== "boolean") cfg.affectManagedMe = DEFAULT_CFG.affectManagedMe;
	if (typeof cfg.debug !== "boolean") cfg.debug = DEFAULT_CFG.debug;
	if (typeof cfg.matchBonus !== "number") cfg.matchBonus = DEFAULT_CFG.matchBonus;
	if (typeof cfg.setupBonus !== "number") cfg.setupBonus = DEFAULT_CFG.setupBonus;
	if (typeof cfg.badMetaPenalty !== "number") cfg.badMetaPenalty = DEFAULT_CFG.badMetaPenalty;
	return cfg;
}

/**
 * 判断是否为界沮授（xin_jushou）玩家。
 *
 * @param {*} player
 * @returns {boolean}
 */
function isXinJushouPlayer(player) {
	if (!player) return false;
	/** @type {string[]} */
	const names = [];
	try {
		if (typeof player.name === "string") names.push(player.name);
		if (typeof player.name1 === "string") names.push(player.name1);
		if (typeof player.name2 === "string") names.push(player.name2);
		if (typeof player.name3 === "string") names.push(player.name3);
		if (typeof player.name4 === "string") names.push(player.name4);
	} catch (e) {}
	if (names.includes(GENERAL_KEY)) return true;
	try {
		if (typeof player.hasSkill === "function" && player.hasSkill("xinjianying")) return true;
	} catch (e) {}
	return false;
}

/**
 * 是否应该对该玩家应用策略（默认仅本地 AI，不影响人类玩家手操）。
 *
 * @param {*} player
 * @param {*} game
 * @param {*} runtime
 * @param {*} _status
 * @returns {boolean}
 */
function shouldAffectPlayer(player, game, runtime, _status) {
	if (!player) return false;
	if (!isXinJushouPlayer(player)) return false;

	// 玩家本人（game.me）：默认不影响手操；仅在“托管”时允许接管（可通过 affectManagedMe 关闭）。
	if (player === game?.me) {
		if (!runtime?.cfg?.affectManagedMe) return false;
		const st = _status || runtime?._status || globalThis._status;
		if (!isLocalAIPlayer(player, game, st)) return false;
		return true;
	}

	if (runtime?.cfg?.onlyLocalAi) {
		const st = _status || runtime?._status || globalThis._status;
		if (!isLocalAIPlayer(player, game, st)) return false;
	}
	return true;
}

/**
 * 在 `slqj_ai_score`（chooseCard）阶段注入评分影响：
 * - 若本阶段已有上一张牌：强烈偏好“点数或花色相同”的候选（更易触发渐营摸牌）
 * - 若本阶段尚无上一张牌：轻微偏好“更容易连锁”的候选（为下一张牌做铺垫）
 *
 * @param {{game:any, runtime:any, scoreCtx:any}} opts
 * @returns {void}
 */
function applyJianyingPriorityScore(opts) {
	const { game, runtime } = opts || {};
	const c = opts?.scoreCtx;
	if (!game || !runtime || !c) return;
	if (c.kind !== "chooseCard") return;
	if (c.stage !== "final") return;

	const player = c.player;
	const card = c.candidate;
	if (!player || !card) return;

	const st = runtime?._status || globalThis._status;
	const statusEvent = c.event || st?.event || null;
	if (!player.isPhaseUsing || player.isPhaseUsing() !== true) return;
	if (!shouldAffectPlayer(player, game, runtime, st)) return;

	// 仅在“出牌阶段使用牌（chooseToUse）”相关的选牌上加权，避免影响其他类型的 chooseCard（如弃牌成本/拼点等）。
	if (!isChooseToUseContext(statusEvent)) return;

	const phaseUseEvt = getPhaseUseEvent(statusEvent);
	if (!phaseUseEvt) return;

	const meta = getCardMeta(card, player);
	if (!meta.ok) {
		c.score -= runtime.cfg.badMetaPenalty;
		return;
	}

	const last = getLastUsedInSamePhaseUse(player, phaseUseEvt);
	if (last?.card) {
		const lastMeta = getCardMeta(last.card, player);
		if (!lastMeta.ok) return;
		if (meta.suit === lastMeta.suit || meta.number === lastMeta.number) {
			// 尽可能触发：对“可触发渐营”的候选显著加权
			c.score += runtime.cfg.matchBonus;
			debugLog(runtime, "[渐营] match", player, card, meta, last.card, lastMeta);
		}
		return;
	}

	// 该 phaseUse 内尚无上一张牌：偏好更容易形成后续连锁的候选（同花色/同点数在手牌中出现更多）
	const chainScore = estimateChainPotential(player, card, meta);
	if (chainScore > 0) {
		c.score += runtime.cfg.setupBonus * chainScore;
		debugLog(runtime, "[渐营] setup", player, card, meta, null, null);
	}
}

/**
 * 获取当前处于同一个出牌阶段（phaseUse）的事件对象。
 *
 * @param {*} statusEvent
 * @returns {*|null}
 */
function getPhaseUseEvent(statusEvent) {
	if (!statusEvent || typeof statusEvent.getParent !== "function") return null;
	try {
		const p = statusEvent.getParent("phaseUse");
		return p && p.name === "phaseUse" ? p : null;
	} catch (e) {
		return null;
	}
}

/**
 * 判断当前 `_status.event` 是否处于“出牌阶段使用牌（chooseToUse）”上下文中。
 *
 * @param {*} statusEvent
 * @returns {boolean}
 */
function isChooseToUseContext(statusEvent) {
	if (!statusEvent) return false;
	try {
		if (statusEvent.name === "chooseToUse") return true;
		if (typeof statusEvent.getParent === "function" && statusEvent.getParent("chooseToUse")) return true;
	} catch (e) {}
	return false;
}

/**
 * 获取玩家在同一个 phaseUse 内的上一张“使用牌事件”。
 *
 * @param {*} player
 * @param {*} phaseUseEvt
 * @returns {*|null}
 */
function getLastUsedInSamePhaseUse(player, phaseUseEvt) {
	if (!player || !phaseUseEvt) return null;
	if (typeof player.getLastUsed !== "function") return null;
	let evt = null;
	try {
		evt = player.getLastUsed();
	} catch (e) {
		evt = null;
	}
	if (!evt || !evt.card || typeof evt.getParent !== "function") return null;
	try {
		const p = evt.getParent("phaseUse");
		if (p && p === phaseUseEvt) return evt;
	} catch (e) {}
	return null;
}

/**
 * 读取卡牌的“渐营相关元信息”（花色/点数），并做有效性校验。
 *
 * @param {*} card
 * @param {*} player
 * @returns {{ok:boolean, suit:string, number:number}}
 */
function getCardMeta(card, player) {
	try {
		const suit = String(get.suit(card, player) || "");
		const number = get.number(card, player);
		if (!suit || suit === "none") return { ok: false, suit: "", number: -1 };
		if (typeof number !== "number") return { ok: false, suit: "", number: -1 };
		return { ok: true, suit, number };
	} catch (e) {
		return { ok: false, suit: "", number: -1 };
	}
}

/**
 * 估算“作为本阶段第一张牌”的连锁潜力：手牌中与其同花色/同点数的数量越多，越容易触发后续渐营。
 *
 * @param {*} player
 * @param {*} card
 * @param {{ok:boolean, suit:string, number:number}} meta
 * @returns {number} 返回 [0, 1] 区间的归一化得分
 */
function estimateChainPotential(player, card, meta) {
	if (!player || !meta?.ok) return 0;
	if (typeof player.getCards !== "function") return 0;

	let hs = [];
	try {
		hs = player.getCards("h") || [];
	} catch (e) {
		hs = [];
	}
	if (!Array.isArray(hs) || hs.length <= 1) return 0;

	let sameSuit = 0;
	let sameNumber = 0;
	for (const c of hs) {
		if (!c || c === card) continue;
		const m = getCardMeta(c, player);
		if (!m.ok) continue;
		if (m.suit === meta.suit) sameSuit++;
		if (m.number === meta.number) sameNumber++;
	}

	const raw = Math.max(sameSuit, sameNumber);
	if (raw <= 0) return 0;
	// 归一化：1张同类≈0.5，2张及以上≈1.0
	return Math.min(1, raw / 2);
}

/**
 * @param {*} runtime
 * @param {string} tag
 * @param {*} player
 * @param {*} card
 * @param {*} meta
 * @param {*} lastCard
 * @param {*} lastMeta
 * @returns {void}
 */
function debugLog(runtime, tag, player, card, meta, lastCard, lastMeta) {
	if (!runtime?.cfg?.debug) return;
	try {
		const who = String(player?.name || player?.name1 || "");
		const cur = String(get.translation?.(card) || card?.name || "");
		const last = lastCard ? String(get.translation?.(lastCard) || lastCard?.name || "") : "";
		console.debug("[身临其境的AI]", tag, who, cur, meta, last, lastMeta || "");
	} catch (e) {}
}
