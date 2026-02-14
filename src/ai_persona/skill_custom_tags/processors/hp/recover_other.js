/**
 * “回复他人体力”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_RECOVER_OTHER } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createRecoverOtherProcessor() {
	const reLingRecover = new RegExp(String.raw`令[^。]{0,30}回复${NUM}点体力`);
	const reLingHpTo = new RegExp(String.raw`令[^。]{0,30}将体力(?:值)?回复至${NUM}点?`);
	const reLingToMax = /令[^。]{0,30}(?:回复体力至上限|回复至上限|回复体力至体力上限)/;
	const reQiRecover = new RegExp(String.raw`(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色)[^。]{0,10}回复${NUM}点体力`);
	const reQiHpTo = new RegExp(String.raw`(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色)[^。]{0,10}将体力(?:值)?回复至${NUM}点?`);
	const reQiToMax = /(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色)[^。]{0,10}(?:回复体力至上限|回复至上限|回复体力至体力上限)/;

	return {
		id: "recover_other",
		description: "识别技能说明中“令其他角色回复体力”的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("回复")) return null;
			if (!(reLingRecover.test(text) || reLingHpTo.test(text) || reLingToMax.test(text) || reQiRecover.test(text) || reQiHpTo.test(text) || reQiToMax.test(text))) {
				return null;
			}
			return { [TAG_RECOVER_OTHER]: true };
		},
	};
}
