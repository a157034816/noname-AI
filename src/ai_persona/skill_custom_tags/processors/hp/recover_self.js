/**
 * “回复自己体力”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_RECOVER_SELF } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createRecoverSelfProcessor() {
	const reYouRecover = new RegExp(String.raw`你[^。]{0,10}回复${NUM}点体力`);
	const reYouCanRecover = new RegExp(String.raw`你(?:可以|可)(?![^。]*令)[^。]*回复${NUM}点体力`);
	const reHpTo = new RegExp(String.raw`将体力(?:值)?回复至${NUM}点?`);
	const reBare = new RegExp(String.raw`(?:^|[。；：]|[①②③④⑤⑥⑦⑧⑨⑩]|[⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑]|\d+[\.:：])\s*回复${NUM}点体力`);
	// 兼容：“……，回复1点体力”这类省略主语写法（常见于使命/条件分支）。
	const reBareAfterComma = new RegExp(String.raw`[，,]\s*回复${NUM}点体力`);
	const reYouToMax = /你[^。]{0,10}(?:回复体力至上限|回复至上限|回复体力至体力上限)/;
	const reHpToMax = /将体力(?:值)?回复至上限/;
	const reBareToMax = new RegExp(
		String.raw`(?:^|[。；：]|[①②③④⑤⑥⑦⑧⑨⑩]|[⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑]|\d+[\.:：])\s*(?:回复体力至上限|回复至上限|回复体力至体力上限)`
	);
	const reBareToMaxAfterComma = /[，,]\s*(?:回复体力至上限|回复至上限|回复体力至体力上限)/;
	// 常见省略主语写法：“出牌阶段结束时回复1点体力”。
	const rePhaseRecover = new RegExp(String.raw`(?:出牌阶段结束时|结束阶段|准备阶段|回合开始时|回合结束时|弃牌阶段开始时)[^。]{0,10}回复${NUM}点体力`);

	return {
		id: "recover_self",
		description: "识别技能说明中“你回复体力/将体力值回复至…”的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("回复")) return null;
			if (
				!(
					reYouRecover.test(text) ||
					reYouCanRecover.test(text) ||
					reHpTo.test(text) ||
					reBare.test(text) ||
					reBareAfterComma.test(text) ||
					reYouToMax.test(text) ||
					reHpToMax.test(text) ||
					reBareToMax.test(text) ||
					reBareToMaxAfterComma.test(text) ||
					rePhaseRecover.test(text)
				)
			) {
				return null;
			}
			return { [TAG_RECOVER_SELF]: true };
		},
	};
}
