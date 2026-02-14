/**
 * “回合外防御：可响应【闪】”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_DEFEND_OUT_OF_TURN, TAG_FREE_SHAN, TAG_RESPOND_SHAN } from "../../tags.js";

export function createRespondShanProcessor() {
	const reNeed = /(?:当你|你)需要(?:使用或打出|使用|打出)(?:一张)?【闪】(?:或【无懈可击】)?时/;
	// 兼容“当/当作/当做【闪】（含修饰语）”。
	const reAs = /将[^。]{0,20}当(?:[作做])?[^。【】]{0,20}【闪】(?:使用或打出|使用|打出)/;
	// 兼容“手牌可当……【闪】使用或打出”这类不显式写“将”的表述。
	const reBareAs = /当(?:[作做])?[^。【】]{0,20}【闪】(?:使用或打出|使用|打出)/;
	// 兼容“当作【杀】或【闪】使用或打出 / 当作【杀】/【闪】使用或打出”等“多牌名列表+统一使用或打出”的写法。
	const reListAs = /当(?:[作做])?[^。]{0,40}【闪】(?:\s*(?:\/|或|、|和)\s*【[^】]+】){0,3}\s*(?:使用或打出|使用|打出)/;
	const reViewAs = /视为(?:使用或打出|使用|打出)(?:一张)?【闪】/;
	const rePlay = /你(?:可以|可)[^。]{0,20}打出(?:一张)?【闪】/;

	// “免费闪”保守识别：出现“视为使用/打出【闪】”，且未出现典型换牌/弃牌/当作成本语义。
	const reFreeGate = /视为(?:使用|打出)(?:一张)?【闪】/;
	const reHasCost = /(将[^。]{0,12}当(?:[作做])?[^。【】]{0,20}【闪】|弃置[^。]{0,12}(?:手牌|牌)|交给[^。]{0,20}【闪】|展示[^。]{0,12}(?:手牌|牌))/;

	return {
		id: "respond_shan",
		description: "识别技能说明中“可打出/视为打出【闪】（回合外防御）”的能力",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("【闪】")) return null;
			if (!(reNeed.test(text) || reAs.test(text) || reBareAs.test(text) || reListAs.test(text) || reViewAs.test(text) || rePlay.test(text))) return null;

			/** @type {Record<string, boolean>} */
			const out = { [TAG_RESPOND_SHAN]: true, [TAG_DEFEND_OUT_OF_TURN]: true };
			if (reFreeGate.test(text) && !reHasCost.test(text)) out[TAG_FREE_SHAN] = true;
			return out;
		},
	};
}
