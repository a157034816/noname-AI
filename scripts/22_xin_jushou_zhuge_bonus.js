/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 */

/**
 * scripts 插件元信息（用于“脚本插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "界沮授武将红利（摸牌影响诸葛连弩）",
	version: "1.0.1",
	description:
		"仅当玩家使用界沮授（xin_jushou）时生效：从牌堆摸牌时以较高概率把诸葛连弩（zhuge）移到牌堆顶，从而“更容易摸到诸葛连弩”；若已持有诸葛连弩，则再次影响的概率会大幅降低。",
};

const SKILL_NAME = "slqj_bonus_xin_jushou_zhuge_draw";
const DEFAULT_CHANCE = 0.75;
const DEFAULT_HAS_CARD_CHANCE_FACTOR = 0.02;

/**
 * scripts 插件入口：安装界沮授（xin_jushou）摸牌红利（影响诸葛连弩）。
 *
 * 说明：
 * - 使用引擎事件 `drawBegin` 注入：在真正摸牌前，将牌堆中的诸葛连弩移动到牌堆顶
 * - 不凭空生成牌：仅在牌堆中存在 `zhuge` 时才会生效
 * - 脚本模块顶层无副作用：仅在入口函数被调用后才注册全局技能
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setup(ctx) {
	const gameRef = ctx?.game;
	const libRef = ctx?.lib;
	const statusRef = ctx?._status;
	if (!gameRef || !libRef) return;
	if (statusRef?.connectMode) return;

	const runtime = getOrCreateRuntime(gameRef);
	if (!runtime || runtime.installed) return;
	runtime.installed = true;

	if (!libRef.skill[SKILL_NAME]) {
		libRef.skill[SKILL_NAME] = {
			trigger: { player: "drawBegin" },
			forced: true,
			silent: true,
			popup: false,
			priority: 100,
			/**
			 * @param {any} event
			 * @param {any} player
			 * @returns {boolean}
			 */
			filter(event, player) {
				if (_status?.connectMode) return false;
				if (!event || !player) return false;
				if (event.bottom) return false;
				if (event.drawDeck) return false;
				if (event.otherGetCards) return false;

				const n = typeof event.num === "number" ? event.num : 1;
				if (n <= 0) return false;

				/** @type {string[]} */
				const names = [];
				try {
					if (typeof player.name === "string") names.push(player.name);
					if (typeof player.name1 === "string") names.push(player.name1);
					if (typeof player.name2 === "string") names.push(player.name2);
					if (typeof player.name3 === "string") names.push(player.name3);
					if (typeof player.name4 === "string") names.push(player.name4);
				} catch (e) {}
				return names.includes("xin_jushou");
			},
			/**
			 * @returns {void}
			 */
			content() {
				const api = game?.__slqjAiPersona?.xinJushouZhugeBonus?.api;
				if (api && typeof api.onDrawBegin === "function") {
					api.onDrawBegin(trigger, player, game, get, ui, _status);
				}
			},
		};
	}

	try {
		if (typeof gameRef.addGlobalSkill === "function") gameRef.addGlobalSkill(SKILL_NAME);
	} catch (e) {}
}

/**
 * 获取（或创建）运行时对象，并挂载到 `game.__slqjAiPersona.xinJushouZhugeBonus`。
 *
 * @param {*} game
 * @returns {{installed?:boolean, cfg?:{chance:number, generalKey:string, cardKey:string, hasCardChanceFactor:number, debug:boolean}, api?:{onDrawBegin:Function}}|null}
 */
