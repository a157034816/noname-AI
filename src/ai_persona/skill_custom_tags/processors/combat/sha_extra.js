/**
 * “距离与额外出杀：出杀次数”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_SHA_EXTRA, TAG_SHA_UNLIMITED } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createShaExtraProcessor() {
	// “使用【杀】的次数永久+1” 这类表述在部分武将包中较常见，这里兼容 “永久” 插入。
	const reExtra1 = new RegExp(`使用【杀】的次数(?:永久)?\\+${NUM}`);
	const reExtra2 = new RegExp(`本回合[^。]*使用【杀】的次数(?:永久)?\\+${NUM}`);
	const reExtra4 = new RegExp(`使用【杀】次数(?:永久)?\\+${NUM}`);
	const reExtra3 = new RegExp(`额外使用(?:${NUM}|一)张【杀】`);
	const reUnlimited1 = /使用【杀】无次数限制/;
	const reUnlimited2 = /使用【杀】不受次数限制/;
	const reUnlimited3 = /使用【杀】不计入次数/;
	const reUnlimited4 = /无次数限制(?:的)?【杀】/;
	const reUnlimited5 = /不受次数限制(?:的)?【杀】/;
	const reUnlimited6 = /不计入次数(?:限制)?(?:的)?【杀】/;
	// 兼容：“不计入次数且……【杀】/无距离和次数限制的……【杀】”等更口语化写法
	const reUnlimited7 = /不计入次数[^。]{0,30}【杀】/;
	const reUnlimited8 = /无距离(?:和|与|及)?次数限制[^。]{0,30}【杀】/;
	const reUnlimited9 = /无距离(?:和|与|及)?次数限制/;

	return {
		id: "sha_extra",
		description: "识别技能说明中“使用【杀】次数+X/额外使用【杀】/无次数限制”等效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("【杀】")) return null;
			if (!text.includes("次数") && !text.includes("额外") && !text.includes("无限制") && !text.includes("不计入")) return null;

			/** @type {Record<string, boolean>} */
			const out = Object.create(null);

			if (reExtra1.test(text) || reExtra2.test(text) || reExtra3.test(text) || reExtra4.test(text)) out[TAG_SHA_EXTRA] = true;
			if (
				reUnlimited1.test(text) ||
				reUnlimited2.test(text) ||
				reUnlimited3.test(text) ||
				reUnlimited4.test(text) ||
				reUnlimited5.test(text) ||
				reUnlimited6.test(text) ||
				reUnlimited7.test(text) ||
				reUnlimited8.test(text) ||
				reUnlimited9.test(text)
			) {
				out[TAG_SHA_UNLIMITED] = true;
			}

			return Object.keys(out).length ? out : null;
		},
	};
}
