/**
 * “令他人弃牌”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import { TAG_DISCARD_OTHER } from "../../tags.js";
import { NUM } from "../../patterns.js";

export function createDiscardOtherProcessor() {
	const CARD_TAIL = String.raw`[^。]{0,10}(?:手牌|牌)`;
	const PREFIX = String.raw`(?:^|[。；：，,]|[①②③④⑤⑥⑦⑧⑨⑩]|[⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑]|\d+[\.:：]|然后|并|再|接着)\s*`;
	// 排除“令你弃置X张牌”（这是自己弃牌，不应算作“令他人弃牌”）。
	const reLing = new RegExp(String.raw`令(?!\s*你\s*弃置)[^。]{0,30}弃置(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	// “令X弃置你一张手牌”：弃置动作由他人执行，但仍属于“令他人弃牌”语义。
	const reLingDiscardYou = new RegExp(String.raw`令(?!\s*你\s*弃置)[^。]{0,30}弃置你[^。]{0,20}(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	// 注意：排除“其余”以避免误判（如“弃置其余花色的手牌”另有专门匹配）。
	const reQi = new RegExp(String.raw`弃置其(?!余)[^。]{0,30}牌`);
	// “其…弃置X张牌/需弃置X张牌”这类主语在前的写法（常见于“其使用下一张牌后需弃置一张牌”）。
	const reQiDoDiscard = new RegExp(
		String.raw`${PREFIX}(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色)[^。]{0,30}弃置(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`
	);
	const reQiDiscardYou = new RegExp(
		String.raw`${PREFIX}(?:其|该角色|目标角色|目标|当前回合角色|其他角色|这些角色)[^。]{0,30}弃置你[^。]{0,20}(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`
	);
	// “弃置其余花色的手牌/弃置其余…牌”
	const reQiRest = /弃置其余[^。]{0,30}(?:手牌|牌)/;
	const reTarget = new RegExp(String.raw`弃置(?:目标|该角色|目标角色)[^。]{0,30}牌`);
	const reLingAll = /令[^。]{0,20}(?:所有角色|全体角色)[^。]{0,20}弃置(?:所有|全部)(?:手牌|牌)/;
	const reYiMingRole = new RegExp(String.raw`弃置一名[^。]{0,30}角色[^。]{0,30}(?:至少|至多)?(?:${NUM}|任意)张${CARD_TAIL}`);
	const reEach = new RegExp(String.raw`弃置[^。]{0,50}各${NUM}张${CARD_TAIL}`);
	// “展示其他角色的手牌→弃置此牌”一类写法（等价于你弃掉对方的手牌）。
	const reShowDiscardThis = /展示[^。]{0,30}其他角色[^。]{0,30}手牌[^。]{0,40}弃置此牌/;
	// “置入弃牌堆”类写法（可能涉及他人牌）。
	const rePutToDiscardPile = new RegExp(String.raw`(?:当前回合角色|其|该角色|目标角色|目标|其他角色|这些角色)[^。]{0,30}置入弃牌堆`);
	// “你弃置其他角色装备区内的所有牌/弃置一名角色的所有手牌” 等主动弃他写法。
	const reYouDiscardOtherAreaAll = /你弃置[^。]{0,20}(?:其他角色|一名[^。]{0,15}角色)[^。]{0,40}(?:所有|全部)[^。]{0,10}(?:手牌|牌)/;
	// “你弃置……一名角色……的一张牌/手牌” 等主动弃他写法（不要求“所有/全部”）。
	const reYouDiscardOtherOne = /你[^。]{0,20}弃置[^。]{0,30}一名[^。]{0,20}角色[^。]{0,40}一张[^。]{0,10}(?:手牌|牌)/;
	// “令其随机弃置手牌中最多的同名牌” 等“无显式数量”的弃牌写法。
	const reRandDiscardMaxSameName = /(?:令[^。]{0,30})?(?:其|该角色|目标角色|目标|其他角色)[^。]{0,30}弃置[^。]{0,30}手牌中[^。]{0,20}同名牌/;
	// “弃置使用者一张牌/弃置伤害来源一张牌”。
	const reDiscardUser = new RegExp(String.raw`弃置(?:使用者|伤害来源|来源)[^。]{0,10}${NUM}张${CARD_TAIL}`);
	// 二选一写法：“令该角色摸/弃置一张牌”。
	const reDrawOrDiscard = new RegExp(String.raw`令(?!\s*你\s*摸)[^。]{0,30}摸\s*\/\s*弃置${NUM}张${CARD_TAIL}`);

	return {
		id: "discard_other",
		description: "识别技能说明中“令其他角色弃置牌”的效果",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("弃置") && !text.includes("置入弃牌堆")) return null;
			if (
				!(
					reLing.test(text) ||
					reLingDiscardYou.test(text) ||
					reQi.test(text) ||
					reQiDoDiscard.test(text) ||
					reQiDiscardYou.test(text) ||
					reQiRest.test(text) ||
					reTarget.test(text) ||
					reLingAll.test(text) ||
					reYiMingRole.test(text) ||
					reEach.test(text) ||
					reShowDiscardThis.test(text) ||
					rePutToDiscardPile.test(text) ||
					reYouDiscardOtherAreaAll.test(text) ||
					reYouDiscardOtherOne.test(text) ||
					reRandDiscardMaxSameName.test(text) ||
					reDiscardUser.test(text) ||
					reDrawOrDiscard.test(text)
				)
			) {
				return null;
			}
			return { [TAG_DISCARD_OTHER]: true };
		},
	};
}
