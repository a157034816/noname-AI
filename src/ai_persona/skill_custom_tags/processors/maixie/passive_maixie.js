/**
 * “被动卖血”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * 识别目标（保守版）：
 * - 触发：当/每当 你 受到伤害 / 失去体力 后（或时）
 * - 结果：同句内出现“摸牌/获得/回复/反制伤害/令他人弃牌/获得护甲”等收益信号
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_MAIXIE, TAG_PASSIVE_MAIXIE } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createPassiveMaixieProcessor() {
	const re = new RegExp(
		String.raw`(?:当|每当)?你(?:受到(?:${NUM}点)?伤害|失去(?:${NUM}点)?体力)(?:后|时)[^。]*(?:你(?:可以|可)|你摸|你获得|你回复|你对[^。]{0,20}造成${NUM}点(?:火焰|雷电)?伤害|令[^。]{0,20}(?:弃置|摸)|获得(?:${NUM}点)?护甲)`
	);

	return {
		id: "passive_maixie",
		description: "识别受到伤害/失去体力后触发收益的技能（被动卖血）",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("伤害") && !text.includes("体力")) return null;
			if (!text.includes("受到") && !text.includes("失去")) return null;
			if (!re.test(text)) return null;
			return { [TAG_PASSIVE_MAIXIE]: true, [TAG_MAIXIE]: true };
		},
	};
}
