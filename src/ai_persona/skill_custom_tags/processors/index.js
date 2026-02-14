/**
 * 内置处理器注册表（集中管理处理器列表与注册顺序）。
 */

import { createActiveMaixieProcessor } from "./maixie/active_maixie.js";
import { createPassiveMaixieProcessor } from "./maixie/passive_maixie.js";
import { createDrawSelfProcessor } from "./cards/draw_self.js";
import { createDrawOtherProcessor } from "./cards/draw_other.js";
import { createDiscardSelfProcessor } from "./cards/discard_self.js";
import { createDiscardOtherProcessor } from "./cards/discard_other.js";
import { createGainOtherCardsProcessor } from "./cards/gain_other_cards.js";
import { createGiveCardsProcessor } from "./cards/give_cards.js";
import { createRecoverSelfProcessor } from "./hp/recover_self.js";
import { createRecoverOtherProcessor } from "./hp/recover_other.js";
import { createDamageOtherProcessor } from "./combat/damage_other.js";
import { createDistanceProcessor } from "./combat/distance.js";
import { createShaExtraProcessor } from "./combat/sha_extra.js";
import { createRespondShanProcessor } from "./defense/respond_shan.js";
import { createRespondShaProcessor } from "./defense/respond_sha.js";
import { createRespondWuxieProcessor } from "./defense/respond_wuxie.js";
import { createTurnoverControlProcessor } from "./control/turnover.js";
import { createLinkControlProcessor } from "./control/link.js";
import { createForceResponseProcessor } from "./response/force_response.js";
import { createForbidCardsProcessor } from "./response/forbid_cards.js";
import { createRejudgeProcessor } from "./utility/rejudge.js";
import { createSaveProcessor } from "./utility/save.js";

/**
 * 创建内置处理器列表。
 *
 * 说明：
 * - 返回的对象会被入口逐个 register 到框架中
 * - 注册顺序会影响“matchedByProcessor”统计，但不会影响最终 tag 写入结果
 *
 * @returns {Array<import("../framework.js").SkillTagTextProcessor>}
 */
export function createBuiltinSkillTagTextProcessors() {
	return [
		// 代价/风险（先标注“卖血/弃牌”等成本，便于后续做更细的冲突处理）
		createActiveMaixieProcessor(),
		createDiscardSelfProcessor(),

		// 回合外防御/响应（闪/杀/无懈等）
		createRespondShanProcessor(),
		createRespondShaProcessor(),
		createRespondWuxieProcessor(),

		// 典型收益（过牌/回血/拿牌）
		createDrawSelfProcessor(),
		createDrawOtherProcessor(),
		createRecoverSelfProcessor(),
		createRecoverOtherProcessor(),
		createGainOtherCardsProcessor(),
		createGiveCardsProcessor(),

		// 距离与额外出杀
		createDistanceProcessor(),
		createShaExtraProcessor(),

		// 强制响应与禁牌
		createForceResponseProcessor(),
		createForbidCardsProcessor(),

		// 负面影响/控制（弃牌/伤害/翻面/连环/改判/救援）
		createDiscardOtherProcessor(),
		createDamageOtherProcessor(),
		createTurnoverControlProcessor(),
		createLinkControlProcessor(),
		createRejudgeProcessor(),
		createSaveProcessor(),

		// 被动卖血（放在末尾：避免与更细粒度收益处理器的“误判兜底”冲突）
		createPassiveMaixieProcessor(),
	].filter(Boolean);
}
