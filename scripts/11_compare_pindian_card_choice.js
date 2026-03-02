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
	name: "拼点：被发起人让点/争点",
	version: "1.0.0",
	description: "当 AI 作为拼点的被发起人时：若对发起人态度为友方则总选点数更小的牌；否则总选点数更大的牌。",
};

/**
 * scripts 插件配置（用于“脚本插件管理 -> 配置(⚙)”）。
 *
 * @type {{version:1, items:Array<any>}}
 */
export const slqjAiScriptConfig = {
	version: 1,
	items: [
		{
			key: "friendAttitudeMin",
			name: "友方阈值（attitude > x 视为队友）",
			type: "number",
			default: 0,
			min: -10,
			max: 10,
			step: 0.1,
			description: "默认 0：与扩展整体逻辑一致（attitude>0 视为友方）。",
		},
	],
};

/**
 * 安装“拼点被发起人选牌”规则。
 *
 * 接入点：`slqj_ai_score`（由扩展对 `ai.basic.chooseCard` 的包装提供）。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setupComparePindianCardChoice(ctx) {
	const game = ctx && ctx.game;
	const get = ctx && ctx.get;
	const hooks = ctx && ctx.hooks;
	const _status = ctx && ctx._status;
	const cfg = (ctx && ctx.scriptConfig) || {};

	if (!game || !get || !hooks || typeof hooks.on !== "function") return;
	if (game.__slqjAiComparePindianCardChoiceInstalled) return;
	game.__slqjAiComparePindianCardChoiceInstalled = true;

	const friendAttitudeMin = typeof cfg.friendAttitudeMin === "number" ? cfg.friendAttitudeMin : 0;

	hooks.on(
		"slqj_ai_score",
		/**
		 * @param {any} scoreCtx
		 * @returns {void}
		 */
		function slqjAiComparePindianCardChoiceHook(scoreCtx) {
			if (!scoreCtx || scoreCtx.kind !== "chooseCard" || scoreCtx.stage !== "final") return;
			const evt = scoreCtx.event;
			if (!evt || evt.type !== "compare") return;

			const player = scoreCtx.player;
			if (!player || !isLocalAIPlayer(player, game, _status)) return;

			const source = evt.source;
			if (!source || player === source) return;

			// 仅处理“卡牌候选”（chooseCard 的候选可能包含技能字符串）
			const candidate = scoreCtx.candidate;
			try {
				if (typeof get?.itemtype === "function" && get.itemtype(candidate) !== "card") return;
			} catch (e) {
				return;
			}

			let att = 0;
			try {
				att = Number(get.attitude(player, source)) || 0;
			} catch (e) {
				att = 0;
			}
			const isFriend = att > friendAttitudeMin;

			let num = 0;
			try {
				num = Number(get.number(candidate, player)) || 0;
			} catch (e) {
				num = Number(candidate && candidate.number) || 0;
			}

			// 同点数的稳定 tie-break：优先牺牲低价值牌（不改变“点数更小/更大”的主序）
			let value = 0;
			try {
				value = Number(get.value(candidate, player)) || 0;
			} catch (e) {
				value = 0;
			}
			const tieBreak = Math.min(20, Math.max(0, value)) / 100;

			scoreCtx.score = (isFriend ? -num : num) - tieBreak;
			scoreCtx.stop = true;
		},
		{ priority: 999, title: "拼点：被发起人让点/争点" }
	);
}
