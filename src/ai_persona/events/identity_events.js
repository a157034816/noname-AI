import { STORAGE_KEY } from "../lib/constants.js";
import { isAiPersonaTrackedPlayer } from "../lib/utils.js";
import { addGrudge, addEvidence, addZhuSignal } from "../memory.js";
import { guessIdentityFor } from "../guess_identity.js";

/**
 * 夹逼到闭区间。
 *
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampNumber(x, lo, hi) {
	if (typeof x !== "number" || Number.isNaN(x)) return lo;
	if (x < lo) return lo;
	if (x > hi) return hi;
	return x;
}

/**
 * 安全读取态度值（异常/缺失时回退 0）。
 *
 * @param {*} get
 * @param {*} from
 * @param {*} to
 * @returns {number}
 */
function safeAttitude(get, from, to) {
	if (typeof get?.attitude !== "function") return 0;
	try {
		const v = get.attitude(from, to);
		return typeof v === "number" && !Number.isNaN(v) ? v : 0;
	} catch (e) {
		return 0;
	}
}

/**
 * 安全读取卡牌/技能 info（缺失时回退 null）。
 *
 * @param {*} item
 * @param {*} get
 * @returns {any|null}
 */
function safeGetInfo(item, get) {
	if (!item || typeof get?.info !== "function") return null;
	try {
		return get.info(item, false) || null;
	} catch (e) {
		try {
			return get.info(item) || null;
		} catch (e2) {
			return null;
		}
	}
}

/**
 * 判断某牌是否为“群体/全体”指向（selectTarget:-1 口径）。
 *
 * @param {*} card
 * @param {*} get
 * @returns {boolean}
 */
function isGroupTargetCard(card, get) {
	const info = safeGetInfo(card, get);
	const st = info ? info.selectTarget : undefined;
	return st === -1 || (Array.isArray(st) && st.includes(-1));
}

/**
 * 从 get.result(card, skill) 中取出对 target 的数值结果（尽量兼容 target_use/target 函数形式）。
 *
 * @param {*} card
 * @param {string|undefined|null} skill
 * @param {*} source
 * @param {*} target
 * @param {*} get
 * @returns {number}
 */
function getCardTargetUseValue(card, skill, source, target, get) {
	if (!card || !source || !target) return 0;
	let s = skill;
	if (typeof s !== "string") s = undefined;
	const res = get.result(card, s);
	let tv = res?.target_use ?? res?.target;
	if (typeof tv === "function") {
		try {
			tv = tv(source, target, card);
		} catch (e) {
			tv = 0;
		}
	}
	if (typeof tv !== "number" || Number.isNaN(tv)) return 0;
	return tv;
}

/**
 * 尝试读取技能 ai.result.target_use/target（number/function），失败回退 0。
 *
 * @param {*} info
 * @param {*} source
 * @param {*} target
 * @returns {number}
 */
function safeGetSkillAiResultTarget(info, source, target) {
	const rt = info?.ai?.result?.target_use ?? info?.ai?.result?.target;
	if (typeof rt === "number" && !Number.isNaN(rt)) return rt;
	if (typeof rt === "function") {
		try {
			const v = rt(source, target);
			return typeof v === "number" && !Number.isNaN(v) ? v : 0;
		} catch (e) {
			return 0;
		}
	}
	return 0;
}

/**
 * 从事件链中向上解析无懈可击的 info_map（标准库 chooseToUse(type=wuxie) 会携带）。
 *
 * @param {*} event
 * @returns {*|null}
 */
