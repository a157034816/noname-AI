/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 */

/**
 * scripts 插件元信息（用于“scripts 插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "界沮授武将红利（摸牌偏置诸葛连弩）",
	version: "1.0.0",
	description: "仅当玩家使用界沮授（xin_jushou）时生效：从牌堆摸牌时以较高概率把诸葛连弩（zhuge）移到牌堆顶，从而“更容易摸到诸葛连弩”。",
};

const SKILL_NAME = "slqj_bonus_xin_jushou_zhuge_draw";
const DEFAULT_CHANCE = 0.75;

/**
 * scripts 插件入口：安装界沮授（xin_jushou）摸牌红利（偏置诸葛连弩）。
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
 * @returns {{installed?:boolean, cfg?:{chance:number, generalKey:string, cardKey:string, debug:boolean}, api?:{onDrawBegin:Function}}|null}
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
		runtime.cfg = { chance: DEFAULT_CHANCE, generalKey: "xin_jushou", cardKey: "zhuge", debug: false };
	} else {
		if (typeof runtime.cfg.chance !== "number") runtime.cfg.chance = DEFAULT_CHANCE;
		if (typeof runtime.cfg.generalKey !== "string") runtime.cfg.generalKey = "xin_jushou";
		if (typeof runtime.cfg.cardKey !== "string") runtime.cfg.cardKey = "zhuge";
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

			const chance = typeof cfg.chance === "number" ? cfg.chance : DEFAULT_CHANCE;
			if (!(chance > 0)) return;
			if (Math.random() >= chance) return;

			const cardKey = typeof cfg.cardKey === "string" ? cfg.cardKey : "zhuge";
			if (!cardKey) return;

			const ok = tryMoveNamedCardToPileTop(cardKey, ui);
			if (!ok) return;

			try {
				if (cfg.debug) {
					const trans = typeof get.translation === "function" ? get.translation(cardKey) : cardKey;
					console.debug("[身临其境的AI][bonus]", "move to top:", player?.name, trans);
				}
			} catch (e) {}
		};
	}

	return runtime;
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
