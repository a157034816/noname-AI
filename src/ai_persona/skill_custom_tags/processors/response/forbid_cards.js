/**
 * “禁牌/禁用”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * 说明：
 * - 识别典型句式：“不能/不得 使用/打出（牌/某类牌/【杀】等）”
 * - 不区分作用对象（你/其/目标），仅标注“该技能涉及禁牌语义”
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_FORBID_CARDS, TAG_FORBID_SHA, TAG_FORBID_SHAN, TAG_FORBID_WUXIE } from "../../tags.js";

export function createForbidCardsProcessor() {
	const reAny = /(不能|不得)[^。]{0,25}(?:使用|打出|使用或打出)[^。]{0,10}(?:牌|手牌|基本牌|锦囊牌|装备牌|【[^】]+】)/;
	const reSha = /(不能|不得)[^。]{0,25}(?:使用|打出|使用或打出)[^。]{0,10}【杀】/;
	const reShan = /(不能|不得)[^。]{0,25}(?:使用|打出|使用或打出)[^。]{0,10}【闪】/;
	const reWuxie = /(不能|不得)[^。]{0,25}(?:使用|打出|使用或打出)[^。]{0,10}【无懈可击】/;

	return {
		id: "forbid_cards",
		description: "识别技能说明中“不能/不得 使用/打出（某类牌/具体牌）”的禁牌语义",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("不能") && !text.includes("不得")) return null;
			if (!text.includes("使用") && !text.includes("打出")) return null;

			const any = reAny.test(text) || reSha.test(text) || reShan.test(text) || reWuxie.test(text);
			if (!any) return null;

			/** @type {Record<string, boolean>} */
			const out = { [TAG_FORBID_CARDS]: true };
			if (reSha.test(text)) out[TAG_FORBID_SHA] = true;
			if (reShan.test(text)) out[TAG_FORBID_SHAN] = true;
			if (reWuxie.test(text)) out[TAG_FORBID_WUXIE] = true;
			return out;
		},
	};
}

