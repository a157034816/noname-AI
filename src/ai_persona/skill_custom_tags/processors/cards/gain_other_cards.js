/**
 * “获得他人牌/夺牌”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_GAIN_OTHER_CARDS } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createGainOtherCardsProcessor() {
	const CARD_TAIL = String.raw`[^。]{0,10}(?:手牌|牌)`;
	// 注意：“获得其中/其余…”通常是“从展示/牌堆顶/集合中取牌”，并非“获得其（他人）的牌”，这里排除“其(中/余)”前缀。
	const OTHER_PRONOUN = String.raw`(?:其(?!中|余)|该角色|目标角色|目标)`;
	const re1 = new RegExp(String.raw`获得${OTHER_PRONOUN}[^。]{0,30}(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	const re2 = new RegExp(String.raw`获得${OTHER_PRONOUN}区域内的[^。]{0,30}牌`);
	const re3 = new RegExp(String.raw`获得${OTHER_PRONOUN}[^。]{0,30}弃置的[^。]{0,30}牌`);
	// 兼容：“获得一名其他角色两张手牌/获得…其他角色一张手牌”。
	const reOtherRoleHand = new RegExp(String.raw`获得[^。]{0,20}其他角色[^。]{0,20}(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	// 兼容：“随机获得一名其他角色手牌中的…牌”。
	const reOtherRoleHandIn = /获得一名其他角色手牌中/;
	// 兼容：“获得对你造成伤害的牌”。
	const reDamageCard = /获得对你造成伤害的牌/;
	// 兼容：“观看其手牌并获得其中一张”。
	const reWatchHandGetOne = /观看其手牌[^。]{0,30}获得其中一张/;
	// 兼容：“其他角色…弃置…后，你获得这些牌”。
	const reOtherDiscardGetThese = /其他角色[^。]{0,40}弃置[^。]{0,40}你获得这些牌/;
	// 兼容：“令一名其他角色交给你至少X张牌/交给你X-1张牌/交给你等同于你手牌数的牌”。
	const reGiveToYou = new RegExp(String.raw`交给你(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	const reGiveToYouEqualHand = /交给你等同于你手牌数的牌/;

	return {
		id: "gain_other_cards",
		description: "识别技能说明中“获得其他角色的牌”的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("获得") && !text.includes("交给你") && !text.includes("赠予你")) return null;
			if (
				!(
					re1.test(text) ||
					re2.test(text) ||
					re3.test(text) ||
					reOtherRoleHand.test(text) ||
					reOtherRoleHandIn.test(text) ||
					reDamageCard.test(text) ||
					reWatchHandGetOne.test(text) ||
					reOtherDiscardGetThese.test(text) ||
					reGiveToYou.test(text) ||
					reGiveToYouEqualHand.test(text)
				)
			) {
				return null;
			}
			return { [TAG_GAIN_OTHER_CARDS]: true };
		},
	};
}
