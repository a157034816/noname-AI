/**
 * “无懈：可响应【无懈可击】”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_DEFEND_OUT_OF_TURN, TAG_FREE_WUXIE, TAG_RESPOND_WUXIE } from "../../tags.js";

export function createRespondWuxieProcessor() {
	const reNeed = /(?:当你|你)需要使用(?:一张)?【无懈可击】时/;
	const reNeedMix = /(?:当你|你)需要使用(?:一张)?【闪】或【无懈可击】时/;
	// 兼容“当/当作/当做【无懈可击】（含修饰语）”。
	const reAs = /将[^。]{0,20}当(?:[作做])?[^。【】]{0,20}【无懈可击】使用/;
	// 兼容“手牌可当……【无懈可击】使用”这类不显式写“将”的表述。
	const reBareAs = /当(?:[作做])?[^。【】]{0,20}【无懈可击】使用/;
	// 兼容“当作【闪】/【无懈可击】使用或打出”等“多牌名列表+统一使用/打出”的写法（对无懈只需识别到可用）。
	const reListAs = /当(?:[作做])?[^。]{0,40}【无懈可击】(?:\s*(?:\/|或|、|和)\s*【[^】]+】){0,3}\s*使用/;
	const reViewAs = /视为使用(?:一张)?【无懈可击】/;
	const reUse = /你(?:可以|可)[^。]{0,20}使用(?:一张)?【无懈可击】/;

	const reFreeGate = /视为使用(?:一张)?【无懈可击】/;
	const reHasCost = /(将[^。]{0,12}当(?:[作做])?[^。【】]{0,20}【无懈可击】|弃置[^。]{0,12}(?:手牌|牌)|交给[^。]{0,20}【无懈可击】|展示[^。]{0,12}(?:手牌|牌))/;

	return {
		id: "respond_wuxie",
		description: "识别技能说明中“可使用/视为使用【无懈可击】（无懈能力）”的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("无懈可击")) return null;

			if (!(reNeed.test(text) || reNeedMix.test(text) || reAs.test(text) || reBareAs.test(text) || reListAs.test(text) || reViewAs.test(text) || reUse.test(text))) return null;

			/** @type {Record<string, boolean>} */
			const out = { [TAG_RESPOND_WUXIE]: true, [TAG_DEFEND_OUT_OF_TURN]: true };
			if (reFreeGate.test(text) && !reHasCost.test(text)) out[TAG_FREE_WUXIE] = true;
			return out;
		},
	};
}
