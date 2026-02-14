/**
 * “造成伤害”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * 说明：
 * - 仅尝试识别“对其/对目标/对一名角色造成X点伤害”等直接伤害描述
 * - 不覆盖“你造成的伤害+1”这类泛化表述
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_DAMAGE_OTHER } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createDamageOtherProcessor() {
	const reCause = new RegExp(
		String.raw`对(?:其|伤害来源|来源|目标角色?|目标|该角色|一名[^。]{0,15}角色|一名其他角色|其他角色|任意角色|所有其他角色|所有角色|[^。]{0,20}角色)[^。]{0,25}造成(?:${NUM}点|等量)[^。]{0,15}伤害`
	);
	// 兼容：“令其受到1点伤害/其受到3点无来源雷属性伤害”。
	const reLingSuffer = new RegExp(String.raw`令[^。]{0,30}受到${NUM}点[^。]{0,15}伤害`);
	const reQiSuffer = new RegExp(
		String.raw`(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色|一名[^。]{0,15}角色|一名其他角色|所有其他角色|所有角色)[^。]{0,20}受到${NUM}点[^。]{0,15}伤害`
	);

	return {
		id: "damage_other",
		description: "识别技能说明中“对他人造成X点伤害”的直接伤害效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("伤害")) return null;
			if (!(reCause.test(text) || reLingSuffer.test(text) || reQiSuffer.test(text))) return null;
			return { [TAG_DAMAGE_OTHER]: true };
		},
	};
}
