/**
 * “主动卖血”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_ACTIVE_MAIXIE, TAG_MAIXIE } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createActiveMaixieProcessor() {
	// 主动卖血（示例规则）：
	// - 出牌阶段
	// - 你可以
	// - 你失去X点体力 / 你受到X点伤害（允许跨句：如“……获得。然后……你受到X点伤害”）
	//
	// 说明：这是“保守起步版”的规则；后续可按需要加入更多触发时机/关键词与例外处理。
	const re = new RegExp(
		String.raw`出牌阶段[\s\S]{0,160}?你(?:可以|可)[\s\S]{0,260}?你(?:失去${NUM}点体力|受到${NUM}点伤害)`
	);

	return {
		id: "active_maixie",
		description: "识别出牌阶段主动失去体力/受伤的技能（主动卖血）",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("出牌阶段")) return null;
			if (!text.includes("失去") && !text.includes("受到")) return null;
			if (!re.test(text)) return null;
			return { [TAG_ACTIVE_MAIXIE]: true, [TAG_MAIXIE]: true };
		},
	};
}
