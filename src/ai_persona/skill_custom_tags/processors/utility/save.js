/**
 * “濒死救援”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * 说明：
 * - 仅做保守标注：文本包含“濒死”，且同句/同段出现“桃/回复体力/体力值回复至…”等明显救助信号
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_SAVE } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createSaveProcessor() {
	const reTao = /【桃】/;
	const reUseTao = /(?:视为)?使用(?:一张)?【桃】/;
	const reRecover = new RegExp(String.raw`回复${NUM}点体力|将体力(?:值)?回复至${NUM}点?|回复体力至上限|回复至上限|回复体力至体力上限`);

	return {
		id: "save",
		description: "识别技能说明中与“濒死救助/救人”强相关的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("濒死")) return null;
			if (!(reTao.test(text) || reUseTao.test(text) || reRecover.test(text))) return null;
			return { [TAG_SAVE]: true };
		},
	};
}