function resolveWuxieInfoMap(event) {
	let e = event;
	for (let i = 0; i < 10 && e; i++) {
		const m = e?._info_map || e?.info_map;
		if (m) return m;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return null;
}

/**
 * 解析无懈链（支持无懈无懈），得到“原始被无懈的牌信息”与无懈层数（当前无懈计为 1）。
 *
 * @param {*} event
 * @param {*} get
 * @returns {{card:any, player:any, skill:any, targets:any[], depth:number}|null}
 */
function resolveWuxieChain(event, get) {
	const infoMap = resolveWuxieInfoMap(event);
	if (!infoMap) return null;

	let src = infoMap;
	let depth = 0;
	for (let i = 0; i < 12 && src; i++) {
		const name = String(src?.card?.name || "");
		if (name !== "wuxie") break;
		depth += 1;
		if (!src._source) break;
		src = src._source;
	}
	if (depth <= 0) depth = 1;

	const srcCard = src?.card;
	const srcPlayer = src?.player;
	if (!srcCard || !srcPlayer) return null;
	const srcName = String(srcCard?.name || "");
	if (!srcName || srcName === "wuxie") return null;

	let rawTargets = null;
	if (src?.multitarget) rawTargets = src.targets;
	else rawTargets = src.target;
	let arr = [];
	if (Array.isArray(rawTargets)) arr = rawTargets;
	else if (rawTargets) arr = [rawTargets];

	const targets = arr.filter(t => {
		if (!t) return false;
		if (typeof get?.itemtype === "function") {
			try {
				return get.itemtype(t) === "player";
			} catch (e) {
				// ignore
			}
		}
		return typeof t.isDead === "function" || typeof t.countCards === "function";
	});
	if (!targets.length) return null;
	return { card: srcCard, player: srcPlayer, skill: src?.skill, targets, depth };
}

/**
 * 从事件链中向上解析一次结算的 card/skill（尽力而为）。
 *
 * 说明：不同事件节点可能不带 card/skill（例如 damageEnd/recoverEnd），因此这里会向上追溯。
 *
 * @param {*} event
 * @returns {{card:any|null, skill:string}}
 */
function resolveParentCardSkill(event) {
	let e = event;
	let card = null;
	let skill = "";
	for (let i = 0; i < 10 && e; i++) {
		if (!card && e.card) card = e.card;
		if (!skill && e.skill) skill = String(e.skill || "");
		if (card && skill) break;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return { card, skill };
}

/**
 * “敌友关系”态度阈值：达到阈值才认为有方向（sign≠0）。
 *
 * 说明：这里用更低门槛（0.3）来允许“弱证据”进入推理，但会配合 conf 降权（保守）。
 *
 * @type {number}
 */
const REL_ATTITUDE_THRESHOLD = 0.3;

/**
 * “强关系”态度阈值：达到该强度时 conf=1（不再降权）。
 *
 * @type {number}
 */
const REL_ATTITUDE_FULL = 0.6;

/**
 * 按 observer 的视角判断 target 更像友方/敌方/中立，并给出关系强度置信度。
 *
 * 说明（保守实现）：
 * - 仅当 |attitude|>REL_ATTITUDE_THRESHOLD 时才认为存在关系方向
 * - conf∈[0,1]：|attitude| 从阈值到 REL_ATTITUDE_FULL 线性增长；越接近阈值越接近 0
 *
 * @param {*} observer
 * @param {*} target
 * @param {*} get
 * @returns {{sign:1|-1|0, conf:number}}
 */
function getRelationByObserver(observer, target, get) {
	const att = safeAttitude(get, observer, target);
	const abs = Math.abs(att);
	if (!(abs > REL_ATTITUDE_THRESHOLD)) return { sign: 0, conf: 0 };
	const sign = att > 0 ? 1 : -1;
	const denom = REL_ATTITUDE_FULL - REL_ATTITUDE_THRESHOLD;
	const conf = clampNumber((abs - REL_ATTITUDE_THRESHOLD) / (denom || 1e-9), 0, 1);
	return { sign, conf };
}

/**
 * 将一次“对目标的有益/有害行为”折算为对 actor 的 evidence 变动（写入 observer 的心智模型）。
 *
 * 规则：
 * - tv>0 视为“帮助目标”，tv<0 视为“伤害目标”
 * - 若目标在 observer 视角更像友方（att>0.6），帮助=更像友(+)，伤害=更像敌(-)
 * - 若目标在 observer 视角更像敌方（att<-0.6），帮助=更像敌(-)，伤害=更像友(+)
 *
 * @param {*} observer
 * @param {*} actor
 * @param {*} target
 * @param {number} tv
 * @param {*} get
 * @returns {void}
 */
function pushEvidenceByAction(observer, actor, target, tv, get) {
	if (!observer || !actor || !target) return;
	if (observer === actor) return;
	if (tv === 0) return;
	const rel = getRelationByObserver(observer, target, get);
	if (!rel.sign || rel.conf <= 0) return;
	const action = tv > 0 ? 1 : -1;
	const baseMag = clampNumber(Math.abs(tv) * 0.6, 0, 1.2);
	const mag = baseMag * rel.conf;
	if (mag <= 0) return;
	addEvidence(observer, actor, rel.sign * action * mag);
}

/**
 * 安全读取卡牌所在区域（h/e/j 等），失败回退空字符串。
 *
 * @param {*} get
 * @param {*} card
 * @returns {string}
 */
function safeGetCardPosition(get, card) {
	if (!card || typeof get?.position !== "function") return "";
	try {
		return String(get.position(card) || "");
	} catch (e) {
		return "";
	}
}

/**
 * 判断一张牌是否为“已明示的手牌”（用于避免用暗牌价值做推断）。
 *
 * @param {*} get
 * @param {*} card
 * @returns {boolean}
 */
function isShownHandcard(get, card) {
	if (!card) return false;
	const fn = get?.is?.shownCard;
	if (typeof fn !== "function") return false;
	try {
		return !!fn(card);
	} catch (e) {
		return false;
	}
}

/**
 * 安全读取 get.value(card, owner) 的数值（异常/缺失时回退 null）。
 *
 * @param {*} get
 * @param {*} card
 * @param {*} owner
 * @returns {number|null}
 */
function safeGetCardValue(get, card, owner) {
	if (!card || !owner || typeof get?.value !== "function") return null;
	try {
		const v = get.value(card, owner);
		return typeof v === "number" && !Number.isNaN(v) ? v : null;
	} catch (e) {
		return null;
	}
}

/**
 * 计算“拆/顺”对目标的等价收益数值（tv）：正=帮助目标，负=伤害目标。
 *
 * 规则（与 docs/敌友判断因素1.md 对齐，保守实现）：
 * - 判定区：拆掉恶意延时（乐/兵/闪电/伏雷）视为帮助（tv=+1）
 * - 装备/手牌：视为伤害（tv<0），幅度参考 get.value（暗手牌默认按中性价值处理）
 * - 例外：非满血目标的【白银狮子】（baiyin）被拆/被顺视为中立（tv=0）
 *
 * @param {string} pos
 * @param {*} card
 * @param {*} target
 * @param {*} get
 * @returns {number}
 */
function getCardMoveEvidenceTv(pos, card, target, get) {
	let p = String(pos || "");
	if (!p) return 0;
	if (p.length > 1) {
		if (p.includes("j")) p = "j";
		else if (p.includes("e")) p = "e";
		else if (p.includes("h")) p = "h";
	}

	if (p === "j") {
		const viewAs = String(card?.viewAs || card?.name || "");
		if (["lebu", "bingliang", "shandian", "fulei"].includes(viewAs)) return 1;
		return 0;
	}

	if (p !== "h" && p !== "e") return 0;

	// 白银狮子例外：非满血时不算善意也不算恶意
	if (p === "e") {
		const name = String(card?.name || "");
		if (name === "baiyin") {
			const hp = target?.hp;
			const maxHp = target?.maxHp;
			if (typeof hp === "number" && typeof maxHp === "number" && hp < maxHp) return 0;
		}
	}

	let value = 5;
	const publicOrShown = p !== "h" || isShownHandcard(get, card);
	if (publicOrShown) {
		const v = safeGetCardValue(get, card, target);
		if (typeof v === "number") value = v;
	}

	const tvAbs = clampNumber(value / 5, 0.8, 2.0);
	return -tvAbs;
}

/**
 * 受伤结算完成后更新心智模型。
 *
 * 注意：身份局里“主公受伤”属于全场公开信息，应当被所有本地 AI 观察者记录，
 * 不应依赖“受伤者是否为本地 AI”（否则当主公为人类玩家时线索会丢失）。
 *
 * @param {*} trigger
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onDamageEnd(trigger, player, game, get, _status) {
	// 身份局：有人伤害主公 -> 观测者更新证据（与受伤者是否为本地AI无关）
	if (get.mode() === "identity" && game.zhu && trigger.player === game.zhu && trigger.source) {
		const amt = 0.8 + (trigger.num || 1) * 0.3;
		for (const observer of game.players) {
			if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
			if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
			// 观测者基于自身身份给出“嫌疑/好感”方向
			let sign = 0;
			if (["zhu", "zhong", "mingzhong"].includes(observer.identity)) sign = -1;
			else if (observer.identity === "fan") sign = 1;
			else sign = -0.2;
			addEvidence(observer, trigger.source, sign * amt);
			// 客观线索：伤害主公 -> 更偏向反贼（负）
			addZhuSignal(observer, trigger.source, -amt);
		}
	}

	// 其余“个人受伤/记仇”等心智更新，仅对本地 AI 生效（避免污染人类玩家/联机玩家）。
	if (!isAiPersonaTrackedPlayer(player, game, _status)) return;
	const st = player.storage?.[STORAGE_KEY];
	if (!st?.persona) return;
	const source = trigger.source;
	if (source && source !== player) {
		const revengeWeight = st.persona.traits?.revengeWeight || 1;
		addGrudge(player, source, (trigger.num || 1) * revengeWeight);
	}
}

/**
 * 身份局：主公回复体力属于公开信息，旁观 AI 可据此更新“忠/反倾向”线索。
 *
 * @param {*} trigger
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRecoverEnd(trigger, player, game, get, _status) {
	if (get.mode() !== "identity") return;
	if (!game.zhu || player !== game.zhu) return;
	const source = trigger.source;
	if (!source) return;
	const amt = 0.8 * (trigger.num || 1);
	for (const observer of game.players) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		let sign = 0;
		if (["zhu", "zhong", "mingzhong"].includes(observer.identity)) sign = 1;
		else if (observer.identity === "fan") sign = -0.4;
		else sign = 0.2;
		addEvidence(observer, source, sign * 0.8);
		// 客观线索：治疗/回复主公 -> 更偏向忠臣（正）
		addZhuSignal(observer, source, amt);
	}
}

/**
 * 身份局：在 damageEnd 结算后基于“客观伤害结果”写入 evidence（兜底，保守）。
 *
 * 说明：
 * - 仅身份局、仅本地 AI 观察者记录
 * - 跳过主公（主公线索由 onDamageEnd/onRecoverEnd 的 zhuSignal 覆盖）
 * - 若本次结算可关联到“用牌”（trigger.card.name 存在），认为已由 useCardToTargetedEvidence 覆盖，跳过
 * - 若本次结算可关联到“用技能”且技能 ai.result.target(_use) 可得非 0 tv，认为已由 onUseSkillEvidence 覆盖，跳过
 *
 * @param {*} trigger
 * @param {*} player 受伤者
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onDamageEndEvidenceGeneral(trigger, player, game, get, _status) {
	if (get.mode() !== "identity") return;
	if (_status.connectMode) return;
	if (!trigger || !player || !game) return;

	if (game.zhu && player === game.zhu) return;

	const source = trigger.source;
	if (!source || source === player) return;

	const cause = resolveParentCardSkill(trigger);
	// 有明确 card.name 的，视为“用牌”链路（避免重复计数）
	const cardName = String(cause?.card?.name || "");
	if (cardName) return;

	// 若技能本身已提供 ai.result，则认为 useSkillEvidence 已覆盖（避免重复计数）
	const skill = String(cause?.skill || "");
	if (skill) {
		const info = safeGetInfo(skill, get);
		if (info && !info.viewAs) {
			const tvSkill = safeGetSkillAiResultTarget(info, source, player);
			if (tvSkill !== 0) return;
		}
	}

	const n = trigger.num || 1;
	if (!(n > 0)) return;

	const tv = -Math.min(2, n);
	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		pushEvidenceByAction(observer, source, player, tv, get);
	}
}

/**
 * 身份局：在 recoverEnd 结算后基于“客观回复结果”写入 evidence（兜底，保守）。
 *
 * 说明：
 * - 仅身份局、仅本地 AI 观察者记录
 * - 跳过主公（主公线索由 onRecoverEnd 覆盖）
 * - 若本次结算可关联到“用牌”（trigger.card.name 存在），认为已由 useCardToTargetedEvidence 覆盖，跳过
 * - 若本次结算可关联到“用技能”且技能 ai.result.target(_use) 可得非 0 tv，认为已由 onUseSkillEvidence 覆盖，跳过
 *
 * @param {*} trigger
 * @param {*} player 回复者
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRecoverEndEvidenceGeneral(trigger, player, game, get, _status) {
	if (get.mode() !== "identity") return;
	if (_status.connectMode) return;
	if (!trigger || !player || !game) return;

	if (game.zhu && player === game.zhu) return;

	const source = trigger.source;
	if (!source || source === player) return;

	const cause = resolveParentCardSkill(trigger);
	const cardName = String(cause?.card?.name || "");
	if (cardName) return;

	const skill = String(cause?.skill || "");
	if (skill) {
		const info = safeGetInfo(skill, get);
		if (info && !info.viewAs) {
			const tvSkill = safeGetSkillAiResultTarget(info, source, player);
			if (tvSkill !== 0) return;
		}
	}

	const n = trigger.num || 1;
	if (!(n > 0)) return;

	const tv = Math.min(2, n);
	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		pushEvidenceByAction(observer, source, player, tv, get);
	}
}

/**
 * 将 ai.shown 提升到至少 minValue（不降低、不超过 0.95）。
 *
 * @param {*} player
 * @param {number} minValue
 * @returns {void}
 */
function setAiShown(player, minValue) {
	if (!player || player.identityShown) return;
	if (!player.ai || typeof player.ai.shown !== "number") return;
	const v = Math.min(0.95, Math.max(player.ai.shown, minValue));
	player.ai.shown = v;
}

/**
 * 获取一次 useCardToTargeted 行为对目标的“收益数值”（来自 get.result）。
 *
 * @param {*} trigger
 * @param {*} source
 * @param {*} target
 * @param {*} get
 * @returns {number}
 */
function getTargetResultNumber(trigger, source, target, get) {
	if (!trigger?.card) return 0;
	return getCardTargetUseValue(trigger.card, trigger.skill, source, target, get);
}

const SHA_TO_ZHU_ATTEMPT_SIGNAL = 0.35;

/**
 * 身份局：对主公使用【杀】（无论是否造成伤害）都记录为“敌意倾向”线索。
 *
 * 说明：
 * - `damageEnd` 只会在“实际造成伤害”时触发；若主公频繁【闪】/免伤，会导致线索不足长期停留在未知
 * - 这里以更小的幅度补充“出杀倾向”，与 `damageEnd` 的“实际伤害”线索叠加
 *
 * @param {*} trigger
 * @param {*} actor
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
function recordShaToZhuAttempt(trigger, actor, game, _status) {
	if (!game?.zhu) return;
	const target = trigger?.target;
	if (!target || target !== game.zhu) return;
	const cardName = String(trigger?.card?.name || "");
	if (cardName !== "sha") return;

	for (const observer of game.players) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		// 客观线索：对主公出杀 -> 更偏向反贼（负）
		addZhuSignal(observer, actor, -SHA_TO_ZHU_ATTEMPT_SIGNAL);
	}
}

/**
 * 身份局：在 useCardToTargeted 阶段更新“暴露度”与间接阵营线索。
 *
 * @param {*} trigger
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onUseCardToTargetedExpose(trigger, player, game, get, _status) {
	if (get.mode() !== "identity") return;
	if (_status.connectMode) return;
	if (!player || player.identityShown) return;
	if (typeof player.isOnline === "function" && player.isOnline()) return;

	const target = trigger.target;
	if (!target || target === player) return;

	// 主公相关线索：出杀倾向（无需等待造成伤害）
	recordShaToZhuAttempt(trigger, player, game, _status);

	const tv = getTargetResultNumber(trigger, player, target, get);
	if (tv === 0) return;

	// 规则1：对已明置身份的目标做有害行为 -> 软暴露拉满
	if (tv < 0 && target.identityShown) {
		setAiShown(player, 0.95);
	}

	// 规则2：对“已软暴露”的目标做有益行为 -> 自己也软暴露
	const targetShown = target.ai && typeof target.ai.shown === "number" ? target.ai.shown : 0;
	if (tv > 0 && !target.identityShown && targetShown >= 0.7) {
		setAiShown(player, 0.85);
	}

	// 间接线索：当目标已软暴露（或已明置）时，你对其的有益/有害行为会被旁观AI折算为“阵营倾向线索”
	// - 目标越“被确信”（明置/高软暴露/猜测置信度高），线索越强
	// - 仅对非主公生效（主公相关线索已由 damageEnd/recoverEnd 等直接事件记录）
	if (get.mode() !== "identity" || !game?.zhu || target === game.zhu) return;

	const targetExposed = target.identityShown || targetShown >= 0.7;
	if (!targetExposed) return;

	const baseMag = Math.min(2, Math.abs(tv));
	const actSign = tv > 0 ? 1 : -1; // +: 帮助目标；-: 伤害目标

	for (const observer of game.players) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;

		let align = 0; // +1: 更像忠（偏主公阵营）；-1: 更像反
		let conf = 0;

		if (target.identityShown) {
			const id = String(target.identity || "");
			if (["zhu", "zhong", "mingzhong"].includes(id)) align = 1;
			else if (id === "fan") align = -1;
			else align = 0;
			conf = 1;
		} else {
			const g = guessIdentityFor(observer, target, game);
			const gid = String(g?.identity || "unknown");
			if (["zhu", "zhong", "mingzhong"].includes(gid)) align = 1;
			else if (gid === "fan") align = -1;
			else align = 0;
			conf = typeof g?.confidence === "number" ? Math.max(0, Math.min(1, g.confidence)) : 0;
		}

		if (!align || conf < 0.15) continue;

		const revealWeight = target.identityShown ? 1 : targetShown >= 0.85 ? 0.8 : 0.6;
		// 行为对“使用者阵营倾向”的推断：帮忠=更像忠；打忠=更像反；帮反=更像反；打反=更像忠
		const delta = actSign * align * baseMag * 0.6 * conf * revealWeight;
		if (delta) addZhuSignal(observer, player, delta);
	}
}

/**
 * 身份局：在 useCardToTargeted 阶段记录“善意/恶意举措”对敌友判断的影响（写入 evidence）。
 *
 * 口径（与 docs/敌友判断因素1.md 对齐，保守实现）：
 * - 仅身份局、仅本地 AI 观察者记录
 * - 仅单目标（targets.length===1）
 * - 排除“群体/全体”牌（selectTarget:-1）
 * - Wuxie（无懈可击）：支持链式无懈（无懈无懈），按层数奇偶对原 tv 取反（奇数取反；偶数还原）
 * - 拆/顺（过河/顺手）：在 rewriteDiscardResult/rewriteGainResult 阶段按实际被拆/被顺的牌所在区域细化记录，避免重复计数
 * - 仅使用引擎公开的 ai.result / get.result 口径，不读取暗牌或真实身份
 *
 * @param {*} trigger
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onUseCardToTargetedEvidence(trigger, player, game, get, _status) {
	if (get.mode() !== "identity") return;
	if (_status.connectMode) return;
	if (!trigger || !player || !game) return;
	if (!trigger.card) return;

	const cardName = String(trigger.card?.name || "");
	if (!cardName) return;

	// 无懈可击：支持无懈链（无懈无懈），按奇偶层数对原 tv 取反/还原，并以“被无懈的原目标”为观测目标
	if (cardName === "wuxie") {
		const info = resolveWuxieChain(trigger, get);
		if (!info) return;
		if (info.targets.length !== 1) return;
		const target = info.targets[0];
		if (!target || target === player) return;

		const tv0 = getCardTargetUseValue(info.card, info.skill, info.player, target, get);
		if (tv0 === 0) return;
		const sign = info.depth % 2 === 1 ? -1 : 1;
		const tv = tv0 * sign;

		for (const observer of game.players || []) {
			if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
			if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
			pushEvidenceByAction(observer, player, target, tv, get);
		}
		return;
	}

	// 拆顺在 rewriteDiscardResult/rewriteGainResult 阶段细化记录，避免重复计数
	if (cardName === "guohe" || cardName === "shunshou") return;

	// 仅单目标（非全体/非多目标）
	const ts = Array.isArray(trigger.targets) ? trigger.targets : [];
	if (ts.length !== 1) return;
	if (isGroupTargetCard(trigger.card, get)) return;

	const target = trigger.target;
	if (!target || target === player) return;

	const tv = getCardTargetUseValue(trigger.card, trigger.skill, player, target, get);
	if (tv === 0) return;

	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		pushEvidenceByAction(observer, player, target, tv, get);
	}
}

/**
 * 身份局：在 rewriteDiscardResult 阶段记录【过河拆桥】的拆牌行为对敌友判断的影响（写入 evidence）。
 *
 * @param {*} trigger
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRewriteDiscardResultEvidence(trigger, player, game, get, _status) {
	if (get.mode() !== "identity") return;
	if (_status.connectMode) return;
	if (!trigger || !player || !game) return;

	const parent = typeof trigger.getParent === "function" ? trigger.getParent() : null;
	if (String(parent?.name || "") !== "guohe") return;

	const target = trigger.target;
	if (!target || target === player) return;

	const cards = Array.isArray(trigger.cards) ? trigger.cards : [];
	if (cards.length !== 1) return;
	const card = cards[0];
	if (!card) return;

	const pos = safeGetCardPosition(get, card);
	if (!pos) return;
	const tv = getCardMoveEvidenceTv(pos, card, target, get);
	if (tv === 0) return;

	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		pushEvidenceByAction(observer, player, target, tv, get);
	}
}

/**
 * 身份局：在 rewriteGainResult 阶段记录【顺手牵羊】的顺牌行为对敌友判断的影响（写入 evidence）。
 *
 * @param {*} trigger
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onRewriteGainResultEvidence(trigger, player, game, get, _status) {
	if (get.mode() !== "identity") return;
	if (_status.connectMode) return;
	if (!trigger || !player || !game) return;

	const parent = typeof trigger.getParent === "function" ? trigger.getParent() : null;
	if (String(parent?.name || "") !== "shunshou") return;

	const target = trigger.target;
	if (!target || target === player) return;

	const cards = Array.isArray(trigger.cards) ? trigger.cards : [];
	if (cards.length !== 1) return;
	const card = cards[0];
	if (!card) return;

	const pos = safeGetCardPosition(get, card);
	if (!pos) return;
	const tv = getCardMoveEvidenceTv(pos, card, target, get);
	if (tv === 0) return;

	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		pushEvidenceByAction(observer, player, target, tv, get);
	}
}

/**
 * 身份局：在 useSkill 阶段记录“善意/恶意举措”对敌友判断的影响（写入 evidence）。
 *
 * 口径（保守实现）：
 * - 仅身份局、仅本地 AI 观察者记录
 * - 仅单目标（targets.length===1）
 * - 跳过 viewAs 技能（由用牌事件覆盖，避免重复计数）
 * - 仅在技能定义了 ai.result.target_use/target 时才记录（无结果则视为无法判定）
 *
 * @param {*} trigger
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onUseSkillEvidence(trigger, player, game, get, _status) {
	if (get.mode() !== "identity") return;
	if (_status.connectMode) return;
	if (!trigger || !player || !game) return;

	const skill = String(trigger.skill || "");
	if (!skill) return;

	const targets = Array.isArray(trigger.targets) ? trigger.targets : [];
	if (targets.length !== 1) return;
	const target = targets[0];
	if (!target || target === player) return;

	const info = safeGetInfo(skill, get);
	if (!info) return;
	if (info.viewAs) return;

	const tv = safeGetSkillAiResultTarget(info, player, target);
	if (tv === 0) return;

	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		pushEvidenceByAction(observer, player, target, tv, get);
	}
}