function getOrCreateRuntime(game) {
	if (!game) return null;
	const root =
		game.__slqjAiPersona && typeof game.__slqjAiPersona === "object" ? game.__slqjAiPersona : (game.__slqjAiPersona = {});

	if (!root.xinJushouZhugeBonus || typeof root.xinJushouZhugeBonus !== "object") {
		root.xinJushouZhugeBonus = {};
	}
	const runtime = root.xinJushouZhugeBonus;

	if (!runtime.cfg || typeof runtime.cfg !== "object") {
		runtime.cfg = {
			chance: DEFAULT_CHANCE,
			generalKey: "xin_jushou",
			cardKey: "zhuge",
			hasCardChanceFactor: DEFAULT_HAS_CARD_CHANCE_FACTOR,
			debug: false,
		};
	} else {
		if (typeof runtime.cfg.chance !== "number") runtime.cfg.chance = DEFAULT_CHANCE;
		if (typeof runtime.cfg.generalKey !== "string") runtime.cfg.generalKey = "xin_jushou";
		if (typeof runtime.cfg.cardKey !== "string") runtime.cfg.cardKey = "zhuge";
		if (typeof runtime.cfg.hasCardChanceFactor !== "number") runtime.cfg.hasCardChanceFactor = DEFAULT_HAS_CARD_CHANCE_FACTOR;
		if (typeof runtime.cfg.debug !== "boolean") runtime.cfg.debug = false;
	}

	if (!runtime.api || typeof runtime.api !== "object") runtime.api = {};
	if (typeof runtime.api.onDrawBegin !== "function") {
		/**
		 * `drawBegin` 注入：概率触发时把指定牌（默认：诸葛连弩）移到牌堆顶。
		 *
		 * @param {*} trigger
		 * @param {*} player
		 * @param {*} game
		 * @param {*} get
		 * @param {*} ui
		 * @param {*} _status
		 * @returns {void}
		 */
		runtime.api.onDrawBegin = function onDrawBegin(trigger, player, game, get, ui, _status) {
			if (_status?.connectMode) return;
			if (!trigger || !player || !game || !get || !ui) return;
			if (trigger.bottom) return;
			if (trigger.drawDeck) return;
			if (trigger.otherGetCards) return;

			const rt = game?.__slqjAiPersona?.xinJushouZhugeBonus;
			const cfg = rt?.cfg || {};
			if (cfg.generalKey !== "xin_jushou") return;

			const cardKey = typeof cfg.cardKey === "string" ? cfg.cardKey : "zhuge";
			if (!cardKey) return;

			const baseChance = typeof cfg.chance === "number" ? cfg.chance : DEFAULT_CHANCE;
			const chance = computeEffectiveChance(baseChance, cfg, player, cardKey);
			if (!(chance > 0)) return;
			if (Math.random() >= chance) return;

			const ok = tryMoveNamedCardToPileTop(cardKey, ui);
			if (!ok) return;

			try {
				if (cfg.debug) {
					const trans = typeof get.translation === "function" ? get.translation(cardKey) : cardKey;
					const owned = playerHasNamedCard(player, cardKey);
					console.debug("[身临其境的AI][bonus]", "move to top:", player?.name, trans, owned ? "(owned)" : "");
				}
			} catch (e) {}
		};
	}

	return runtime;
}

/**
 * 计算本次摸牌影响的实际触发概率。
 *
 * - 未持有目标牌：`chance`
 * - 已持有目标牌：`chance * hasCardChanceFactor`（默认 0.02，即显著降低重复摸到的概率）
 *
 * @param {number} chance
 * @param {{hasCardChanceFactor?:number}} cfg
 * @param {*} player
 * @param {string} cardKey
 * @returns {number}
 */
function computeEffectiveChance(chance, cfg, player, cardKey) {
	let effectiveChance = chance;
	if (playerHasNamedCard(player, cardKey)) {
		const factor =
			typeof cfg?.hasCardChanceFactor === "number" ? cfg.hasCardChanceFactor : DEFAULT_HAS_CARD_CHANCE_FACTOR;
		const normalizedFactor = Math.max(0, Math.min(1, factor));
		effectiveChance = effectiveChance * normalizedFactor;
	}
	if (!(effectiveChance > 0)) return 0;
	return Math.min(1, effectiveChance);
}

/**
 * 判断玩家是否已持有指定牌名（手牌 + 装备区）。
 *
 * @param {*} player
 * @param {string} name
 * @returns {boolean}
 */
function playerHasNamedCard(player, name) {
	if (!player || !name) return false;
	try {
		if (typeof player.countCards === "function") {
			return player.countCards("he", name) > 0;
		}
		if (typeof player.getEquip === "function") {
			return !!player.getEquip(name);
		}
	} catch (e) {}
	return false;
}

/**
 * 尝试把牌堆中的某张指定牌名移动到牌堆顶（不移除，只调整顺序）。
 *
 * @param {string} name
 * @param {*} ui
 * @returns {boolean}
 */
function tryMoveNamedCardToPileTop(name, ui) {
	const pile = ui?.cardPile;
	if (!pile || !pile.childNodes) return false;

	let found = null;
	try {
		for (let i = 0; i < pile.childNodes.length; i++) {
			const card = pile.childNodes[i];
			const cardName = String(card?.name || card?.viewAs || "");
			if (cardName === name) {
				found = card;
				break;
			}
		}
	} catch (e) {
		found = null;
	}
	if (!found) return false;

	try {
		if (pile.firstChild !== found) pile.insertBefore(found, pile.firstChild);
	} catch (e) {
		return false;
	}
	return true;
}
