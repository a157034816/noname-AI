/**
 * “横置/连环控制”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_CONTROL_LINK } from "../../tags.js";

export function createLinkControlProcessor() {
	const re = /(横置|连环)/;

	return {
		id: "control_link",
		description: "识别技能说明中“横置/连环”的控制效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("横置") && !text.includes("连环")) return null;
			if (!re.test(text)) return null;
			return { [TAG_CONTROL_LINK]: true };
		},
	};
}

