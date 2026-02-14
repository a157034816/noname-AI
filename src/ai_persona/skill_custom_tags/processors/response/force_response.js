/**
 * “强制响应”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * 说明：
 * - 仅识别典型句式：“其需/须/必须/需要 打出/使用【闪/杀】 否则……”
 * - 不识别“其可以打出……”（非强制）
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_FORCE_RESPONSE_SHA, TAG_FORCE_RESPONSE_SHAN } from "../../tags.js";

export function createForceResponseProcessor() {
	const reShan = /(?:需|须|必须|需要)[^。]{0,40}(?:打出|使用)[^。]{0,40}【闪】[^。]{0,60}(?:否则|若其未|若其不|若未)/;
	const reSha = /(?:需|须|必须|需要)[^。]{0,40}(?:打出|使用)[^。]{0,40}【杀】[^。]{0,60}(?:否则|若其未|若其不|若未)/;

	return {
		id: "force_response",
		description: "识别技能说明中“强制他人打出/使用指定牌（闪/杀）否则受罚”的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("需") && !text.includes("须") && !text.includes("必须") && !text.includes("需要")) return null;
			if (!text.includes("否则") && !text.includes("若其") && !text.includes("若未")) return null;

			/** @type {Record<string, boolean>} */
			const out = Object.create(null);
			if (text.includes("【闪】") && reShan.test(text)) out[TAG_FORCE_RESPONSE_SHAN] = true;
			if (text.includes("【杀】") && reSha.test(text)) out[TAG_FORCE_RESPONSE_SHA] = true;
			return Object.keys(out).length ? out : null;
		},
	};
}
