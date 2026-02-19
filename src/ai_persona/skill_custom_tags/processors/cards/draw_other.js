/**
 * “令他人摸牌/补牌”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_DRAW_OTHER } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createDrawOtherProcessor() {
	// “令X摸牌”类写法：需要排除“令你摸牌”（这是自己摸牌，不应算作“令他人摸牌”）。
	const reLingDraw = new RegExp(String.raw`令([^。]{0,30})摸${NUM}张牌`, "g");
	const reLingDrawEach = new RegExp(String.raw`令([^。]{0,30})各摸${NUM}张牌`, "g");
	const reLingTargetHint = /其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色|所有角色|全体角色|角色|一名|至多|至少|任意/;
	const reQi = new RegExp(String.raw`(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色)摸${NUM}张牌`);
	const reAllEach = new RegExp(String.raw`(?:所有角色|全体角色)各摸${NUM}张牌`);
	const reMutual = new RegExp(String.raw`你(?:与|和)[^。]{0,20}各摸${NUM}张牌`);
	// 互摸写法里省略“你”的情况：常见于“你可选择一项：1.与当前回合角色各摸一张牌；…”。
	const reMutualBare = new RegExp(
		String.raw`(?:^|[。；：]|[，,]|[①②③④⑤⑥⑦⑧⑨⑩]|[⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑]|\d+[\.:：])\s*(?:然后|并|再|接着)?\s*(?:与|和)[^。]{0,20}各摸${NUM}张牌`
	);
	// “交换后手牌较少/最少的角色摸X张牌” 等特例（常见于缔盟类描述）。
	const reLessHandDraw = new RegExp(String.raw`(?:交换后)?手牌(?:数)?(?:最少|较少|更少)的角色摸${NUM}张牌`);
	// “点数唯一最大的角色摸体力值张牌” 等规则：按“令他人摸牌”处理。
	const reRoleDrawHpCount = /(?:角色|其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色)[^。]{0,20}摸(?:其)?体力值张牌/;

	const HAND_COUNT_TARGET = String.raw`(?:${NUM}|手牌上限|体力上限|角色数|上限)`;
	const HAND_COUNT_SUFFIX = String.raw`(?:张(?:牌)?)?`;

	// 补牌到指定手牌数：仅当明确涉及“他人/互补”时才标注（避免误标“你将手牌摸至三张”一类自补）。
	const reToHandCountMutual = new RegExp(
		String.raw`你(?:与|和)[^。]{0,20}将(?:手牌数|手牌)[^。]{0,10}摸至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);
	// 注意：排除“使用”中的“使”，避免把“使用…，你将手牌摸至…”误识别为“使…摸至”。
	const reToHandCountOther = new RegExp(
		String.raw`(?:令(?!你)|使(?!你|用))[^。]{0,30}(?:将)?(?:手牌数|手牌)[^。]{0,10}摸至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);
	const reToHandCountQi = new RegExp(
		String.raw`(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色|所有角色|全体角色)[^。]{0,10}(?:将)?(?:手牌数|手牌)[^。]{0,10}摸至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);

	// “补至指定手牌数”类写法（常见于“濒死补牌/补至上限”）。
	const reFillToHandCountOther = new RegExp(
		String.raw`(?:令(?!你)|使(?!你|用))[^。]{0,30}(?:将)?手牌[^。]{0,10}补至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);
	const reFillToHandCountQi = new RegExp(
		String.raw`(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色|所有角色|全体角色)[^。]{0,10}(?:将)?手牌[^。]{0,10}补至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);

	// 二选一写法：“令该角色摸/弃置一张牌”。
	const reLingDrawOrDiscard = new RegExp(String.raw`令([^。]{0,30})摸\s*\/\s*弃置${NUM}张[^。]{0,10}(?:手牌|牌)`, "g");

	/**
	 * 判断“令X摸牌/各摸牌/摸弃二选一”是否确实作用于“他人”而非“你”。
	 *
	 * @param {string} text
	 * @returns {boolean}
	 */
	function matchesLingOtherDraw(text) {
		if (!text) return false;

		reLingDraw.lastIndex = 0;
		for (let m = reLingDraw.exec(text); m; m = reLingDraw.exec(text)) {
			const between = String(m[1] || "").trim();
			if (!between) continue;
			if (between.endsWith("令你")) continue;
			if (!reLingTargetHint.test(between)) continue;
			return true;
		}

		reLingDrawEach.lastIndex = 0;
		for (let m = reLingDrawEach.exec(text); m; m = reLingDrawEach.exec(text)) {
			const between = String(m[1] || "").trim();
			if (!between) continue;
			if (between.endsWith("令你")) continue;
			if (!reLingTargetHint.test(between)) continue;
			return true;
		}

		reLingDrawOrDiscard.lastIndex = 0;
		for (let m = reLingDrawOrDiscard.exec(text); m; m = reLingDrawOrDiscard.exec(text)) {
			const between = String(m[1] || "").trim();
			if (!between) continue;
			if (between.endsWith("令你")) continue;
			if (!reLingTargetHint.test(between)) continue;
			return true;
		}

		return false;
	}

	return {
		id: "draw_other",
		description: "识别技能说明中“令其他角色摸牌/补牌”的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("摸") && !text.includes("补")) return null;
			if (
				!(
					matchesLingOtherDraw(text) ||
					reQi.test(text) ||
					reAllEach.test(text) ||
					reMutual.test(text) ||
					reMutualBare.test(text) ||
					reLessHandDraw.test(text) ||
					reRoleDrawHpCount.test(text) ||
					reToHandCountMutual.test(text) ||
					reToHandCountOther.test(text) ||
					reToHandCountQi.test(text) ||
					reFillToHandCountOther.test(text) ||
					reFillToHandCountQi.test(text)
				)
			) {
				return null;
			}
			return { [TAG_DRAW_OTHER]: true };
		},
	};
}
