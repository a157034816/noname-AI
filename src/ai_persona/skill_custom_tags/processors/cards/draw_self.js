/**
 * “自己摸牌/补牌”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_DRAW_SELF } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createDrawSelfProcessor() {
	const reYouDraw = new RegExp(String.raw`你摸${NUM}张牌`);
	const reMutualDraw = new RegExp(String.raw`你(?:与|和)[^。]{0,20}各摸${NUM}张牌`);
	// “所有角色/全体角色各摸X张牌”中包含你自己，也应视为“自己摸牌”收益。
	const reAllEachDraw = new RegExp(String.raw`(?:所有角色|全体角色)各摸${NUM}张牌`);
	const reAllDraw = new RegExp(String.raw`(?:所有角色|全体角色)摸${NUM}张牌`);
	// 处理“你可以……摸X张牌”；注意：只排除“摸”前出现“令”的场景（避免把“你可以令X摸牌”误识别为“你自摸”）。
	const reYouCanDraw = new RegExp(String.raw`你(?:可以|可)([^。]{0,80}?)摸${NUM}张牌`, "g");
	// 兼容“当你……时，可以/可……摸X张牌”（省略主语“你”）。
	const reWhenYouCanDraw = new RegExp(String.raw`当你[^。]{0,80}?(?:时|后|前|开始时|结束时)[^。]{0,10}(?:可以|可)([^。]{0,80}?)摸${NUM}张牌`, "g");
	// 兼容“……然后/并/再/接着 摸X张牌”（省略主语）。
	const reThenDraw = new RegExp(String.raw`(?:然后|并|再|接着)\s*摸${NUM}张牌`);
	// 兼容“回复1点体力或摸一张牌”这类二选一写法。
	const reOrDraw = new RegExp(String.raw`(?:或|或者)\s*摸${NUM}张牌`);
	// 常见选项写法：“……可以选择一项：1.回复1点体力；2.摸一张牌。”（省略主语）
	const reBare = new RegExp(String.raw`(?:^|[。；：]|[①②③④⑤⑥⑦⑧⑨⑩]|[⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑]|\d+[\.:：])\s*摸${NUM}张牌`);
	// 兼容“……，摸一张牌/（…改为摸一张牌）”等省略主语的写法（常见于使命技/条件分支）。
	const reBareAfterComma = new RegExp(String.raw`[，,]\s*摸${NUM}张牌`);
	const reRewriteToDraw = new RegExp(String.raw`改为摸${NUM}张牌`);
	// 兼容选项里省略“你”的互摸写法：“你可选择一项：1.与当前回合角色各摸一张牌；…”。
	const reOptionMutualDraw = new RegExp(
		String.raw`你[^。]{0,40}选择一项[^。]{0,20}[：:]\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|\d+[\.:：])\s*(?:与|和)[^。]{0,20}各摸${NUM}张牌`
	);
	// 兼容“……然后与XXX各摸X张牌”（“你与”被省略，但同句前部通常已出现“你”）。
	const reThenMutualDrawWithYouContext = new RegExp(String.raw`你[^。]{0,120}(?:然后|并|再|接着)?\s*(?:与|和)[^。]{0,20}各摸${NUM}张牌`);

	const HAND_COUNT_TARGET = String.raw`(?:${NUM}|手牌上限|体力上限|角色数|上限)`;
	const HAND_COUNT_SUFFIX = String.raw`(?:张(?:牌)?)?`;

	// 补牌到指定手牌数：“将手牌数摸至X张/摸至X/摸至手牌上限/摸至角色数…”
	// 注意：通过 (?!令|使) 避免把“你可以令一名角色将手牌摸至…”误识别为“你自摸至…”
	const reToHandCountSelf = new RegExp(
		String.raw`你(?:(?!令|使)[^。]){0,10}将(?:手牌数|手牌)[^。]{0,10}摸至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);
	// 兼容不写“将手牌”的写法：“你展示所有手牌并摸至角色数张”
	const reToCountSelfBare = new RegExp(String.raw`你(?:(?!令|使)[^。]){0,40}摸至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`);
	const reToHandCountMutual = new RegExp(
		String.raw`你(?:与|和)[^。]{0,20}将(?:手牌数|手牌)[^。]{0,10}摸至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);

	// 补至指定手牌数：“将手牌补至四张/补至上限…”
	const reFillToHandCountSelf = new RegExp(
		String.raw`你(?:(?!令|使)[^。]){0,30}(?:将)?手牌[^。]{0,10}补至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);

	// 调整至指定手牌数：“将手牌调整至体力上限/手牌上限/X…”（可能包含摸牌或弃牌，按“补牌”收益侧保守标注）。
	const reAdjustHandCountSelf = new RegExp(
		String.raw`你(?:(?!令|使)[^。]){0,30}(?:将)?(?:手牌数|手牌)[^。]{0,10}调整至${HAND_COUNT_TARGET}${HAND_COUNT_SUFFIX}`
	);

	// 摸牌阶段增益：摸牌数+X / 额定摸牌数+X（常见于装备/锁定技规则）。
	const reDrawCountPlus = new RegExp(String.raw`(?:额定)?摸牌数\s*\+\s*${NUM}`);
	// 额外/多摸：摸牌阶段你额外摸X张牌 / 你多摸X张牌
	const reExtraDraw = new RegExp(String.raw`你[^。]{0,20}(?:额外|多)摸${NUM}张牌`);
	// 摸等量：弃置任意张牌并摸等量的牌
	const reDrawEqual = /摸等量(?:张)?的?牌/;
	// 体力值张牌：摸其体力值张牌/摸体力值张牌
	const reDrawHpCount = /摸(?:其)?体力值(?:数)?张牌/;
	// 已损失体力值张牌：摸你已损失体力值张牌（常见于“卖血换牌/弃牌后摸”规则）。
	const reDrawLostHpCount = /摸(?:你)?已损失(?:的)?体力值(?:数)?张牌/;
	// 额外摸牌阶段：执行/进行一个额外的摸牌阶段。
	const reExtraDrawPhase = /(?:执行|进行)(?:一个)?额外的?摸牌阶段/;
	// 特例：dcweiji 等规则——“你摸你选择数字张牌”。
	const reDrawPickNumber = /你摸你选择[^。]{0,10}张牌/;
	// 翻倍：下次摸牌翻倍/令自己本回合下次摸牌翻倍
	const reDrawDouble = /摸牌翻倍/;

	// 获得牌（不使用“摸”字）：从牌堆/弃牌堆/展示牌中取牌等，按“补牌收益”保守标注。
	// 注意：排除“你……令/使……从牌堆获得……”这类“他人获得牌”（应由 draw_other 处理）。
	const reGainFromPileOrDiscard = new RegExp(
		String.raw`你(?:(?!令|使(?!用))[^。]){0,40}从(?:牌堆|弃牌堆)[^。]{0,10}获得[^。]{0,20}(?:张|【)`
	);
	const reThenGainFromPileOrDiscard = new RegExp(
		String.raw`(?:然后|并|再|接着)(?:(?!令|使(?!用))[^。]){0,10}从(?:牌堆|弃牌堆)[^。]{0,10}获得[^。]{0,20}(?:张|【)`
	);
	const reGainDiscardPileEntered = new RegExp(String.raw`你[^。]{0,80}弃牌堆[^。]{0,60}(?:${NUM}|任意)张牌[^。]{0,20}获得`);
	const reRevealPileTopAndGain = new RegExp(
		String.raw`你[^。]{0,60}(?:观看|亮出|展示)牌堆顶[^。]{0,10}${NUM}张牌[^。]{0,160}获得(?:其中(?:${NUM}|一)张|所有[^。]{0,10}牌|之)`
	);
	const reGainTheseCards = /你[^。]{0,20}获得这些牌/;
	const reGainAllRevealedCards = /获得所有亮出的牌/;
	const reGainThisCard = /你[^。]{0,20}获得此牌/;
	// “你获得一张X”通常明确为拿牌；排除“获得…角色…（手牌/牌）”一类夺牌描述（交给 gain_other_cards 处理）。
	const reGainOneCard = new RegExp(
		String.raw`你(?:(?!令|使(?!用))[^。]){0,10}获得(?![^。]{0,20}角色)[^。]{0,20}(?:${NUM}|一)张`
	);
	const reGainZhi = /你[^。]{0,20}获得之/;
	const reZhiCardContext = /(【[^】]+】|牌堆|弃牌堆|装备区|判定牌|手牌)/;

	/**
	 * 判断“你可以/可……摸X张牌”是否为“你自摸”（排除“你可以令XXX摸牌”）。
	 *
	 * @param {string} text
	 * @returns {boolean}
	 */
	function matchesYouCanDraw(text) {
		if (!text) return false;
		reYouCanDraw.lastIndex = 0;
		for (let m = reYouCanDraw.exec(text); m; m = reYouCanDraw.exec(text)) {
			const between = String(m[1] || "");
			if (between.includes("令")) continue;
			return true;
		}
		return false;
	}

	/**
	 * 判断“当你……时，可以/可……摸X张牌”是否为“你自摸”（排除“……可以令XXX摸牌”）。
	 *
	 * @param {string} text
	 * @returns {boolean}
	 */
	function matchesWhenYouCanDraw(text) {
		if (!text) return false;
		reWhenYouCanDraw.lastIndex = 0;
		for (let m = reWhenYouCanDraw.exec(text); m; m = reWhenYouCanDraw.exec(text)) {
			const between = String(m[1] || "");
			if (between.includes("令")) continue;
			return true;
		}
		return false;
	}

	/**
	 * 判断技能说明中是否存在“你获得（牌）”类收益（不要求使用“摸”字）。
	 *
	 * 说明：
	 * - 主要用于兼容“从牌堆/弃牌堆获得…/观看牌堆顶…获得其中一张/获得这些牌/获得此牌/获得之”等翻译风格
	 * - 尽量排除“获得技能/获得效果/获得标记”等非拿牌语义（通过“张/牌堆/弃牌堆/【】/装备区”等卡牌语境约束）
	 *
	 * @param {string} text
	 * @returns {boolean}
	 */
	function matchesYouGainCards(text) {
		if (!text) return false;
		if (!text.includes("获得")) return false;
		if (reGainFromPileOrDiscard.test(text)) return true;
		if (reThenGainFromPileOrDiscard.test(text)) return true;
		if (reGainDiscardPileEntered.test(text)) return true;
		if (reRevealPileTopAndGain.test(text)) return true;
		if (reGainTheseCards.test(text)) return true;
		if (reGainAllRevealedCards.test(text)) return true;
		if (reGainThisCard.test(text)) return true;
		if (reGainOneCard.test(text) && (text.includes("牌") || text.includes("【") || text.includes("装备区") || text.includes("弃牌堆") || text.includes("牌堆"))) return true;
		if (reGainZhi.test(text) && reZhiCardContext.test(text)) return true;
		return false;
	}

	return {
		id: "draw_self",
		description: "识别技能说明中“自己摸牌/补牌/获得牌”的收益",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("摸") && !text.includes("补") && !text.includes("调整") && !text.includes("获得")) return null;
			if (
				!(
					reYouDraw.test(text) ||
					reMutualDraw.test(text) ||
					reAllEachDraw.test(text) ||
					reAllDraw.test(text) ||
					matchesYouCanDraw(text) ||
					matchesWhenYouCanDraw(text) ||
					reThenDraw.test(text) ||
					reOrDraw.test(text) ||
					reBare.test(text) ||
					reBareAfterComma.test(text) ||
					reRewriteToDraw.test(text) ||
					reOptionMutualDraw.test(text) ||
					reThenMutualDrawWithYouContext.test(text) ||
					reToHandCountSelf.test(text) ||
					reToCountSelfBare.test(text) ||
					reToHandCountMutual.test(text) ||
					reFillToHandCountSelf.test(text) ||
					reAdjustHandCountSelf.test(text) ||
					reDrawCountPlus.test(text) ||
					reExtraDraw.test(text) ||
					reDrawEqual.test(text) ||
					reDrawHpCount.test(text) ||
					reDrawLostHpCount.test(text) ||
					reExtraDrawPhase.test(text) ||
					reDrawPickNumber.test(text) ||
					reDrawDouble.test(text) ||
					matchesYouGainCards(text)
				)
			) {
				return null;
			}
			return { [TAG_DRAW_SELF]: true };
		},
	};
}
