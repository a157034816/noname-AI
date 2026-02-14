/**
 * 身临其境的AI：自定义技能 tag（写入 skill.ai，供 hasSkillTag 读取）。
 *
 * 约定：
 * - tag 以 `slqj_ai_` 前缀命名，避免与引擎/其他扩展冲突
 * - 值建议为 boolean（true）或数字/字符串（需要更细粒度语义时）
 */

/** 卖血（泛化）：技能与“失去体力/受到伤害”存在强关联（主动或被动触发）。 */
export const TAG_MAIXIE = "slqj_ai_maixie";

/** 主动卖血：主动失去体力/主动受伤以换取收益（如过牌/爆发）。 */
export const TAG_ACTIVE_MAIXIE = "slqj_ai_active_maixie";

/** 被动卖血：受到伤害/失去体力后触发收益（过牌/反制/资源等）。 */
export const TAG_PASSIVE_MAIXIE = "slqj_ai_passive_maixie";

/** 自己摸牌：技能的主要收益为“自己摸牌/补牌”（不含“令他人摸牌”）。 */
export const TAG_DRAW_SELF = "slqj_ai_draw_self";

/** 令他人摸牌：主要收益为“令其他角色摸牌/补牌”。 */
export const TAG_DRAW_OTHER = "slqj_ai_draw_other";

/** 弃置自己牌：技能含“弃置自己的牌”作为代价或效果。 */
export const TAG_DISCARD_SELF = "slqj_ai_discard_self";

/** 令他人弃牌：技能可令其他角色弃置牌（含手牌/区域牌）。 */
export const TAG_DISCARD_OTHER = "slqj_ai_discard_other";

/** 获得他人牌：技能可获得其他角色的牌（顺手/夺取/获得其区域牌等）。 */
export const TAG_GAIN_OTHER_CARDS = "slqj_ai_gain_other_cards";

/** 交给/赠予：技能会把牌交给其他角色（给牌/分牌）。 */
export const TAG_GIVE_CARDS = "slqj_ai_give_cards";

/** 回复自己体力：技能含“你回复体力/将体力值回复至…”。 */
export const TAG_RECOVER_SELF = "slqj_ai_recover_self";

/** 回复他人体力：技能可令其他角色回复体力。 */
export const TAG_RECOVER_OTHER = "slqj_ai_recover_other";

/** 造成伤害：技能说明中存在“对其/对一名角色造成X点伤害”等直接伤害效果。 */
export const TAG_DAMAGE_OTHER = "slqj_ai_damage_other";

/** 控制：翻面（含令他人翻面/你翻面等翻面控制）。 */
export const TAG_CONTROL_TURNOVER = "slqj_ai_control_turnover";

/** 控制：横置/连环（铁索/横置状态等）。 */
export const TAG_CONTROL_LINK = "slqj_ai_control_link";

/** 改判：技能可更改/改判判定牌或判定结果。 */
export const TAG_REJUDGE = "slqj_ai_rejudge";

/** 救援：技能与“濒死”救助强相关（如视为使用桃/回复体力等）。 */
export const TAG_SAVE = "slqj_ai_save";

/** 回合外防御：具备典型回合外防御/响应能力（如可响应闪/无懈等）。 */
export const TAG_DEFEND_OUT_OF_TURN = "slqj_ai_defend_out_of_turn";

/** 回合外响应：可通过技能打出/视为打出【闪】。 */
export const TAG_RESPOND_SHAN = "slqj_ai_respond_shan";

/** 免费闪：可不消耗牌（或近似无代价）视为打出【闪】（保守识别）。 */
export const TAG_FREE_SHAN = "slqj_ai_free_shan";

/** 回合外响应：可通过技能打出/视为打出【杀】。 */
export const TAG_RESPOND_SHA = "slqj_ai_respond_sha";

/** 免费杀：可不消耗牌（或近似无代价）视为打出【杀】（保守识别）。 */
export const TAG_FREE_SHA = "slqj_ai_free_sha";

/** 无懈：可通过技能使用/打出/视为使用【无懈可击】。 */
export const TAG_RESPOND_WUXIE = "slqj_ai_respond_wuxie";

/** 免费无懈：可不消耗牌（或近似无代价）视为使用【无懈可击】（保守识别）。 */
export const TAG_FREE_WUXIE = "slqj_ai_free_wuxie";

/** 距离-：缩短你与其他角色的距离（如距离-1）。 */
export const TAG_DISTANCE_MINUS = "slqj_ai_distance_minus";

/** 距离+：增大你与其他角色的距离（如距离+1）。 */
export const TAG_DISTANCE_PLUS = "slqj_ai_distance_plus";

/** 无距离限制：使用牌/技能无距离限制（含“无距离和次数限制”）。 */
export const TAG_IGNORE_DISTANCE = "slqj_ai_ignore_distance";

/** 攻击范围+：增加攻击范围（如攻击范围+1）。 */
export const TAG_ATTACK_RANGE_PLUS = "slqj_ai_attack_range_plus";

/** 额外出杀：使用【杀】次数增加/额外使用【杀】。 */
export const TAG_SHA_EXTRA = "slqj_ai_sha_extra";

/** 无限出杀：使用【杀】无次数限制/不计入次数。 */
export const TAG_SHA_UNLIMITED = "slqj_ai_sha_unlimited";

/** 强制响应【闪】：技能可强制他人打出【闪】否则受罚。 */
export const TAG_FORCE_RESPONSE_SHAN = "slqj_ai_force_response_shan";

/** 强制响应【杀】：技能可强制他人打出【杀】否则受罚。 */
export const TAG_FORCE_RESPONSE_SHA = "slqj_ai_force_response_sha";

/** 禁牌：使某方（你/他人）不能使用/打出牌（泛化标记）。 */
export const TAG_FORBID_CARDS = "slqj_ai_forbid_cards";

/** 禁【杀】：不能使用/打出【杀】（泛化标记）。 */
export const TAG_FORBID_SHA = "slqj_ai_forbid_sha";

/** 禁【闪】：不能使用/打出【闪】（泛化标记）。 */
export const TAG_FORBID_SHAN = "slqj_ai_forbid_shan";

/** 禁【无懈】：不能使用/打出【无懈可击】（泛化标记）。 */
export const TAG_FORBID_WUXIE = "slqj_ai_forbid_wuxie";

/** 改判细分：打出牌代替判定牌（替换判定牌）。 */
export const TAG_REJUDGE_REPLACE_CARD = "slqj_ai_rejudge_replace_card";

/** 改判细分：重新判定/再判定（重判）。 */
export const TAG_REJUDGE_REROLL = "slqj_ai_rejudge_reroll";

/** 改判细分：更改判定结果（颜色/花色/点数/结果视为）。 */
export const TAG_REJUDGE_MODIFY_RESULT = "slqj_ai_rejudge_modify_result";

/** 改判细分：可作用于他人判定（不仅限自己）。 */
export const TAG_REJUDGE_OTHER = "slqj_ai_rejudge_other";

/** 改判细分：仅/主要作用于自己判定。 */
export const TAG_REJUDGE_SELF = "slqj_ai_rejudge_self";

/** 改判细分：可获得/拿走判定牌（判定牌收益）。 */
export const TAG_REJUDGE_GAIN_JUDGE = "slqj_ai_rejudge_gain_judge";
