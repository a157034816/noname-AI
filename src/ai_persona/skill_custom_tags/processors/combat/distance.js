/**
 * “距离/攻击范围”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_ATTACK_RANGE_PLUS, TAG_DISTANCE_MINUS, TAG_DISTANCE_PLUS, TAG_IGNORE_DISTANCE } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createDistanceProcessor() {
	const reIgnore = /(无距离限制|无距离(?:和|与|及)?次数限制)/;
	const reDistMinus = new RegExp(`距离\\s*-\\s*${NUM}`);
	const reDistPlus = new RegExp(`距离\\s*\\+\\s*${NUM}`);
	const reRangePlus = new RegExp(`攻击范围\\s*\\+\\s*${NUM}`);

	// “距离始终为1” 这类表述更接近“无距离限制/强缩距”，这里按“无距离限制”处理（保守）。
	const reDistAlways1 = /距离(?:始终|永远)?为1/;

	return {
		id: "distance",
		description: "识别技能说明中的距离修正、无距离限制与攻击范围加成",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("距离") && !text.includes("攻击范围")) return null;

			/** @type {Record<string, boolean>} */
			const out = Object.create(null);

			if (reIgnore.test(text) || reDistAlways1.test(text)) out[TAG_IGNORE_DISTANCE] = true;
			if (reDistMinus.test(text)) out[TAG_DISTANCE_MINUS] = true;
			if (reDistPlus.test(text)) out[TAG_DISTANCE_PLUS] = true;
			if (reRangePlus.test(text)) out[TAG_ATTACK_RANGE_PLUS] = true;

			return Object.keys(out).length ? out : null;
		},
	};
}
