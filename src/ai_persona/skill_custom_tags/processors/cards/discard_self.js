/**
 * “弃置自己牌”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * 注意：
 * - 这里不区分“弃牌是代价还是效果”，仅标注“技能涉及自己弃牌”
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_DISCARD_SELF } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createDiscardSelfProcessor() {
	const CARD_TAIL = String.raw`[^。]{0,10}(?:手牌|牌)`;
	const reYou = new RegExp(String.raw`你弃置(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	// “你可以/可……弃置……”：需要排除“你可以令X弃置……”的场景（避免把他弃误标成自弃）。
	const reYouCan = new RegExp(String.raw`你(?:可以|可)([^。]{0,80}?)弃置(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`, "g");
	// 兼容：“你可以弃置任意数量的手牌”这类非“任意张”写法。
	const reYouCanAnyCount = new RegExp(String.raw`你(?:可以|可)([^。]{0,80}?)弃置任意数量的手牌`, "g");
	const reBare = new RegExp(
		String.raw`(?:^|[。；：]|[①②③④⑤⑥⑦⑧⑨⑩]|[⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑]|\d+[\.:：])\s*弃置(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`,
		"g"
	);
	const reOtherChooseOptionPrefix = /令[^。]{0,20}选择一项[：:]\s*$/;
	// 兼容：“……然后弃置X张牌/并弃置X张牌”。
	const reThen = new RegExp(String.raw`(?:然后|并|再|接着)\s*弃置(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	const reAll = /你弃置(?:所有|全部)(?:手牌|牌)/;
	const reAllByFilter = new RegExp(String.raw`你(?:可|可以)?弃置([^。]{0,20})的所有(?:手牌|牌)`, "g");
	const reDiscardGainedHandcards = /你弃置[^。]{0,30}获得的手牌/;
	const reEach = new RegExp(String.raw`你弃置[^。]{0,30}各${NUM}张${CARD_TAIL}`);
	const reIncludeYouEach = new RegExp(String.raw`弃置你、[^。]{0,50}各${NUM}张${CARD_TAIL}`);
	// “将…置入弃牌堆”类表述（通常等价于弃置，但不触发“弃置”关键词）。
	const rePutToDiscardPile = new RegExp(String.raw`你(?:可以|可)(?![^。]*令)[^。]{0,40}置入弃牌堆`);
	// “弃置至X张/弃置至X”类表述（常见于“调整手牌至某个数量”）。
	const reDiscardToHandCountSelf = new RegExp(
		String.raw`你(?:(?!令|使)[^。]){0,10}将(?:手牌数|手牌)[^。]{0,10}弃置至${NUM}(?:张(?:牌)?)?`
	);
	// “保留…将其余手牌置入弃牌堆”类表述（通常等价于弃置多张手牌）。
	const rePutRestHandcardsToDiscardPile = new RegExp(
		String.raw`你(?:(?!令|使)[^。]){0,40}将其余[^。]{0,20}(?:手牌|牌)置入弃牌堆`
	);
	// 兼容“弃置装备区里的一张牌/弃置装备牌”等区域弃置写法。
	const reDiscardEquipAreaSelf = new RegExp(String.raw`你[^。]{0,30}弃置([^。]{0,20})装备区[^。]{0,20}一张${CARD_TAIL}`, "g");
	// 兼容“弃置所有【闪】/弃置所有【杀】”等以牌名集合为对象的弃置写法（常见于选项列表省略主语场景）。
	const reDiscardAllNamedCardsBare = new RegExp(
		String.raw`(?:^|[。；：]|[，,]|[①②③④⑤⑥⑦⑧⑨⑩]|[⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑]|\d+[\.:：])\s*弃置(?:所有|全部)【[^】]+】`
	);
	const reDiscardAllNamedCardsYou = new RegExp(String.raw`你[^。]{0,40}弃置(?:所有|全部)【[^】]+】`);

	const reOtherRoleHint =
		/其他角色|一名[^。]{0,10}角色|任意[^。]{0,10}角色|目标角色|目标|当前回合角色|使用者|伤害来源|来源|对方|该角色|^其(?!中|余)/;

	/**
	 * @param {string} segment
	 * @returns {boolean}
	 */
	function containsOtherRoleHint(segment) {
		const s = String(segment || "").trim();
		if (!s) return false;
		return reOtherRoleHint.test(s);
	}

	/**
	 * 判断“你弃置X的所有手牌/牌”里，X 是否指向他人区域（避免把弃他误标成自弃）。
	 *
	 * @param {string} text
	 * @returns {boolean}
	 */
	function matchesDiscardAllByFilterSelf(text) {
		if (!text) return false;
		reAllByFilter.lastIndex = 0;
		for (let m = reAllByFilter.exec(text); m; m = reAllByFilter.exec(text)) {
			const filter = String(m[1] || "");
			if (!containsOtherRoleHint(filter)) return true;
		}
		return false;
	}

	/**
	 * 判断“你弃置…装备区…一张牌”里，“装备区”前的修饰是否指向他人（避免把弃他装备误标成自弃）。
	 *
	 * @param {string} text
	 * @returns {boolean}
	 */
	function matchesDiscardEquipAreaSelf(text) {
		if (!text) return false;
		reDiscardEquipAreaSelf.lastIndex = 0;
		for (let m = reDiscardEquipAreaSelf.exec(text); m; m = reDiscardEquipAreaSelf.exec(text)) {
			const beforeEquipArea = String(m[1] || "");
			if (!containsOtherRoleHint(beforeEquipArea)) return true;
		}
		return false;
	}

	/**
	 * 判断文本中是否存在“你可以/可……弃置……”且“弃置”前未出现“令”。
	 *
	 * @param {string} text
	 * @returns {boolean}
	 */
	function matchesYouCanDiscard(text) {
		if (!text) return false;
		reYouCan.lastIndex = 0;
		for (let m = reYouCan.exec(text); m; m = reYouCan.exec(text)) {
			const between = String(m[1] || "");
			if (!between.includes("令")) return true;
		}
		reYouCanAnyCount.lastIndex = 0;
		for (let m = reYouCanAnyCount.exec(text); m; m = reYouCanAnyCount.exec(text)) {
			const between = String(m[1] || "");
			if (!between.includes("令")) return true;
		}
		return false;
	}

	/**
	 * 判断文本中是否存在“省略主语的弃置X张牌”且不处于“令他人选择一项：①弃置…”语境。
	 *
	 * @param {string} text
	 * @returns {boolean}
	 */
	function matchesBareDiscardSelf(text) {
		if (!text) return false;
		reBare.lastIndex = 0;
		for (let m = reBare.exec(text); m; m = reBare.exec(text)) {
			const idx = typeof m.index === "number" ? m.index : -1;
			if (idx >= 0) {
				const prefix = text.slice(Math.max(0, idx - 60), idx);
				if (reOtherChooseOptionPrefix.test(prefix)) continue;
			}
			return true;
		}
		return false;
	}

	return {
		id: "discard_self",
		description: "识别技能说明中“自己弃置牌”的代价/效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("弃置") && !text.includes("置入弃牌堆")) return null;
			if (
				!(
					reYou.test(text) ||
					matchesYouCanDiscard(text) ||
					matchesBareDiscardSelf(text) ||
					reThen.test(text) ||
					reAll.test(text) ||
					matchesDiscardAllByFilterSelf(text) ||
					reDiscardGainedHandcards.test(text) ||
					reEach.test(text) ||
					reIncludeYouEach.test(text) ||
					rePutToDiscardPile.test(text) ||
					reDiscardToHandCountSelf.test(text) ||
					rePutRestHandcardsToDiscardPile.test(text) ||
					matchesDiscardEquipAreaSelf(text) ||
					reDiscardAllNamedCardsBare.test(text) ||
					reDiscardAllNamedCardsYou.test(text)
				)
			) {
				return null;
			}
			return { [TAG_DISCARD_SELF]: true };
		},
	};
}
