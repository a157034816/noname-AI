/**
 * “改判”处理器：基于技能文本说明（正则）补全自定义 tag。
 *
 * @returns {{id:string, description:string, process:(input: import("../../framework.js").SkillTextProcessInput)=> (Record<string, boolean>|null)}}
 */

import {
	TAG_REJUDGE,
	TAG_REJUDGE_GAIN_JUDGE,
	TAG_REJUDGE_MODIFY_RESULT,
	TAG_REJUDGE_OTHER,
	TAG_REJUDGE_REPLACE_CARD,
	TAG_REJUDGE_REROLL,
	TAG_REJUDGE_SELF,
} from "../../tags.js";

export function createRejudgeProcessor() {
	const reKeyword = /(改判|更改判定|修改判定|更改判定结果|修改判定结果)/;
	const reReplace = /(判定牌生效前|判定生效前)[^。]*打出[^。]{0,20}(?:牌|手牌)[^。]{0,20}(?:代替|替换)|打出[^。]{0,20}(?:牌|手牌)[^。]{0,20}(?:代替|替换)(?:之|此判定牌|该判定牌)/;
	const reReroll = /(重新判定|再判定|重新进行判定|重判)/;
	const reModify = /(判定结果[^。]{0,12}(?:改为|视为|变为|视作|视同|反转))/;
	const reGainJudge = /(获得[^。]{0,12}判定牌|获得此判定牌|获得该判定牌)/;
	const reSelf = /(当你(?:进行)?判定|你的判定)/;
	const reOther = /(当一名角色(?:进行)?判定|当其他角色(?:进行)?判定|一名角色的判定|其他角色的判定|任意角色(?:进行)?判定|目标角色(?:进行)?判定)/;

	return {
		id: "rejudge",
		description: "识别技能说明中的改判能力，并细分：替换判定牌/重判/改结果/作用对象/判定牌收益等",
		process(input) {
			const text = input && typeof input.text === "string" ? input.text : "";
			if (!text) return null;
			if (!text.includes("判定") && !text.includes("改判")) return null;

			const isRejudge = reKeyword.test(text) || reReplace.test(text) || reReroll.test(text) || reModify.test(text);
			if (!isRejudge) return null;

			/** @type {Record<string, boolean>} */
			const out = { [TAG_REJUDGE]: true };
			if (reReplace.test(text)) out[TAG_REJUDGE_REPLACE_CARD] = true;
			if (reReroll.test(text)) out[TAG_REJUDGE_REROLL] = true;
			if (reModify.test(text) || /更改判定结果|修改判定结果/.test(text)) out[TAG_REJUDGE_MODIFY_RESULT] = true;
			if (reGainJudge.test(text)) out[TAG_REJUDGE_GAIN_JUDGE] = true;
			if (reSelf.test(text)) out[TAG_REJUDGE_SELF] = true;
			if (reOther.test(text) || /一名角色的判定牌生效前/.test(text) || /其他角色的判定牌生效前/.test(text)) out[TAG_REJUDGE_OTHER] = true;
			return out;
		},
	};
}
