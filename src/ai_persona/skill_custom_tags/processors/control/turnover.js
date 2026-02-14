/**
 * “翻面控制”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_CONTROL_TURNOVER } from "../../tags.js";

export function createTurnoverControlProcessor() {
	const re = /翻面/;

	return {
		id: "control_turnover",
		description: "识别技能说明中“翻面”的控制效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("翻面")) return null;
			if (!re.test(text)) return null;
			return { [TAG_CONTROL_TURNOVER]: true };
		},
	};
}

