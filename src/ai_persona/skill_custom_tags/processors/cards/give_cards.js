/**
 * “交给/赠予牌”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_GIVE_CARDS } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createGiveCardsProcessor() {
	const CARD_TAIL = String.raw`[^。]{0,10}(?:手牌|牌|【[^】]+】)`;
	const reGive = new RegExp(String.raw`(?:交给|赠予)[^。]{0,40}(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	const reGiveBefore = new RegExp(String.raw`(?:将|把)?(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}[^。]{0,20}(?:交给|赠予)`);
	// 兼容：“将所有……手牌/牌交给……”（不显式写数量）。
	const reGiveAll = /将所有[^。]{0,40}(?:手牌|牌)[^。]{0,20}(?:交给|赠予)/;
	const reGiveEqual = /(?:交给|赠予)等量[^。]{0,30}角色/;
	const reShowGive = new RegExp(String.raw`展示(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}?[^。]{0,30}(?:交给|赠予)`);
	// 兼容：“展示并将所有……手牌交给……”（常见于“按花色全交”规则）。
	const reShowGiveAll = /展示[^。]{0,40}将所有[^。]{0,60}(?:手牌|牌)[^。]{0,20}(?:交给|赠予)/;

	return {
		id: "give_cards",
		description: "识别技能说明中“交给/赠予其他角色牌”的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("交给") && !text.includes("赠予")) return null;
			if (!(reGive.test(text) || reGiveBefore.test(text) || reGiveAll.test(text) || reGiveEqual.test(text) || reShowGive.test(text) || reShowGiveAll.test(text))) {
				return null;
			}
			return { [TAG_GIVE_CARDS]: true };
		},
	};
}
