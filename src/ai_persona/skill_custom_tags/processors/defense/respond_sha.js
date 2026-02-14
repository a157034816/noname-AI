/**
 * “回合外响应：可响应【杀】”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * 说明：
 * - 本处理器更偏向识别“打出【杀】/使用或打出【杀】/当你需要打出【杀】时”等回合外响应语义
 * - 仅“视为使用【杀】”但不含“打出/使用或打出/需要”时通常更像出牌阶段进攻，不在此处标注
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_DEFEND_OUT_OF_TURN, TAG_FREE_SHA, TAG_RESPOND_SHA } from "../../tags.js";

export function createRespondShaProcessor() {
	const reNeed = /当你需要(?:使用或打出|打出)(?:一张)?【杀】时/;
	// 兼容“当/当作/当做【杀】（含火【杀】/雷【杀】/刺【杀】等前缀与修饰语）”。
	const reAs = /将[^。]{0,20}当(?:[作做])?[^。【】]{0,20}【杀】(?:使用或打出|打出)/;
	// 兼容“这些牌只能当……【杀】使用或打出”这类不显式写“将”的表述。
	const reBareAs = /当(?:[作做])?[^。【】]{0,20}【杀】(?:使用或打出|打出)/;
	// 兼容“当作【杀】或【闪】使用或打出 / 当作【闪】/【杀】使用或打出”这类“多牌名列表+统一使用或打出”的写法。
	const reListAs = /当(?:[作做])?[^。]{0,40}【杀】(?:\s*(?:\/|或|、|和)\s*【[^】]+】){0,3}\s*(?:使用或打出|打出)/;
	const reViewAsPlay = /视为打出(?:一张)?【杀】/;
	const reUseOrPlay = /使用或打出(?:一张)?【杀】/;
	const rePlay = /你(?:可以|可)[^。]{0,20}打出(?:一张)?【杀】/;

	const reFreeGate = /视为打出(?:一张)?【杀】/;
	const reHasCost = /(将[^。]{0,12}当(?:[作做])?[^。【】]{0,20}【杀】|弃置[^。]{0,12}(?:手牌|牌)|交给[^。]{0,20}【杀】|展示[^。]{0,12}(?:手牌|牌))/;

	return {
		id: "respond_sha",
		description: "识别技能说明中“可打出/视为打出【杀】（回合外响应）”的能力",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("【杀】")) return null;

			const ok =
				reNeed.test(text) ||
				reAs.test(text) ||
				reBareAs.test(text) ||
				reListAs.test(text) ||
				reViewAsPlay.test(text) ||
				reUseOrPlay.test(text) ||
				rePlay.test(text);
			if (!ok) return null;

			/** @type {Record<string, boolean>} */
			const out = { [TAG_RESPOND_SHA]: true, [TAG_DEFEND_OUT_OF_TURN]: true };
			if (reFreeGate.test(text) && !reHasCost.test(text)) out[TAG_FREE_SHA] = true;
			return out;
		},
	};
}
