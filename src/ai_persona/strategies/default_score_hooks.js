import {
	findEventCard,
	getCardType,
	isTaoCard,
	isWuxieCard,
	isDelayTrickCard,
	isNormalTrickCard,
	getResultNumberForTarget,
	isOffensiveGroupTrickCard,
	isBeneficialGroupTrickCard,
} from "../lib/card_utils.js";
import {
	shouldReserveTao,
	isExposedEnemyTarget,
	isExposedFriendlyTarget,
	shouldUseOffensiveGroupTrick,
	shouldUseBeneficialGroupTrick,
} from "../lib/identity_utils.js";
import { STORAGE_KEY } from "../lib/constants.js";
import { getPid } from "../lib/utils.js";
import {
	TAG_ACTIVE_MAIXIE,
	TAG_CONTROL_LINK,
	TAG_CONTROL_TURNOVER,
	TAG_DAMAGE_OTHER,
	TAG_DISCARD_OTHER,
	TAG_DRAW_OTHER,
	TAG_DRAW_SELF,
	TAG_FORBID_SHA,
	TAG_GAIN_OTHER_CARDS,
	TAG_GIVE_CARDS,
	TAG_MAIXIE,
	TAG_PASSIVE_MAIXIE,
	TAG_RECOVER_OTHER,
	TAG_RECOVER_SELF,
	TAG_REJUDGE,
	TAG_SAVE,
	TAG_SHA_EXTRA,
	TAG_SHA_UNLIMITED,
} from "../skill_custom_tags/tags.js";
import { NUM } from "../skill_custom_tags/patterns.js";

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
 * 读取玩家的“回合记忆”（turnMemory），若不存在则返回 null。
 *
 * @param {*} player
 * @returns {import("../lib/jsdoc_types.js").SlqjAiTurnMemory|null}
 */
function safeGetTurnMemory(player) {
	const st = player?.storage?.[STORAGE_KEY];
	/** @type {any} */
	const tm = st?.runtime?.turnMemory;
	if (!tm || typeof tm !== "object") return null;
	if (!Array.isArray(tm.events)) return null;
	return tm;
}

/**
 * 统计“本回合内 player 对 target 已造成的扣血量”（damage + loseHp）。
 *
 * 说明：
 * - 仅在 player 为本回合 activePid 时统计（避免回合外/响应阶段把历史伤害算进来）
 * - 规则用于限制开局“同回合盲打连击收割”的过激倾向
 *
 * @param {*} player
 * @param {*} target
 * @returns {number}
 */
function getTurnDamageFromPlayerToTarget(player, target) {
	if (!player || !target || player === target) return 0;
	const tm = safeGetTurnMemory(player);
	if (!tm) return 0;

	const selfPid = getPid(player);
	const targetPid = getPid(target);
	if (!selfPid || !targetPid) return 0;

	// 只统计“自己本回合行动”的链路
	if (String(tm.activePid || "") !== selfPid) return 0;

	let total = 0;
	for (const ev of tm.events) {
		if (!ev) continue;
		if (String(ev.sourcePid || "") !== selfPid) continue;
		if (String(ev.targetPid || "") !== targetPid) continue;
		const kind = String(ev.kind || "");
		if (kind !== "damage" && kind !== "loseHp") continue;
		const n = typeof ev.num === "number" && !Number.isNaN(ev.num) ? ev.num : 1;
		if (n > 0) total += n;
	}
	return total;
}

/**
 * 安全读取“当前已选择的目标”（用于 singleCard + filterAddedTarget 的 addedTarget 选择阶段）。
 *
 * 说明：
 * - 引擎对【借刀杀人】这类“先选目标 A，再选 addedTarget B”的牌，会用 `ui.selected.targets` 维护已选目标。
 * - 部分链路上还可能通过 `event.preTarget` 暂存前置目标。
 *
 * @param {*} event
 * @returns {any[]}
 */
function safeGetSelectedTargets(event) {
	const out = [];

	// UI 选择器状态（AI 选择流程同样会维护它，用于 filterAddedTarget 等判定）
	const uiTargets = globalThis?.ui?.selected?.targets;
	if (Array.isArray(uiTargets)) {
		for (const t of uiTargets) {
			if (t) out.push(t);
		}
	}

	// 兼容：部分事件链会额外带一个 preTarget
	const pre = event?.preTarget;
	if (pre && !out.includes(pre)) out.push(pre);

	return out;
}

/**
 * 安全读取卡牌价值（缺失时回退 0）。
 *
 * @param {*} card
 * @param {*} player
 * @param {*} get
 * @returns {number}
 */
function safeGetCardValue(card, player, get) {
	if (!card) return 0;
	if (typeof get?.value !== "function") return 0;
	try {
		const v = get.value(card, player);
		return typeof v === "number" && Number.isFinite(v) ? v : 0;
	} catch (e) {
		return 0;
	}
}

/**
 * 安全获取玩家装备区中的武器牌（equip1），无则返回 null。
 *
 * @param {*} player
 * @param {*} get
 * @returns {*|null}
 */
function safeGetWeaponCard(player, get) {
	const equips = safeGetCards(player, "e");
	for (const c of equips) {
		const info = safeGetInfo(c, get);
		const subtype = String(info?.subtype || c?.subtype || "");
		if (subtype === "equip1") return c;
	}
	return null;
}

/**
 * 估算玩家“失去武器后会被卡距离”的风险（轻量启发式）。
 *
 * 规则（按“卡距离=范围内没有可攻击目标”）：
 * - 若玩家失去武器后，其估算攻击范围内没有任何“明确敌对目标”（attitude<-0.3），则判定为有风险。
 * - 该判定是距离层面的轻量启发式，不精确模拟所有技能/装备带来的额外选目标限制。
 *
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {{known:boolean, risk:boolean, currentRange:number, noWeaponRange:number, weaponCard:any|null}}
 */
function estimateWeaponLossDistanceBlockRisk(player, game, get) {
	const out = {
		known: false,
		risk: false,
		currentRange: 1,
		noWeaponRange: 1,
		weaponCard: null,
	};

	if (!player || !game) return out;

	let currentRange = 1;
	try {
		if (typeof player?.getAttackRange === "function") {
			const v = player.getAttackRange();
			if (typeof v === "number" && Number.isFinite(v)) currentRange = v;
		}
	} catch (e) {
		currentRange = 1;
	}
	out.currentRange = currentRange;

	const weaponCard = safeGetWeaponCard(player, get);
	out.weaponCard = weaponCard;
	if (!weaponCard) return out;
	if (typeof player?.getEquipRange !== "function") return out;

	const equipsAll = safeGetCards(player, "e");
	let equipRange = 1;
	try {
		const v = player.getEquipRange();
		if (typeof v === "number" && Number.isFinite(v)) equipRange = v;
	} catch (e) {
		equipRange = 1;
	}

	const modDelta = Number.isFinite(currentRange) ? currentRange - equipRange : 0;

	const equipsWithoutWeapon = equipsAll.filter(c => c && c !== weaponCard);
	let equipRangeNoWeapon = 1;
	try {
		const v = player.getEquipRange(equipsWithoutWeapon);
		if (typeof v === "number" && Number.isFinite(v)) equipRangeNoWeapon = v;
	} catch (e) {
		equipRangeNoWeapon = 1;
	}

	let noWeaponRange = equipRangeNoWeapon + (Number.isFinite(modDelta) ? modDelta : 0);
	if (!Number.isFinite(noWeaponRange)) noWeaponRange = equipRangeNoWeapon;
	noWeaponRange = Math.max(1, noWeaponRange);

	out.noWeaponRange = noWeaponRange;
	out.known = true;

	let hasEnemyAfterLoss = false;
	for (const p of game.players || []) {
		if (!p || p === player) continue;
		try {
			if (typeof p.isDead === "function" && p.isDead()) continue;
		} catch (e) {
			// ignore
		}

		const att = safeAttitude(get, player, p);
		if (att >= -0.3) continue;

		const dist = safeDistance(get, player, p);
		if (!Number.isFinite(dist) || dist <= 0) continue;

		// 失去武器后范围内仍有敌方 -> 不算“卡距离”
		if (dist <= noWeaponRange + 0.001) {
			hasEnemyAfterLoss = true;
			break;
		}
	}

	out.risk = !hasEnemyAfterLoss;
	return out;
}

/**
 * 安全读取 persona id（缺失时回退空字符串）。
 *
 * @param {*} player
 * @returns {string}
 */
function safeGetPersonaId(player) {
	return String(player?.storage?.[STORAGE_KEY]?.persona?.id || "");
}

/**
 * 安全读取全局怒气（缺失时回退 0）。
 *
 * @param {*} player
 * @returns {number}
 */
function safeGetRage(player) {
	const v = player?.storage?.[STORAGE_KEY]?.memory?.rage;
	return typeof v === "number" && !Number.isNaN(v) ? v : 0;
}

/**
 * 安全读取对目标的定向怒气（缺失时回退 0）。
 *
 * @param {*} player
 * @param {*} target
 * @returns {number}
 */
function safeGetRageTowards(player, target) {
	const pid = getPid(target);
	const v = player?.storage?.[STORAGE_KEY]?.memory?.rageTowards?.[pid];
	return typeof v === "number" && !Number.isNaN(v) ? v : 0;
}

/**
 * 怒气影响权重（按人格类型）。
 *
 * @param {string} personaId
 * @returns {{wT:number, wG:number}}
 */
function getRageBiasWeights(personaId) {
	// 说明：
	// - wT：定向怒气权重（更偏“盯着某个人打”）
	// - wG：全局怒气权重（更偏“整体更想进攻”）
	if (personaId === "impulsive") return { wT: 1.25, wG: 1.3 };
	if (personaId === "petty") return { wT: 1.45, wG: 0.95 };
	if (personaId === "camouflage") return { wT: 0.95, wG: 0.85 };
	return { wT: 1.0, wG: 1.0 };
}

/**
 * 安全统计某区域牌数量（缺失时回退 0）。
 *
 * @param {*} player
 * @param {string} pos
 * @returns {number}
 */
function safeCountCards(player, pos) {
	if (!player || typeof player.countCards !== "function") return 0;
	try {
		const v = player.countCards(pos);
		return typeof v === "number" && !Number.isNaN(v) ? v : 0;
	} catch (e) {
		return 0;
	}
}

/**
 * 安全统计某区域内某牌名数量（缺失时回退 0）。
 *
 * @param {*} player
 * @param {string} pos
 * @param {string} name
 * @returns {number}
 */
function safeCountCardsByName(player, pos, name) {
	if (!player || typeof player.countCards !== "function") return 0;
	if (typeof name !== "string" || !name) return 0;
	try {
		const v = player.countCards(pos, name);
		return typeof v === "number" && !Number.isNaN(v) ? v : 0;
	} catch (e) {
		return 0;
	}
}

/**
 * 安全读取某区域卡牌列表（缺失时回退空数组）。
 *
 * @param {*} player
 * @param {string} pos
 * @returns {any[]}
 */
function safeGetCards(player, pos) {
	if (!player || typeof player.getCards !== "function") return [];
	try {
		const arr = player.getCards(pos);
		return Array.isArray(arr) ? arr : [];
	} catch (e) {
		return [];
	}
}

/**
 * 安全读取 get.threaten（嘲讽/威胁度，缺失时回退 1）。
 *
 * @param {*} get
 * @param {*} target
 * @param {*|undefined|null} viewer
 * @returns {number}
 */
function safeGetThreaten(get, target, viewer) {
	if (!target || typeof get?.threaten !== "function") return 1;
	try {
		const v = get.threaten(target, viewer);
		return typeof v === "number" && !Number.isNaN(v) ? v : 1;
	} catch (e) {
		try {
			const v = get.threaten(target);
			return typeof v === "number" && !Number.isNaN(v) ? v : 1;
		} catch (e2) {
			return 1;
		}
	}
}

/**
 * 安全读取卡牌颜色（缺失时回退空字符串）。
 *
 * @param {*} card
 * @param {*} get
 * @returns {string}
 */
function safeGetColor(card, get) {
	if (!card) return "";
	if (typeof get?.color === "function") {
		try {
			const v = get.color(card);
			return typeof v === "string" ? v : "";
		} catch (e) {
			// ignore
		}
	}
	return typeof card.color === "string" ? card.color : "";
}

/**
 * 安全读取卡牌 nature 列表（缺失时回退空数组）。
 *
 * @param {*} card
 * @param {*} get
 * @returns {string[]}
 */
function safeGetNatureList(card, get) {
	if (!card) return [];
	if (typeof get?.natureList === "function") {
		try {
			const arr = get.natureList(card);
			return Array.isArray(arr) ? arr.map(x => String(x || "")).filter(Boolean) : [];
		} catch (e) {
			// ignore
		}
	}
	const n = card.nature;
	if (typeof n === "string") return [n];
	if (Array.isArray(n)) return n.map(x => String(x || "")).filter(Boolean);
	return [];
}

/**
 * 获取【杀】的“保留层级”（越稀有越应保留）。
 *
 * 规则：火杀 > 雷杀 > 红杀 > 黑杀。
 *
 * @param {*} card
 * @param {*} get
 * @returns {"fire"|"thunder"|"red"|"black"|"unknown"}
 */
function getShaTier(card, get) {
	if (!card) return "unknown";
	if (String(card?.name || "") !== "sha") return "unknown";
	const natures = safeGetNatureList(card, get);
	if (natures.includes("fire")) return "fire";
	if (natures.includes("thunder")) return "thunder";
	const color = safeGetColor(card, get);
	if (color === "red") return "red";
	if (color === "black") return "black";
	return "unknown";
}

/**
 * 判断玩家是否处于“铁索/横置”（linked）状态。
 *
 * @param {*} player
 * @returns {boolean}
 */
function isLinked(player) {
	if (!player) return false;
	if (typeof player.isLinked === "function") {
		try {
			return !!player.isLinked();
		} catch (e) {
			// ignore
		}
	}
	if (player.classList && typeof player.classList.contains === "function") {
		try {
			return player.classList.contains("linked");
		} catch (e) {
			// ignore
		}
	}
	return false;
}

/**
 * 安全获取卡牌 info（缺失时回退 null）。
 *
 * @param {*} card
 * @param {*} get
 * @returns {any|null}
 */
function safeGetInfo(card, get) {
	if (!card || typeof get?.info !== "function") return null;
	try {
		return get.info(card) || null;
	} catch (e) {
		return null;
	}
}

/**
 * 安全读取“手牌上限”（缺失时回退为 hp）。
 *
 * @param {*} player
 * @returns {number}
 */
function safeGetHandcardLimit(player) {
	if (!player) return 0;
	if (typeof player.getHandcardLimit === "function") {
		try {
			const v = player.getHandcardLimit();
			if (typeof v === "number" && !Number.isNaN(v)) return v;
		} catch (e) {
			// ignore
		}
	}
	// fallback：大多数规则下手牌上限≈当前体力
	const hp = typeof player.hp === "number" && !Number.isNaN(player.hp) ? player.hp : 0;
	return hp;
}

/**
 * 计算玩家“存牌能力”相关指标。
 *
 * - keepable：按手牌上限截断后，理论上可在弃牌阶段后留住的手牌数量
 * - overflow：超过手牌上限的手牌数量（不稳定资源，权重应更低）
 *
 * @param {*} player
 * @returns {{hand:number, limit:number, keepable:number, overflow:number}}
 */
function getHandStorageInfo(player) {
	const hand = safeCountCards(player, "h");
	const rawLimit = safeGetHandcardLimit(player);
	const limit = typeof rawLimit === "number" && !Number.isNaN(rawLimit) ? Math.max(0, rawLimit) : 0;
	const keepable = Math.min(hand, limit);
	const overflow = Math.max(0, hand - limit);
	return { hand, limit, keepable, overflow };
}

/**
 * 安全读取玩家 phaseNumber（其回合开始计数）。
 *
 * @param {*} player
 * @returns {number|null}
 */
function safeGetPhaseNumber(player) {
	if (!player) return null;
	const v = player.phaseNumber;
	return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

/**
 * 安全读取 get.tag(card, tag)（卡牌 AI 标签）。
 *
 * @param {*} card
 * @param {string} tag
 * @param {*} get
 * @returns {boolean}
 */
function safeGetCardAiTag(card, tag, get) {
	if (!card || typeof get?.tag !== "function") return false;
	try {
		return !!get.tag(card, tag);
	} catch (e) {
		return false;
	}
}

/**
 * 读取本局“酒：先喝酒再找牌”的行为习惯（缺失时回退 conservative）。
 *
 * @param {*} player
 * @returns {"heuristic"|"conservative"}
 */
function getJiuSearchShaHabit(player) {
	const v = player?.storage?.[STORAGE_KEY]?.memory?.habits?.jiuSearchSha;
	return v === "heuristic" || v === "conservative" ? v : "conservative";
}

/**
 * 安全读取技能 info（缺失时回退 null）。
 *
 * @param {string} skill
 * @param {*} get
 * @returns {any|null}
 */
function safeGetSkillInfo(skill, get) {
	if (typeof skill !== "string" || !skill) return null;
	return safeGetInfo(skill, get);
}

/**
 * 安全读取 player.hasSkillTag(...)（异常/缺失时回退 false）。
 *
 * @param {*} player
 * @param {string} tag
 * @param {*} [hidden]
 * @param {*} [arg]
 * @param {boolean} [globalskill]
 * @returns {boolean}
 */
function safeHasSkillTag(player, tag, hidden, arg, globalskill) {
	if (!player || typeof player.hasSkillTag !== "function") return false;
	try {
		return !!player.hasSkillTag(tag, hidden, arg, globalskill);
	} catch (e) {
		return false;
	}
}

/**
 * 安全获取玩家技能列表（包含 invisible/hidden；不含装备）。
 *
 * @param {*} player
 * @returns {string[]}
 */
function safeGetPlayerSkillIds(player) {
	if (!player || typeof player.getSkills !== "function") return [];
	try {
		const list = player.getSkills("invisible", false, false) || [];
		if (Array.isArray(list)) return list.map(x => String(x || "")).filter(Boolean);
	} catch (e) {
		// ignore
	}
	try {
		const list = player.getSkills() || [];
		if (Array.isArray(list)) return list.map(x => String(x || "")).filter(Boolean);
	} catch (e) {
		// ignore
	}
	return [];
}

/**
 * 判断某角色是否可能属于“卖血型目标”。
 *
 * 说明：
 * - 兼容引擎内置 tag：`maixie/maixie_defend/maixie_hp`
 * - 兼容扩展自定义 tag：`slqj_ai_maixie/slqj_ai_passive_maixie/slqj_ai_active_maixie`
 *
 * @param {*} target
 * @returns {boolean}
 */
function isMaixieLikeTarget(target) {
	return (
		safeHasSkillTag(target, "maixie") ||
		safeHasSkillTag(target, "maixie_defend") ||
		safeHasSkillTag(target, "maixie_hp") ||
		safeHasSkillTag(target, TAG_MAIXIE) ||
		safeHasSkillTag(target, TAG_PASSIVE_MAIXIE) ||
		safeHasSkillTag(target, TAG_ACTIVE_MAIXIE)
	);
}

/**
 * 判断一次 chooseTarget 决策是否“更像伤害/失去体力”语义（用于卖血收益门槛）。
 *
 * @param {*} event
 * @param {*} get
 * @returns {boolean}
 */
function isDamageLikeChooseTargetEvent(event, get) {
	const card = findEventCard(event);
	if (card) {
		if (safeGetCardAiTag(card, "damage", get) || safeGetCardAiTag(card, "loseHp", get)) return true;
		const name = String(card?.name || card?.viewAs || "");
		if (
			name === "sha" ||
			name === "juedou" ||
			name === "huogong" ||
			name === "nanman" ||
			name === "wanjian" ||
			name === "shandian" ||
			name === "fulei"
		) {
			return true;
		}
		return false;
	}

	const skill = typeof event?.skill === "string" ? String(event.skill || "") : "";
	if (!skill) return false;
	const info = safeGetSkillInfo(skill, get);
	const ai = info?.ai;
	if (!ai || typeof ai !== "object") return false;

	if (ai[TAG_DAMAGE_OTHER]) return true;
	// 兼容少量技能直接声明 ai.tag.damage/loseHp
	const tag = ai.tag;
	if (tag && typeof tag === "object") {
		try {
			if (!!tag.damage || !!tag.loseHp) return true;
		} catch (e) {
			// ignore
		}
	}
	return false;
}

/**
 * 估算“卖血目标在受到伤害/失去体力后获得的收益强度”（轻量启发式）。
 *
 * 设计目标：
 * - 在进攻决策（chooseTarget）阶段避免无意义地“喂卖血”
 * - 不精确模拟技能结算，仅区分“过牌/回血/拿牌/反制伤害/控制/救援”等收益
 *
 * 规则：
 * - 仅统计同时带有卖血标记的技能，避免把目标其他无关收益技能算入
 * - 若无法识别具体收益但目标确有卖血标签，则返回保守默认值（被动≈2.0，主动≈1.0）
 *
 * @param {*} target
 * @param {*} event
 * @param {*} get
 * @returns {{isMaixie:boolean, hasPassive:boolean, reward:number}}
 */
function estimateMaixieRewardOnDamaged(target, event, get) {
	if (!target) return { isMaixie: false, hasPassive: false, reward: 0 };

	// 事件内缓存：避免同一次 chooseTarget 评分链反复扫描技能
	try {
		if (event && typeof event === "object") {
			const pid = getPid(target);
			if (pid) {
				const cache =
					event.__slqjAiMaixieRewardOnDamaged || (event.__slqjAiMaixieRewardOnDamaged = Object.create(null));
				const hit = cache[pid];
				if (hit && typeof hit === "object") {
					return {
						isMaixie: !!hit.isMaixie,
						hasPassive: !!hit.hasPassive,
						reward: typeof hit.reward === "number" && !Number.isNaN(hit.reward) ? hit.reward : 0,
					};
				}
			}
		}
	} catch (e) {
		// ignore
	}

	const isMaixie = isMaixieLikeTarget(target);
	if (!isMaixie) return { isMaixie: false, hasPassive: false, reward: 0 };

	const skillIds = safeGetPlayerSkillIds(target);
	let reward = 0;
	let hasPassive = false;

	for (const sid0 of skillIds) {
		const sid = String(sid0 || "");
		if (!sid) continue;
		const info = safeGetSkillInfo(sid, get);
		const ai = info?.ai;
		if (!ai || typeof ai !== "object") continue;

		const maixieSkill =
			!!ai.maixie ||
			!!ai.maixie_defend ||
			!!ai.maixie_hp ||
			!!ai[TAG_MAIXIE] ||
			!!ai[TAG_PASSIVE_MAIXIE] ||
			!!ai[TAG_ACTIVE_MAIXIE];

		if (!maixieSkill) continue;

		const passive =
			!!ai[TAG_PASSIVE_MAIXIE] ||
			!!ai.maixie_defend ||
			!!ai.maixie_hp ||
			(!!ai.maixie && !ai[TAG_ACTIVE_MAIXIE]);

		if (passive) hasPassive = true;

		// 主动卖血：被打不一定立刻触发收益，因此权重更低（但仍可能“配合血线/资源节奏”有价值）
		const factor = passive ? 1 : ai[TAG_ACTIVE_MAIXIE] ? 0.25 : 0.6;

		let r = 0;

		// 自身收益（更关键）
		if (ai[TAG_DRAW_SELF]) r += 2.4;
		if (ai[TAG_GAIN_OTHER_CARDS]) r += 2.0;
		if (ai[TAG_DISCARD_OTHER]) r += 1.8;
		if (ai[TAG_RECOVER_SELF]) r += 2.0;
		if (ai[TAG_DAMAGE_OTHER]) r += 1.9;
		if (ai[TAG_CONTROL_TURNOVER]) r += 1.5;
		if (ai[TAG_CONTROL_LINK]) r += 1.0;
		if (ai[TAG_REJUDGE]) r += 1.2;
		if (ai[TAG_SAVE]) r += 1.6;

		// 团队型收益：仍算“被打后赚到资源/节奏”，但权重略低
		if (ai[TAG_DRAW_OTHER]) r += 1.2;
		if (ai[TAG_GIVE_CARDS]) r += 1.0;
		if (ai[TAG_RECOVER_OTHER]) r += 1.2;

		if (r > 0) reward += r * factor;
	}

	// 若扫描不到细分收益，但确认为卖血：给保守默认值（用户假设：卖血一定有附加效果）
	if (!(reward > 0)) {
		const passiveTag =
			safeHasSkillTag(target, TAG_PASSIVE_MAIXIE) ||
			safeHasSkillTag(target, "maixie_defend") ||
			safeHasSkillTag(target, "maixie_hp") ||
			safeHasSkillTag(target, "maixie");
		hasPassive = hasPassive || passiveTag;
		reward = hasPassive ? 2.0 : 1.0;
	}

	reward = clampNumber(reward, 0, 8);

	const out = { isMaixie: true, hasPassive, reward };

	// 写入事件缓存
	try {
		if (event && typeof event === "object") {
			const pid = getPid(target);
			if (pid) {
				const cache =
					event.__slqjAiMaixieRewardOnDamaged || (event.__slqjAiMaixieRewardOnDamaged = Object.create(null));
				cache[pid] = out;
			}
		}
	} catch (e) {
		// ignore
	}

	return out;
}

/**
 * 尝试读取技能的 prompt 文案（用于“技能型过牌”启发式识别）。
 *
 * @param {string} skill
 * @param {*} info
 * @param {*} event
 * @param {*} player
 * @param {*} get
 * @returns {string}
 */
function safeGetSkillPromptText(skill, info, event, player, get) {
	if (!info) return "";
	try {
		if (typeof info.prompt === "function") {
			const v = info.prompt(event, player);
			return typeof v === "string" ? v : String(v || "");
		}
		if (typeof info.prompt === "string") return info.prompt;
	} catch (e) {
		// ignore
	}
	try {
		if (typeof info.promptfunc === "function") {
			const v = info.promptfunc(event, player);
			return typeof v === "string" ? v : String(v || "");
		}
	} catch (e) {
		// ignore
	}
	// fallback：部分技能只在翻译表里有 _info
	try {
		const key = `${skill}_info`;
		const t = typeof get?.translation === "function" ? get.translation(key) : null;
		if (typeof t === "string") return t;
	} catch (e) {
		// ignore
	}
	return "";
}

/**
 * 将常见数字表达式粗略解析为 number（仅用于启发式估算）。
 *
 * 说明：
 * - 支持：纯阿拉伯数字、`[0]` 占位、常见中文数字（含“两”）、十进位（十/二十/二十三）
 * - 不支持：X/Y/×、表达式（X+1）、“体力上限/已损失体力值”等语义数字（返回 NaN）
 *
 * @param {string} expr
 * @returns {number}
 */
function parseApproxNumber(expr) {
	const s0 = String(expr || "").trim();
	if (!s0) return NaN;
	const s = s0.replace(/\s+/g, "");

	const mBracket = /^\[(\d+)\]$/.exec(s);
	if (mBracket) return Number(mBracket[1]);

	if (/^\d+$/.test(s)) return Number(s);

	if (/^[XY×]$/.test(s)) return NaN;
	if (/[+-]/.test(s)) return NaN;

	/** @type {Record<string, number>} */
	const map = {
		零: 0,
		一: 1,
		二: 2,
		两: 2,
		三: 3,
		四: 4,
		五: 5,
		六: 6,
		七: 7,
		八: 8,
		九: 9,
	};

	if (Object.prototype.hasOwnProperty.call(map, s)) return map[s];

	if (s === "十") return 10;
	if (s.includes("十")) {
		const [a, b] = s.split("十");
		const tens = a ? map[a] : 1;
		const ones = b ? map[b] : 0;
		if (typeof tens === "number" && typeof ones === "number") return tens * 10 + ones;
		return NaN;
	}

	return NaN;
}

/**
 * 从手牌中查找指定牌名的第一张牌。
 *
 * @param {*} player
 * @param {string} name
 * @returns {*|null}
 */
function safeFindHandCardByName(player, name) {
	if (!player || typeof name !== "string" || !name) return null;
	const cards = safeGetCards(player, "h");
	for (const c of cards) {
		if (!c) continue;
		if (String(c?.name || "") === name) return c;
	}
	return null;
}

/**
 * 选取用于“连弩起爆”的诸葛连弩牌（优先已装备，其次手牌）。
 *
 * @param {*} player
 * @param {*} get
 * @returns {{card:any|null, equipped:boolean}}
 */
function pickZhugeCandidateCard(player, get) {
	const weapon = safeGetWeaponCard(player, get);
	if (weapon && String(weapon?.name || "") === "zhuge") return { card: weapon, equipped: true };
	const inHand = safeFindHandCardByName(player, "zhuge");
	if (inHand) return { card: inHand, equipped: false };
	return { card: null, equipped: false };
}

/**
 * 估算装备指定武器后是否存在“可攻击的敌对目标”（用于判定是否会卡距离）。
 *
 * 说明：
 * - 只做距离层面的轻量近似：只检查“是否有任一敌对目标在攻击范围内”
 * - 范围估算：用 `getAttackRange` 与 `getEquipRange` 拆出“技能/其他修正的增量”，再替换武器后重算
 *
 * @param {*} player
 * @param {*} weaponCard
 * @param {*} game
 * @param {*} get
 * @returns {{known:boolean, predictedRange:number, hasEnemyInRange:boolean}}
 */
function estimateEnemyInRangeAfterEquippingWeapon(player, weaponCard, game, get) {
	const out = { known: false, predictedRange: 1, hasEnemyInRange: false };
	if (!player || !weaponCard || !game) return out;

	let currentRange = 1;
	try {
		if (typeof player?.getAttackRange === "function") {
			const v = player.getAttackRange();
			if (typeof v === "number" && Number.isFinite(v)) currentRange = v;
		}
	} catch (e) {
		currentRange = 1;
	}

	let predictedRange = currentRange;

	// 若 weaponCard 就是当前已装备武器，则直接用当前攻击范围（无需模拟替换）
	const currentWeapon = safeGetWeaponCard(player, get);
	if (currentWeapon && currentWeapon === weaponCard) {
		predictedRange = currentRange;
		out.known = true;
	} else if (typeof player?.getEquipRange === "function") {
		const equipsAll = safeGetCards(player, "e");
		let equipRange = 1;
		try {
			const v = player.getEquipRange();
			if (typeof v === "number" && Number.isFinite(v)) equipRange = v;
		} catch (e) {
			equipRange = 1;
		}

		const modDelta = Number.isFinite(currentRange) ? currentRange - equipRange : 0;
		const equipsWithoutWeapon = currentWeapon ? equipsAll.filter(c => c && c !== currentWeapon) : equipsAll.slice();

		let equipRangeWithWeapon = 1;
		try {
			const v = player.getEquipRange(equipsWithoutWeapon.concat([weaponCard]));
			if (typeof v === "number" && Number.isFinite(v)) equipRangeWithWeapon = v;
		} catch (e) {
			equipRangeWithWeapon = 1;
		}

		predictedRange = equipRangeWithWeapon + (Number.isFinite(modDelta) ? modDelta : 0);
		if (!Number.isFinite(predictedRange)) predictedRange = equipRangeWithWeapon;
		predictedRange = Math.max(1, predictedRange);

		out.known = true;
	} else {
		return out;
	}

	out.predictedRange = predictedRange;

	for (const p of game.players || []) {
		if (!p || p === player) continue;
		try {
			if (typeof p.isDead === "function" && p.isDead()) continue;
		} catch (e) {
			// ignore
		}

		const att = safeAttitude(get, player, p);
		if (att >= -0.6) continue;
		const dist = safeDistance(get, player, p);
		if (!Number.isFinite(dist) || dist <= 0) continue;
		if (dist <= predictedRange + 0.001) {
			out.hasEnemyInRange = true;
			break;
		}
	}

	return out;
}

/**
 * 统计“友方（态度>0.6）手牌中的桃数量”（用于“卖血梭哈”的救援兜底门槛）。
 *
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {number}
 */
function countFriendlyTaoInHand(player, game, get) {
	if (!player || !game) return 0;
	let total = 0;
	for (const p of game.players || []) {
		if (!p || p === player) continue;
		try {
			if (typeof p.isDead === "function" && p.isDead()) continue;
		} catch (e) {
			// ignore
		}
		const att = safeAttitude(get, player, p);
		if (att <= 0.6) continue;
		total += safeCountCardsByName(p, "h", "tao");
	}
	return total;
}

/**
 * 估算主动卖血技能的“每 1 点体力可换到的牌量”（一血换二牌≈2，为小赚）。
 *
 * 说明：
 * - 仅用于“连弩起爆梭哈”判断：要求至少达到“一血换二牌”才视为值得梭哈
 * - 优先从 prompt/_info 文案中提取“失去X点体力/受伤X点 + 摸Y张牌/获得Y张牌”
 * - 若无法从文案提取，但已被标注为 `slqj_ai_draw_self`，则保守按 2 张牌估算
 *
 * @param {string} skill
 * @param {*} info
 * @param {*} player
 * @param {*} event
 * @param {*} get
 * @returns {{known:boolean, hpCost:number, cardGain:number, cardsPerHp:number}}
 */
function estimateActiveMaixieCardEconomy(skill, info, player, event, get) {
	const ai = info?.ai;
	if (!ai || typeof ai !== "object") return { known: false, hpCost: 1, cardGain: 0, cardsPerHp: 0 };
	if (!ai[TAG_ACTIVE_MAIXIE]) return { known: false, hpCost: 1, cardGain: 0, cardsPerHp: 0 };

	const promptText = safeGetSkillPromptText(skill, info, event, player, get);
	const text = String(promptText || "").replace(/\s+/g, "");

	let hpCost = 1;
	let cardGain = 0;

	// 体力代价（失去体力/受伤）
	const reLoseHp = new RegExp(String.raw`失去\\s*(${NUM})\\s*点体力`);
	const reTakeDmg = new RegExp(String.raw`受到\\s*(${NUM})\\s*点伤害`);
	const mLose = reLoseHp.exec(text);
	const mDmg = mLose ? null : reTakeDmg.exec(text);
	const costExpr = String(mLose?.[1] || mDmg?.[1] || "");
	const costNum = parseApproxNumber(costExpr);
	if (Number.isFinite(costNum) && costNum > 0) hpCost = costNum;

	// 拿牌收益（尽量取“最大数字”，兼容少量“选项/分支”文案）
	let best = NaN;
	const reDraw = new RegExp(String.raw`摸\\s*(${NUM})\\s*张牌`, "g");
	const reGain = new RegExp(String.raw`获得\\s*(${NUM})\\s*张牌`, "g");
	reDraw.lastIndex = 0;
	for (let m = reDraw.exec(text); m; m = reDraw.exec(text)) {
		const n = parseApproxNumber(String(m[1] || ""));
		if (Number.isFinite(n) && n > 0) best = Number.isFinite(best) ? Math.max(best, n) : n;
	}
	reGain.lastIndex = 0;
	for (let m = reGain.exec(text); m; m = reGain.exec(text)) {
		const n = parseApproxNumber(String(m[1] || ""));
		if (Number.isFinite(n) && n > 0) best = Number.isFinite(best) ? Math.max(best, n) : n;
	}

	if (Number.isFinite(best) && best > 0) {
		cardGain = best;
	} else if (ai[TAG_DRAW_SELF]) {
		// 保守默认：主动卖血摸牌的典型规则（苦肉）为 1 血换 2 牌
		cardGain = 2;
	} else if (ai[TAG_GAIN_OTHER_CARDS]) {
		// 获得牌的规则差异较大，这里不强行拉高，避免误把“1 血换 1 牌”当作梭哈条件
		cardGain = 1;
	}

	const cardsPerHp = hpCost > 0 ? cardGain / hpCost : 0;
	return { known: true, hpCost, cardGain, cardsPerHp };
}

/**
 * 判断是否满足“连弩起爆前梭哈主动卖血拿牌”的条件。
 *
 * 触发思想：
 * - 主动卖血摸牌若达到“一血换二牌”及以上，越多越赚
 * - 若手里（或已装备）有【诸葛连弩】且不会卡距离，并且存在救援兜底（自己或友方有桃），则可以更激进地连续卖血拿牌
 *
 * @param {*} player
 * @param {string} skill
 * @param {*} info
 * @param {*} event
 * @param {*} game
 * @param {*} get
 * @returns {{
 *  ok:boolean,
 *  economy: ReturnType<typeof estimateActiveMaixieCardEconomy>,
 *  zhugeEquipped:boolean,
 *  predictedRange:number,
 *  selfTao:number,
 *  allyTao:number,
 * }}
 */
function getActiveMaixieZhugeAllInContext(player, skill, info, event, game, get) {
	const empty = {
		ok: false,
		economy: { known: false, hpCost: 1, cardGain: 0, cardsPerHp: 0 },
		zhugeEquipped: false,
		predictedRange: 1,
		selfTao: 0,
		allyTao: 0,
	};
	if (!player || !info || !game) return empty;
	const ai = info?.ai;
	if (!ai || typeof ai !== "object") return empty;
	if (!ai[TAG_ACTIVE_MAIXIE]) return empty;

	// 事件内缓存：避免同一次 chooseCard/chooseButton 评分链反复扫描（计数桃、估算卡距离等）。
	const pid = getPid(player);
	const key = pid ? `${pid}|${String(skill || "")}` : "";
	try {
		if (event && typeof event === "object" && key) {
			const cache =
				event.__slqjAiActiveMaixieZhugeAllInContext ||
				(event.__slqjAiActiveMaixieZhugeAllInContext = Object.create(null));
			const hit = cache[key];
			if (hit && typeof hit === "object") return hit;
		}
	} catch (e) {
		// ignore
	}

	/**
	 * @param {ReturnType<typeof getActiveMaixieZhugeAllInContext>} out
	 * @returns {ReturnType<typeof getActiveMaixieZhugeAllInContext>}
	 */
	function writeCache(out) {
		try {
			if (event && typeof event === "object" && key) {
				const cache =
					event.__slqjAiActiveMaixieZhugeAllInContext ||
					(event.__slqjAiActiveMaixieZhugeAllInContext = Object.create(null));
				cache[key] = out;
			}
		} catch (e) {
			// ignore
		}
		return out;
	}

	// 若自己被禁杀，则“连弩爆发”逻辑不成立
	if (safeHasSkillTag(player, TAG_FORBID_SHA)) return writeCache(empty);

	const economy = estimateActiveMaixieCardEconomy(skill, info, player, event, get);
	if (!(economy.cardsPerHp >= 1.95)) return writeCache(Object.assign({}, empty, { economy }));

	const selfTao = safeCountCardsByName(player, "h", "tao");
	const allyTao = countFriendlyTaoInHand(player, game, get);
	if (!(selfTao > 0 || allyTao > 0)) return writeCache(Object.assign({}, empty, { economy, selfTao, allyTao }));

	const z = pickZhugeCandidateCard(player, get);
	if (!z.card) return writeCache(Object.assign({}, empty, { economy, selfTao, allyTao }));

	const r = estimateEnemyInRangeAfterEquippingWeapon(player, z.card, game, get);
	if (!r.known || !r.hasEnemyInRange) {
		return writeCache(
			Object.assign({}, empty, {
				economy,
				zhugeEquipped: !!z.equipped,
				predictedRange: r.predictedRange,
				selfTao,
				allyTao,
			})
		);
	}

	return writeCache({
		ok: true,
		economy,
		zhugeEquipped: !!z.equipped,
		predictedRange: r.predictedRange,
		selfTao,
		allyTao,
	});
}

/**
 * 判断是否存在“杀盟友开路 -> 杀下家敌人”的爆发线（非常激进）。
 *
 * 规则（轻量启发式）：
 * - 你的下家为“盟友”（att>0.6），其下家为“敌人”（att<-0.6）
 * - 你当前无法对该敌人出【杀】（大概率因距离），且预计“打掉盟友后距离降低 1”即可出杀
 * - 你具备多次出【杀】能力（诸葛连弩/无限杀/额外杀），且手里【杀】数量足够覆盖“击杀盟友 + 击杀敌人”
 *
 * @param {*} player
 * @param {*} shaCard
 * @param {*} game
 * @param {*} get
 * @returns {{
 *  ok:boolean,
 *  ally:any|null,
 *  enemy:any|null,
 *  shaCount:number,
 *  needSha:number,
 *  zhugeEquipped:boolean,
 * }}
 */
function getFriendlyFireOpenPathContext(player, shaCard, game, get) {
	const empty = { ok: false, ally: null, enemy: null, shaCount: 0, needSha: 0, zhugeEquipped: false };
	if (!player || !shaCard || !game) return empty;
	if (String(shaCard?.name || shaCard?.viewAs || "") !== "sha") return empty;

	const ally = getNextAlivePlayer(player, game);
	if (!ally || ally === player) return empty;

	// 保守：身份局不考虑“杀主公开路”（太离谱）；其他模式交给态度/局势约束
	if (get?.mode?.() === "identity") {
		const zhu = game?.zhu;
		if (zhu && ally === zhu) return empty;
	}

	const enemy = getNextAlivePlayer(ally, game);
	if (!enemy || enemy === player || enemy === ally) return empty;

	const attAlly = safeAttitude(get, player, ally);
	const attEnemy = safeAttitude(get, player, enemy);
	if (!(attAlly > 0.6 && attEnemy < -0.6)) return empty;

	// 仅处理“盟友把敌人隔开”的典型座次：player->ally->enemy
	if (getTurnOrderDistance(player, ally, game) !== 1) return empty;
	if (getTurnOrderDistance(player, enemy, game) !== 2) return empty;

	// 已能直接打到敌人则不需要开路
	let canHitEnemyNow = false;
	try {
		if (typeof player.canUse === "function") canHitEnemyNow = !!player.canUse(shaCard, enemy);
	} catch (e) {
		canHitEnemyNow = false;
	}
	if (canHitEnemyNow) return empty;

	// 预计“杀掉盟友后距离-1即可够到”：当前距离应当只差 1
	let attackRange = 1;
	try {
		if (typeof player.getAttackRange === "function") {
			const v = player.getAttackRange();
			if (typeof v === "number" && Number.isFinite(v)) attackRange = v;
		}
	} catch (e) {
		attackRange = 1;
	}
	const distNow = safeDistance(get, player, enemy);
	if (!Number.isFinite(distNow) || distNow <= 0) return empty;
	if (!(distNow > attackRange + 0.001)) return empty;
	if (!(distNow <= attackRange + 1.05)) return empty;

	// 多杀能力：诸葛连弩 / 无限杀 / 额外杀
	const weapon = safeGetWeaponCard(player, get);
	const zhugeEquipped = !!weapon && String(weapon?.name || "") === "zhuge";
	const shaUnlimited = safeHasSkillTag(player, TAG_SHA_UNLIMITED);
	const shaExtra = safeHasSkillTag(player, TAG_SHA_EXTRA);
	const hasUnlimited = zhugeEquipped || shaUnlimited;
	const hasAtLeastTwo = hasUnlimited || shaExtra;
	if (!hasAtLeastTwo) return Object.assign({}, empty, { ally, enemy, zhugeEquipped });

	// 若已用过杀且没有“无限杀”，则很难再完成“击杀盟友+击杀敌人”的两段线
	const cardHist = safeGetPhaseUseCardHistory(player);
	const usedSha = cardHist.some(ev => String(ev?.card?.name || ev?.cards?.[0]?.name || "") === "sha");
	if (usedSha && !hasUnlimited) {
		return Object.assign({}, empty, { ally, enemy, zhugeEquipped });
	}

	// 杀够多：至少覆盖“击杀盟友 + 击杀敌人”
	const allyHp = typeof ally.hp === "number" && !Number.isNaN(ally.hp) ? Math.max(0, ally.hp) : 0;
	const enemyHp = typeof enemy.hp === "number" && !Number.isNaN(enemy.hp) ? Math.max(0, enemy.hp) : 0;
	const needSha = Math.max(2, allyHp + Math.max(1, enemyHp));
	const shaCount = safeCountCardsByName(player, "h", "sha");

	// 若仅“额外杀”而没有“无限杀/连弩”，则最多只假设可再多出 1 次杀：仅支持 needSha==2 的极小场景
	if (!hasUnlimited && shaExtra && needSha > 2) return { ok: false, ally, enemy, shaCount, needSha, zhugeEquipped };
	if (!(shaCount >= needSha)) return { ok: false, ally, enemy, shaCount, needSha, zhugeEquipped };

	// 若当前仍有其他可打到的敌人，则不建议先杀盟友开路（除非后续再加更细策略）
	for (const p of game.players || []) {
		if (!p || p === player || p === ally || p === enemy) continue;
		try {
			if (typeof p.isDead === "function" && p.isDead()) continue;
		} catch (e) {
			// ignore
		}
		if (safeAttitude(get, player, p) >= -0.6) continue;
		try {
			if (typeof player.canUse === "function" && player.canUse(shaCard, p)) {
				return { ok: false, ally, enemy, shaCount, needSha, zhugeEquipped };
			}
		} catch (e) {
			// ignore
		}
	}

	return { ok: true, ally, enemy, shaCount, needSha, zhugeEquipped };
}

/**
 * 判断一次 chooseTarget 事件是否属于“救援/回复”语义（用于“刚刚攻击的人我不救”门槛）。
 *
 * 说明：
 * - 濒死求救通常走 `chooseToUse`（`event.type==="dying"`），此时事件本身未必已写入 `event.card`
 *   （牌面往往只体现在 `get.card()`），因此这里需要对 `type==="dying"` 做显式兜底。
 *
 * @param {*} event
 * @param {*} player
 * @param {*} get
 * @returns {boolean}
 */
function isRescueLikeChooseTargetEvent(event, player, get) {
	// 濒死求救：一定属于“救援/回复”语义（即便事件尚未写入 event.card）
	if (String(event?.type || "") === "dying" || !!event?.dying) return true;

	const card = findEventCard(event);
	const selected = !card && typeof get?.card === "function" ? get.card() : null;
	const currentCard = card || selected;
	if (currentCard) {
		if (isTaoCard(currentCard)) return true;
		if (
			safeGetCardAiTag(currentCard, "save", get) ||
			safeGetCardAiTag(currentCard, "recover", get)
		)
			return true;
	}

	const skill = typeof event?.skill === "string" ? String(event.skill || "") : "";
	if (!skill) return false;
	const info = safeGetSkillInfo(skill, get);

	// 优先：ai.tag（技能可能声明 recover/save 等标签）
	const tag = info?.ai?.tag;
	if (tag) {
		if (Array.isArray(tag)) {
			if (tag.includes("recover") || tag.includes("save")) return true;
		} else if (typeof tag === "string") {
			const s = tag;
			if (s === "recover" || s === "save") return true;
			if (s.includes("recover") || s.includes("save")) return true;
		} else if (typeof tag === "object") {
			if (tag.recover || tag.save) return true;
		}
	}

	// 回退：看 prompt 文案（尽力而为）
	const promptText = safeGetSkillPromptText(skill, info, event, player, get);
	const text = String(promptText || "");
	return text.includes("回复") || text.includes("救");
}

/**
 * 判断一次 chooseBool（通常来自 chooseUseTarget 的“是否使用”询问）是否需要触发
 * 「刚刚被我攻击的人我不救」硬门槛。
 *
 * 说明：
 * - 典型场景：濒死阶段使用【桃】（【桃】常见为 `selectTarget:-1`，引擎会走 chooseBool 分支）
 * - 仅在存在 chooseUseTarget 父事件时才生效，避免误伤其他“是否”确认
 *
 * @param {*} chooseBoolEvent
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
export function shouldForbidRescueRecentAttackInChooseBool(chooseBoolEvent, player, game, get) {
	if (!chooseBoolEvent || !player || !game) return false;

	const recent = player?.storage?.[STORAGE_KEY]?.runtime?.recentAttack;
	if (!recent || !recent.targetPid) return false;

	// 仅 gate chooseUseTarget -> chooseBool 的救援询问（典型：濒死用桃）
	let useEvt = null;
	try {
		useEvt = typeof chooseBoolEvent.getParent === "function" ? chooseBoolEvent.getParent("chooseUseTarget") : null;
	} catch (e) {
		useEvt = null;
	}
	if (!useEvt) return false;

	// 只对“救援/回复”语义生效
	if (!isRescueLikeChooseTargetEvent(useEvt, player, get)) return false;

	// 在 chooseUseTarget 中，目标可能写入 targets2（筛选后的候选）或 targets（默认全体）
	const candidates =
		Array.isArray(useEvt.targets2) && useEvt.targets2.length ? useEvt.targets2 : Array.isArray(useEvt.targets) ? useEvt.targets : [];
	if (!candidates.length) return false;

	for (const t of candidates) {
		if (!t) continue;
		if (getPid(t) === recent.targetPid) return true;
	}
	return false;
}

/**
 * 判断一次 chooseBool（通常来自 chooseUseTarget 的“是否使用”询问）是否需要触发
 * 「主公首轮全暗：群攻可直接使用」影响。
 *
 * 说明：
 * - 典型场景：【南蛮入侵】/【万箭齐发】等 selectTarget:-1 的群攻牌在 chooseUseTarget 中会走 chooseBool 分支
 * - 该影响只在“主公首轮且全场无人暴露身份（全暗）”时生效：用于试探信息，不按纯收益计算
 *
 * @param {*} chooseBoolEvent
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
export function shouldForceZhuRound1AoeProbeInChooseBool(chooseBoolEvent, player, game, get) {
	if (!chooseBoolEvent || !player || !game) return false;
	if (get?.mode?.() !== "identity") return false;
	if (!isZhuRoundOneAllHidden(player, game)) return false;

	let useEvt = null;
	try {
		useEvt = typeof chooseBoolEvent.getParent === "function" ? chooseBoolEvent.getParent("chooseUseTarget") : null;
	} catch (e) {
		useEvt = null;
	}
	if (!useEvt) return false;

	// 仅对“主动出牌阶段”的是否使用确认生效
	if (!isPhaseUseContext(useEvt) && !isPhaseUseContext(chooseBoolEvent)) return false;

	const card = findEventCard(useEvt) || findEventCard(chooseBoolEvent);
	if (!card) return false;

	const isAoeDamage =
		safeGetCardAiTag(card, "damage", get) &&
		safeGetCardAiTag(card, "multitarget", get) &&
		safeGetCardAiTag(card, "multineg", get);
	if (isAoeDamage) return true;

	// 兜底：少量情况下 tag 解析失败时回退牌名
	const name = String(card?.name || card?.viewAs || "");
	return name === "nanman" || name === "wanjian";
}

/**
 * 尝试读取技能 ai.result.player（number/function），失败回退 0。
 *
 * @param {*} info
 * @param {*} player
 * @returns {number}
 */
function safeGetSkillAiResultPlayer(info, player) {
	const rp = info?.ai?.result?.player;
	if (typeof rp === "number" && !Number.isNaN(rp)) return rp;
	if (typeof rp === "function") {
		try {
			const v = rp(player);
			return typeof v === "number" && !Number.isNaN(v) ? v : 0;
		} catch (e) {
			return 0;
		}
	}
	return 0;
}

/**
 * 尝试读取技能 ai.result.target_use/target（number/function），失败回退 0。
 *
 * @param {*} info
 * @param {*} player
 * @param {*} target
 * @returns {number}
 */
function safeGetSkillAiResultTarget(info, player, target) {
	const rt = info?.ai?.result?.target_use ?? info?.ai?.result?.target;
	if (typeof rt === "number" && !Number.isNaN(rt)) return rt;
	if (typeof rt === "function") {
		try {
			const v = rt(player, target);
			return typeof v === "number" && !Number.isNaN(v) ? v : 0;
		} catch (e) {
			return 0;
		}
	}
	return 0;
}

/**
 * 尝试判定当前事件对目标的 target_use 数值结果。
 *
 * - 优先：用 card + get.result 计算（覆盖绝大多数用牌/视为牌场景）
 * - 回退：无 card 时读取 skill 的 ai.result.target_use/target
 * - 约定：<0 视为“有害”，>0 视为“有益”，0 表示无法判定或无差别
 *
 * @param {*} player
 * @param {*} target
 * @param {*} event
 * @param {*} get
 * @returns {number}
 */
function getTargetUseValueFromEvent(player, target, event, get) {
	if (!player || !target) return 0;
	const card = findEventCard(event);
	if (card) return getResultNumberForTarget(card, event?.skill, player, target, get);
	const skill = event?.skill;
	if (typeof skill !== "string" || !skill) return 0;
	const info = safeGetSkillInfo(skill, get);
	if (!info) return 0;
	return safeGetSkillAiResultTarget(info, player, target);
}

/**
 * 判断技能是否更像“过牌/确立资源”的主动技能。
 *
 * 规则（启发式，容忍少量误判）：
 * - 首选：技能定义了 `ai.tag.draw|gain`
 * - 兜底：从 prompt 文案提取“摸牌/获得牌/观看牌堆顶/重铸”等信号
 * - 再兜底：若技能为“无目标主动技”且 `ai.result.player` 明显为正，也视为过牌类候选
 *
 * @param {string} skill
 * @param {*} player
 * @param {*} event
 * @param {*} get
 * @returns {boolean}
 */
function isDrawLikeSkill(skill, player, event, get) {
	if (typeof skill !== "string" || !skill) return false;

	// 优先：ai.tag（部分技能会直接声明 draw/gain 标签）
	if (safeGetCardAiTag(skill, "draw", get) || safeGetCardAiTag(skill, "gain", get)) return true;

	const info = safeGetSkillInfo(skill, get);
	if (!info) return false;
	// 只把“主动可用技能”当作候选，避免触发技干扰（触发技不应参与“先过牌”的决策节奏）
	if (!info.enable) return false;

	const promptText = safeGetSkillPromptText(skill, info, event, player, get);
	const text = String(promptText || "").replace(/\s+/g, "");
	if (text) {
		// 关键字：重铸/摸牌/获得牌/观星类（看顶/看牌堆顶）
		if (text.includes("重铸")) return true;
		if ((text.includes("摸") || text.includes("抽")) && text.includes("牌")) return true;
		if (text.includes("获得") && text.includes("牌")) return true;
		if (text.includes("观看") && text.includes("牌")) return true;
		if (text.includes("牌堆顶")) return true;
		if (text.includes("交换") && text.includes("牌")) return true;
	}

	// 再兜底：无目标主动技 + ai.result.player 明显为正（很多“制衡/苦肉类”会落在这里）
	const hasTarget = typeof info.filterTarget === "function" || (info.selectTarget !== undefined && info.selectTarget !== null);
	if (hasTarget) return false;
	const aiRes = safeGetSkillAiResultPlayer(info, player);
	return aiRes > 0.6;
}

/**
 * 判断候选项是否属于“过牌（确立资源）”类型：卡牌或技能。
 *
 * @param {*} candidate
 * @param {*} player
 * @param {*} event
 * @param {*} get
 * @returns {boolean}
 */
function isDrawLikeCandidate(candidate, player, event, get) {
	if (!candidate) return false;
	if (typeof candidate === "string") return isDrawLikeSkill(candidate, player, event, get);
	if (typeof get?.itemtype === "function" && get.itemtype(candidate) !== "card") return false;
	return safeGetCardAiTag(candidate, "draw", get);
}

/**
 * 计算“回合顺序距离”（从 from 到 to 需要经过多少名存活玩家）。
 *
 * - dist=1 表示“下家/马上行动的人”
 * - dist 越小，表示越快进入其回合（更容易把资源转化为即时收益）
 *
 * @param {*} from
 * @param {*} to
 * @param {*} game
 * @returns {number} 0..n-1；失败时回退 Infinity
 */
function getTurnOrderDistance(from, to, game) {
	if (!from || !to || !game) return Infinity;
	const players = Array.isArray(game.players) ? game.players : [];
	const alive = players.filter(p => {
		if (!p) return false;
		try {
			if (typeof p.isDead === "function" && p.isDead()) return false;
		} catch (e) {
			// ignore
		}
		return true;
	});
	const n = alive.length;
	if (n <= 1) return Infinity;
	const iFrom = alive.indexOf(from);
	const iTo = alive.indexOf(to);
	if (iFrom < 0 || iTo < 0) return Infinity;
	return (iTo - iFrom + n) % n;
}

/**
 * 取得某角色的“顺时针下家”（下一名存活玩家）。
 *
 * @param {*} from
 * @param {*} game
 * @returns {*|null}
 */
function getNextAlivePlayer(from, game) {
	if (!from || !game) return null;
	const players = Array.isArray(game.players) ? game.players : [];
	const alive = players.filter(p => {
		if (!p) return false;
		try {
			if (typeof p.isDead === "function" && p.isDead()) return false;
		} catch (e) {
			// ignore
		}
		return true;
	});
	const n = alive.length;
	if (n <= 1) return null;
	const idx = alive.indexOf(from);
	if (idx < 0) return null;
	return alive[(idx + 1) % n] || null;
}

/**
 * 判断目标在“本轮（以 phaseNumber 近似）”是否还未行动。
 *
 * 解释：当某玩家回合开始时，其 phaseNumber 会 +1；因此在当前玩家的回合内，若目标的 phaseNumber
 * 小于当前玩家，通常表示目标在这一轮转中还没进入过回合（更可能“好牌多、没展开”）。
 *
 * @param {*} actor 当前行动者
 * @param {*} target 候选目标
 * @returns {boolean}
 */
function hasNotActedYetThisRound(actor, target) {
	const a = safeGetPhaseNumber(actor);
	const t = safeGetPhaseNumber(target);
	if (a === null || t === null) return false;
	return t < a;
}

/**
 * 判断是否为“主公首轮且全场无人暴露身份（全暗）”的局面。
 *
 * 说明：
 * - 该判定用于约束主公首轮在信息不足时的“盲目乱打”。
 * - “暴露”规则：`identityShown===true` 或 `ai.shown>0`（软暴露）。
 *
 * @param {*} player
 * @param {*} game
 * @returns {boolean}
 */
function isZhuRoundOneAllHidden(player, game) {
	if (!player || !game) return false;
	const id = String(player.identity || "");
	if (id !== "zhu" && !player.isZhu) return false;
	const round = typeof game?.roundNumber === "number" && !Number.isNaN(game.roundNumber) ? game.roundNumber : 0;
	if (round !== 1) return false;

	const players = Array.isArray(game.players) ? game.players : [];
	for (const p of players) {
		if (!p || p === player) continue;
		try {
			if (typeof p.isIn === "function" && !p.isIn()) continue;
		} catch (e) {
			// ignore
		}
		if (p.identityShown) return false;
		const shown = p.ai && typeof p.ai.shown === "number" && !Number.isNaN(p.ai.shown) ? p.ai.shown : 0;
		if (shown > 0) return false;
	}
	return true;
}

/**
 * 判断是否处于“出牌阶段（phaseUse）”上下文。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isPhaseUseContext(event) {
	let e = event;
	for (let i = 0; i < 8 && e; i++) {
		const name = String(e.name || "");
		if (name === "phaseUse") return true;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return false;
}

/**
 * 获取“本回合出牌阶段”主动技能使用历史（缺失时返回空数组）。
 *
 * 说明：仅统计存在 `info.enable` 的技能，避免把触发技误当作“已开始行动”。\n
 *
 * @param {*} player
 * @param {*} get
 * @returns {any[]}
 */
function safeGetPhaseUseSkillHistory(player, get) {
	if (!player || typeof player.getHistory !== "function") return [];
	try {
		const arr = player.getHistory("useSkill", evt => {
			if (!evt || typeof evt.skill !== "string") return false;
			const info = safeGetSkillInfo(evt.skill, get);
			if (!info || !info.enable) return false;
			return isPhaseUseContext(evt.event);
		});
		return Array.isArray(arr) ? arr : [];
	} catch (e) {
		return [];
	}
}

/**
 * 获取“本回合出牌阶段”已使用的卡牌历史（缺失时返回空数组）。
 *
 * @param {*} player
 * @returns {any[]}
 */
function safeGetPhaseUseCardHistory(player) {
	if (!player || typeof player.getHistory !== "function") return [];
	try {
		const arr = player.getHistory("useCard", evt => {
			try {
				return !!evt && typeof evt.isPhaseUsing === "function" && evt.isPhaseUsing(player);
			} catch (e) {
				return false;
			}
		});
		return Array.isArray(arr) ? arr : [];
	} catch (e) {
		return [];
	}
}

/**
 * 判断“当前是否在用牌选择上下文”（用于避免影响弃牌/获得等非出牌场景）。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isUseCardContext(event) {
	let e = event;
	for (let i = 0; i < 8 && e; i++) {
		const name = String(e.name || "");
		if (name === "chooseToUse" || name === "phaseUse" || name === "useCard") return true;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return false;
}

/**
 * 判断“当前是否在响应选择上下文”（chooseToRespond）。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isRespondContext(event) {
	let e = event;
	for (let i = 0; i < 8 && e; i++) {
		const name = String(e.name || "");
		if (name === "chooseToRespond") return true;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return false;
}

/**
 * 判断“当前是否在弃牌/失去手牌选择上下文”（用于“无懈可击大部分情况下比桃更关键”）。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isDiscardCardContext(event) {
	let e = event;
	for (let i = 0; i < 8 && e; i++) {
		const name = String(e.name || "");
		if (name === "chooseToDiscard" || name === "phaseDiscard" || name === "discard" || name === "discardPlayerCard") {
			return true;
		}
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return false;
}

/**
 * 判断“当前是否为无懈可击响应询问”上下文（chooseToUse(type=wuxie) 等）。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isAskWuxieEvent(event) {
	if (!event) return false;
	try {
		if (String(event.type || "") === "wuxie") return true;
	} catch (e) {
		// ignore
	}
	try {
		const c = event.card;
		if (c && String(c.name || "") === "wuxie") return true;
	} catch (e) {
		// ignore
	}
	try {
		const p = String(event.prompt || "");
		if (p.includes("无懈可击")) return true;
	} catch (e) {
		// ignore
	}
	return false;
}

/**
 * 从事件链中向上解析无懈可击的 info_map（标准库 chooseToUse(type=wuxie) 会携带）。
 *
 * @param {*} event
 * @returns {*|null}
 */
function resolveWuxieInfoMap(event) {
	let e = event;
	for (let i = 0; i < 8 && e; i++) {
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
 * 判断候选项是否为“重铸”技能（用于温和引导把无用铁索早点重铸）。
 *
 * @param {*} candidate
 * @returns {boolean}
 */
function isRecastSkillCandidate(candidate) {
	return candidate === "_recasting" || candidate === "_chongzhu";
}

/**
 * 判断“当前是否处于重铸选牌上下文”。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isRecastCardSelectContext(event) {
	let e = event;
	for (let i = 0; i < 10 && e; i++) {
		const name = String(e.name || "");
		if (name === "_recasting" || name === "_chongzhu" || name === "recast") return true;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return false;
}

/**
 * 判断玩家是否具备“可稳定触发铁索传导”的属性伤害来源（轻量启发式）。
 *
 * @param {*} player
 * @param {*} get
 * @returns {boolean}
 */
function hasElementalDamageSource(player, get) {
	if (!player) return false;

	// 1) 手牌：火攻 / 属性杀
	const hs = safeGetCards(player, "h");
	for (const c of hs) {
		const name = String(c?.name || "");
		if (name === "huogong") return true;
		if (name !== "sha") continue;

		let nature = "";
		try {
			nature = typeof get?.nature === "function" ? String(get.nature(c) || "") : String(c?.nature || "");
		} catch (e) {
			nature = "";
		}
		if (nature.includes("fire") || nature.includes("thunder")) return true;
	}

	// 2) 装备：朱雀羽扇（将杀转火杀）等
	const es = safeGetCards(player, "e");
	if (es.some(c => String(c?.name || "") === "zhuque")) return true;

	return false;
}

/**
 * 判断是否为“武器/减马”装备牌。
 *
 * - 武器：subtype === equip1
 * - 减马：subtype === equip4（标准：distance.globalFrom === -1）
 *
 * @param {*} card
 * @param {*} get
 * @returns {{kind:"weapon"|"minus_horse"}|null}
 */
function getEquipKind(card, get) {
	if (!card) return null;
	if (getCardType(card, get) !== "equip") return null;
	const info = safeGetInfo(card, get);
	const subtype = String(info?.subtype || card?.subtype || "");
	if (subtype === "equip1") return { kind: "weapon" };
	if (subtype === "equip4") return { kind: "minus_horse" };
	// 兜底：按 distance 结构识别（兼容少数包未填 subtype 的情况）
	const gf = info?.distance && typeof info.distance.globalFrom === "number" ? info.distance.globalFrom : 0;
	if (gf < 0) return { kind: "minus_horse" };
	return null;
}

/**
 * 判断“当前是否存在明确的进攻需求”（轻量近似）。
 *
 * 规则：若手牌里存在【杀】或【顺手牵羊】，且当前能对任一明显敌对目标实际使用，则认为“有进攻需求”。\n
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
function hasImmediateOffenseNeed(player, game, get) {
	if (!player || !game) return false;
	const cards = safeGetCards(player, "h");
	if (!cards.length) return false;

	let sha = null;
	let shunshou = null;
	for (const c of cards) {
		const name = String(c?.name || "");
		if (!sha && name === "sha") sha = c;
		if (!shunshou && name === "shunshou") shunshou = c;
		if (sha && shunshou) break;
	}
	if (!sha && !shunshou) return false;

	const players = Array.isArray(game.players) ? game.players : [];
	for (const p of players) {
		if (!p || p === player) continue;
		try {
			if (typeof p.isDead === "function" && p.isDead()) continue;
		} catch (e) {
			// ignore
		}
		const att = safeAttitude(get, player, p);
		if (att >= -0.6) continue;
		try {
			if (sha && typeof player.canUse === "function" && player.canUse(sha, p)) return true;
		} catch (e) {
			// ignore
		}
		try {
			if (shunshou && typeof player.canUse === "function" && player.canUse(shunshou, p)) return true;
		} catch (e) {
			// ignore
		}
	}
	return false;
}

/**
 * 安全计算两名玩家之间的距离（缺失时回退 0）。
 *
 * @param {*} get
 * @param {*} from
 * @param {*} to
 * @returns {number}
 */
function safeDistance(get, from, to) {
	if (!from || !to) return 0;
	if (typeof get?.distance === "function") {
		try {
			const v = get.distance(from, to);
			return typeof v === "number" && !Number.isNaN(v) ? v : 0;
		} catch (e) {
			// ignore
		}
	}
	if (typeof from.distanceTo === "function") {
		try {
			const v = from.distanceTo(to);
			return typeof v === "number" && !Number.isNaN(v) ? v : 0;
		} catch (e) {
			// ignore
		}
	}
	return 0;
}

/**
 * “菜刀将”启发式识别：更偏输出、倾向频繁出杀/直伤。
 *
 * 说明：此处仅用于“开局盲狙别乱狙”的保守约束，容忍一定误判。
 *
 * @param {*} player
 * @returns {boolean}
 */
function isLikelyCaidaoPlayer(player) {
	if (!player || typeof player.hasSkillTag !== "function") return false;
	try {
		// 常见输出向标签（见 tags.md）：useSha / damageBonus / directHit_ai 等
		return (
			!!player.hasSkillTag("useSha") ||
			!!player.hasSkillTag("damageBonus") ||
			!!player.hasSkillTag("directHit_ai") ||
			!!player.hasSkillTag("presha")
		);
	} catch (e) {
		return false;
	}
}

/**
 * 粗略衡量“资源/存活能力”的强弱（用于顺风/逆风判定）。
 *
 * 说明：此处为跨模式通用的轻量近似（非严格战力）。
 *
 * @param {*} player
 * @returns {number}
 */
function getPlayerPower(player) {
	if (!player) return 0;
	const hp = typeof player.hp === "number" && !Number.isNaN(player.hp) ? player.hp : 0;
	const maxHp =
		typeof player.maxHp === "number" && !Number.isNaN(player.maxHp) ? player.maxHp : hp;
	const equip = safeCountCards(player, "e");
	const judge = safeCountCards(player, "j");

	const { keepable, overflow } = getHandStorageInfo(player);

	// 通用技巧：能存住牌强过只有血量健康
	// - hp 仍是核心生存资源，但“可留住的手牌”更能代表回合外韧性与后续展开能力
	// - 溢出牌（超过上限的部分）更不稳定：可能会被迫弃置/被拆顺，因此权重更低
	const hpScore = hp + (maxHp - hp) * 0.15;
	const keepableScore = keepable * 0.85;
	const overflowScore = overflow * 0.25;
	const equipScore = equip * 0.3;
	const judgePenalty = judge * 0.25;
	return hpScore + keepableScore + overflowScore + equipScore - judgePenalty;
}

/**
 * 计算“局势指数”（顺风>0，逆风<0），用于把「顺风求稳，逆风求变」落到评分调节上。
 *
 * 规则（跨模式通用）：
 * 1) 若可从态度推断阵营关系（存在明显的友/敌），则用“我方(含自己) vs 敌方(含中立折算)”的强弱差；
 * 2) 否则回退为“自己 vs 其他人平均强度”的差。
 *
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {number} [-1, 1]
 */
function getSituationIndex(player, game, get) {
	if (!player || !game) return 0;
	const players = Array.isArray(game.players) ? game.players : [];
	const alive = players.filter(p => {
		if (!p) return false;
		try {
			if (typeof p.isDead === "function" && p.isDead()) return false;
		} catch (e) {
			// ignore
		}
		return true;
	});
	if (!alive.length) return 0;

	const selfPower = getPlayerPower(player);

	let allyPower = selfPower;
	let enemyPower = 0;
	let neutralPower = 0;
	let allyCount = 1;
	let enemyCount = 0;
	let neutralCount = 0;

	for (const p of alive) {
		if (!p || p === player) continue;
		const att = safeAttitude(get, player, p);
		const pw = getPlayerPower(p);
		if (att > 0.6) {
			allyPower += pw;
			allyCount++;
			continue;
		}
		if (att < -0.6) {
			enemyPower += pw;
			enemyCount++;
			continue;
		}
		neutralPower += pw;
		neutralCount++;
	}

	// 优先按“可判定的友/敌”做队伍化近似（中立按 0.6 折算到敌方，偏保守）
	if (allyCount > 1 || enemyCount > 0) {
		const opp = enemyPower + neutralPower * 0.6;
		const sum = allyPower + opp;
		if (sum <= 0) return 0;
		return clampNumber((allyPower - opp) / sum, -1, 1);
	}

	// 回退：按“自己 vs 其他人平均”衡量
	const others = alive.filter(p => p && p !== player);
	if (!others.length) return 0;
	const avg = others.reduce((s, p) => s + getPlayerPower(p), 0) / others.length;
	const denom = Math.max(1, Math.abs(avg));
	return clampNumber((selfPower - avg) / denom, -1, 1);
}

/**
 * 安装扩展默认策略（通过 `slqj_ai_score` hook 对选择评分做保守约束/门槛）。
 *
 * @param {{game:any, get:any, _status:any}} param0
 * @returns {void}
 */
export function installDefaultScoreHooks({ game, get, _status }) {
	if (!game || !game.__slqjAiPersona) return;
	const hooks = game.__slqjAiPersona.hooks;
	if (!hooks || typeof hooks.on !== "function") return;

	// 身份局经验：远位菜刀将大概率忠，开局盲狙别乱狙（降低“开局对远位输出将随意下手”的评分）
	if (!game.__slqjAiPersona._openingBlindSnipeHookInstalled) {
		game.__slqjAiPersona._openingBlindSnipeHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (get?.mode?.() !== "identity") return;
				const round = typeof game?.roundNumber === "number" ? game.roundNumber : 0;
				if (round > 2) return;

				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target) return;
				if (typeof get?.itemtype === "function" && get.itemtype(target) !== "player") return;

				// 仅约束“盲狙”：目标未明置，且软暴露不高
				if (target.identityShown) return;
				const shown = target.ai && typeof target.ai.shown === "number" ? target.ai.shown : 0;
				if (shown >= 0.85) return;

				// 仅针对“有害行为”（对目标收益为负）
				const card = findEventCard(ctx.event);
				const tv = getResultNumberForTarget(card, ctx.event?.skill, player, target, get);
				if (tv >= 0) return;

				// 远位：距离>=2（不同人数/座次下差异较大，这里按保守阈值处理）
				const dist = safeDistance(get, player, target);
				if (dist < 2) return;

				// 菜刀将：输出向标签
				if (!isLikelyCaidaoPlayer(target)) return;

				// 若当前态度已非常敌对（信息较明确），不做约束
				const att = safeAttitude(get, player, target);
				if (att < -3.5) return;

				const id = String(player.identity || "");
				const idScale = id === "fan" ? 1.1 : id === "zhong" || id === "mingzhong" || id === "zhu" ? 1 : 0.95;
				const dScale = clampNumber((dist - 1) / 3, 0, 1);
				const penalty = (0.65 + 0.85 * dScale) * idScale;
				ctx.score -= penalty;
			},
			{ priority: 6 }
		);
	}

	// 身份局经验：首轮尽量避免把“未明置身份目标”同回合盲打到死（降低盲打连击/收割倾向）
	if (!game.__slqjAiPersona._round1BlindOverkillGuardHookInstalled) {
		game.__slqjAiPersona._round1BlindOverkillGuardHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (get?.mode?.() !== "identity") return;

				const round = typeof game?.roundNumber === "number" && !Number.isNaN(game.roundNumber) ? game.roundNumber : 0;
				if (!(round > 0 && round <= 1)) return;

				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target || target === player) return;
				if (typeof get?.itemtype === "function" && get.itemtype(target) !== "player") return;

				// 仅约束“未暴露身份”：目标未明置，且软暴露不高
				if (target.identityShown) return;
				const shown = target.ai && typeof target.ai.shown === "number" ? target.ai.shown : 0;
				if (shown >= 0.85) return;

				// 仅针对“有害行为”（对目标收益为负）
				const tv = getTargetUseValueFromEvent(player, target, ctx.event, get);
				if (tv >= 0) return;

				// 若当前态度已非常敌对（信息较明确），不做约束
				const att = safeAttitude(get, player, target);
				if (att < -3.5) return;

				const card = findEventCard(ctx.event);
				const cardName = String(card?.name || card?.viewAs || "");

				// 高风险单体伤害牌：首轮对未知目标更保守（避免单卡高波动直接带走）
				if (cardName === "juedou" || cardName === "huogong") {
					const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
					const extra = cardName === "juedou" ? 3.6 : 2.6;
					ctx.score -= extra + 0.18 * clampNumber(base, 0, 8);
					return;
				}

				const dealt = getTurnDamageFromPlayerToTarget(player, target);

				// 1) 同回合已打过该目标还继续追击：强惩罚（核心：避免“盲打连击把人一回合打死”）
				if (dealt > 0) {
					const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
					const hp = typeof target.hp === "number" && !Number.isNaN(target.hp) ? target.hp : 0;
					const dmgScale = clampNumber(dealt, 1, 4);
					const lowHpScale = hp <= 1 ? 1.35 : hp <= 2 ? 1.15 : 1;
					const penalty = (5.2 + 1.6 * dmgScale) * lowHpScale + 0.15 * clampNumber(base, 0, 8);
					ctx.score -= penalty;
					return;
				}

				// 2) 目标已低血（多来自前置误伤/群体牌）：首轮对未知目标避免“补刀收割”
				const hp = typeof target.hp === "number" && !Number.isNaN(target.hp) ? target.hp : 0;
				if (hp > 0 && hp <= 2) {
					const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
					const penalty = (hp <= 1 ? 4.8 : 3.2) + 0.12 * clampNumber(base, 0, 8);
					ctx.score -= penalty;
				}
			},
			// 放到更靠后：尽量不破坏既有策略，仅在“首轮盲打过激”时压一压
			{ priority: 1 }
		);
	}

	// 身份局策略：进攻范围内若存在已明置的敌人，则优先处理明置敌人，避免盲打未知身份目标
	if (!game.__slqjAiPersona._shownEnemyFirstHookInstalled) {
		game.__slqjAiPersona._shownEnemyFirstHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (get?.mode?.() !== "identity") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target) return;

				// 内奸保留灵活性：不强制“明示敌人优先”
				const selfId = String(player.identity || "");
				if (selfId === "nei") return;

				// 只约束“盲打未知”：候选目标本身未明置
				if (target.identityShown) return;

				// 仅在“本就敌对倾向”的未知目标上生效，避免干扰牺牲/自损等友方目标逻辑
				const att = safeAttitude(get, player, target);
				if (att >= -0.6) return;

				// 仅对“有害行为”（对目标收益为负）生效
				const tv = getTargetUseValueFromEvent(player, target, ctx.event, get);
				if (tv >= 0) return;

				// 若候选集中存在“已明置且敌对”的可用目标（同样为有害目标），则对未知目标施加强惩罚
				const all = Array.isArray(ctx.all) ? ctx.all : [];
				if (!all.length) return;

				let hasShownEnemy = false;
				for (const p of all) {
					if (!p || p === player) continue;
					if (typeof get?.itemtype === "function" && get.itemtype(p) !== "player") continue;
					if (!p.identityShown) continue;
					const patt = safeAttitude(get, player, p);
					if (patt >= -0.6) continue;
					const ptv = getTargetUseValueFromEvent(player, p, ctx.event, get);
					if (ptv >= 0) continue;
					hasShownEnemy = true;
					break;
				}
				if (!hasShownEnemy) return;

				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				const penalty = 4.2 + 0.35 * clampNumber(base, 0, 6);
				ctx.score -= penalty;
			},
			{ priority: 3 }
		);
	}

	// 身份局策略：首轮反贼若能对主公用【杀】，则更偏向先打主公（避免“能打主公却先砍别人”）
	if (!game.__slqjAiPersona._fanRound1ShaZhuFirstHookInstalled) {
		game.__slqjAiPersona._fanRound1ShaZhuFirstHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (get?.mode?.() !== "identity") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target || target === player) return;

				if (String(player.identity || "") !== "fan") return;
				const zhu = game?.zhu;
				if (!zhu) return;

				// 首轮：roundNumber 规则与其他开局策略保持一致（round<=2 的策略同源）
				const round = typeof game?.roundNumber === "number" && !Number.isNaN(game.roundNumber) ? game.roundNumber : 0;
				if (!(round > 0 && round <= 1)) return;

				const card = findEventCard(ctx.event);
				if (!card || String(card.name || "") !== "sha") return;

				const all = Array.isArray(ctx.all) ? ctx.all : [];
				if (!all.some(p => p === zhu)) return;

				// 仅在“本就会出杀”的候选上做影响：base<=0 直接不干预，避免把无收益选择硬抬上来
				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				if (!(base > 0)) return;

				if (target === zhu) {
					ctx.score += 2.8;
					return;
				}

				// 对非主公目标做轻度惩罚，避免推翻“明显击杀/关键破局”等强收益
				if (base < 6) ctx.score -= 1.8;
			},
			// priority 越小越晚执行：尽量在既有策略之后再做“首轮强目标”影响
			{ priority: 2 }
		);
	}

	// 身份局策略：首轮内奸避免主动对主公进行单体有害出牌（尤其【杀】），避免开局跳反/送反
	if (!game.__slqjAiPersona._neiRound1AvoidHarmZhuHookInstalled) {
		game.__slqjAiPersona._neiRound1AvoidHarmZhuHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (get?.mode?.() !== "identity") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target || target === player) return;

				if (String(player.identity || "") !== "nei") return;
				const zhu = game?.zhu;
				if (!zhu || target !== zhu) return;

				const round = typeof game?.roundNumber === "number" && !Number.isNaN(game.roundNumber) ? game.roundNumber : 0;
				if (!(round > 0 && round <= 1)) return;

				// 仅限制“主动出牌阶段”的对主公有害行为，避免影响响应/被动场景（如被借刀）
				if (!isPhaseUseContext(ctx.event)) return;

				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				if (!(base > 0)) return;

				const tv = getTargetUseValueFromEvent(player, target, ctx.event, get);
				if (typeof tv !== "number" || Number.isNaN(tv) || tv >= 0) return;

				ctx.score -= 9999;
			},
			{ priority: 2 }
		);
	}

	// 身份局策略：主公首轮全场全暗时避免盲目乱打；若可存牌则优先保留进攻牌（群攻可另行试探）
	if (!game.__slqjAiPersona._zhuRound1AllHiddenAvoidBlindAggroHookInstalled) {
		game.__slqjAiPersona._zhuRound1AllHiddenAvoidBlindAggroHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (get?.mode?.() !== "identity") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;

				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target || target === player) return;

				if (!isZhuRoundOneAllHidden(player, game)) return;

				// 可存牌（不溢出）时才压制盲打；若本就要弃牌则放开（用牌比弃牌更不亏）
				let overflow = 0;
				try {
					overflow = typeof player.needsToDiscard === "function" ? player.needsToDiscard() : 0;
				} catch (e) {
					overflow = 0;
				}
				if (overflow > 0) return;

				// 仅限制“主动出牌阶段”的有害选目标，避免影响响应/被动场景
				if (!isPhaseUseContext(ctx.event)) return;

				const tv = getTargetUseValueFromEvent(player, target, ctx.event, get);
				if (typeof tv !== "number" || Number.isNaN(tv) || tv >= 0) return;

				ctx.score -= 9999;
			},
			{ priority: 2 }
		);
	}

	// 扩展技巧：手牌未到上限且无进攻需求时，武器/减马尽量暗藏手里（避免“无收益明牌”与被借刀等风险）
	if (!game.__slqjAiPersona._equipHoldInHandHookInstalled) {
		game.__slqjAiPersona._equipHoldInHandHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
				const player = ctx.player;
				const card = ctx.candidate;
				if (!player || !card) return;
				if (!isUseCardContext(ctx.event)) return;

				const ek = getEquipKind(card, get);
				if (!ek) return;

				// “未达到上限”：手牌数 < 手牌上限
				const hand = safeCountCards(player, "h");
				const limit = safeGetHandcardLimit(player);
				if (!(hand < limit)) return;

				// “没有进攻需求”：当前没有可实际打出的进攻动作（轻量近似）
				if (hasImmediateOffenseNeed(player, game, get)) return;

				// 仅对“本就收益不高”的装备出牌施加惩罚，避免干扰强收益/强联动（base 越高惩罚越小）
				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				const t = clampNumber(1 - clampNumber(base / 2.5, 0, 1), 0, 1);
				const penalty = (ek.kind === "weapon" ? 0.9 : 0.75) * (0.55 + t * 0.75);
				ctx.score -= penalty;
			},
			{ priority: 5 }
		);
	}

	// 通用技巧：无懈可击大部分情况下比桃更关键 —— 弃牌/被迫失去手牌时优先保留无懈
	if (!game.__slqjAiPersona._wuxieKeepPriorityHookInstalled) {
		game.__slqjAiPersona._wuxieKeepPriorityHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
				const player = ctx.player;
				const card = ctx.candidate;
				if (!player || !card) return;
				if (!isDiscardCardContext(ctx.event)) return;

				if (isWuxieCard(card)) {
					ctx.score -= 3;
					return;
				}

				// 少数例外：自身濒死/极低血线时桃更关键
				if (isTaoCard(card)) {
					const hp = typeof player.hp === "number" && !Number.isNaN(player.hp) ? player.hp : 0;
					const dying = hp <= 0 || (typeof player.isDying === "function" && player.isDying());
					if (dying || hp <= 1) ctx.score -= 1.5;
					else ctx.score += 0.9;
				}
			},
			{ priority: 5 }
		);
	}

	// 通用技巧：基本牌通用技巧（回合外多留基本牌；杀/闪/酒保留偏好；温和“卖血保杀”；酒的“先喝酒再找牌”习惯）
	if (!game.__slqjAiPersona._basicCardGeneralTipsHookInstalled) {
		game.__slqjAiPersona._basicCardGeneralTipsHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
				const player = ctx.player;
				const card = ctx.candidate;
				if (!player || !card) return;

				const name = String(card?.name || "");
				if (!name) return;

				const hp = typeof player.hp === "number" && !Number.isNaN(player.hp) ? player.hp : 0;
				const dying = hp <= 0 || (typeof player.isDying === "function" && player.isDying());

				// 1) 弃牌/失去手牌：回合外更保留关键基本牌（最后的闪/杀），多余酒优先丢
				if (isDiscardCardContext(ctx.event)) {
					const type = getCardType(card, get);
					if (type !== "basic") return;

					const threaten = safeGetThreaten(get, player);
					const threatFactor = clampNumber((threaten - 0.9) / 1.4, 0, 1);

					const shanCount = safeCountCardsByName(player, "h", "shan");
					const shaCount = safeCountCardsByName(player, "h", "sha");
					const jiuCount = safeCountCardsByName(player, "h", "jiu");

					// 闪：被集火风险高时更要保留最后一闪；嘲讽低且闪多时允许丢“多余的闪”
					if (name === "shan") {
						if (shanCount <= 1) {
							ctx.score -= 2.0 + 0.9 * threatFactor;
							return;
						}
						if (shanCount >= 2) {
							ctx.score += threaten < 0.9 ? 0.6 : 0.25;
						}
						return;
					}

					// 杀：稀缺时更保留；并按火/雷/红/黑做“先丢谁”的倾向
					if (name === "sha") {
						if (shaCount <= 1) ctx.score -= 1.0;
						else if (shaCount >= 3) ctx.score += 0.25;

						const tier = getShaTier(card, get);
						if (tier === "fire") ctx.score -= 0.8;
						else if (tier === "thunder") ctx.score -= 0.6;
						else if (tier === "red") ctx.score -= 0.25;
						else if (tier === "black") ctx.score += 0.15;
						return;
					}

					// 酒：酒一回合只能喝一次，多余酒通常没有收益 -> 优先丢复数酒
					if (name === "jiu") {
						if (jiuCount >= 2) ctx.score += 0.9;
						return;
					}

					// 桃：极低血线时已有“桃更关键”兜底；这里仅补充 hp==2 的轻度保留
					if (name === "tao") {
						if (dying || hp <= 1) return;
						if (hp <= 2) ctx.score -= 0.5;
					}
					return;
				}

				// 2) 借刀杀人响应：被“借刀者”在 chooseToUse 中更倾向出杀打敌人；被要求砍友方则拒绝出杀（交武器）
				// 说明：这解决“借友军刀杀敌人时，人机明明有杀却不出杀而交武器”的体验问题。
				if (name === "sha") {
					const respondTo = Array.isArray(ctx.event?.respondTo) ? ctx.event.respondTo : null;
					const respondCard = respondTo?.[1] || null;
					const respondName = String(respondCard?.name || respondCard?.viewAs || "");
					if (respondName === "jiedao") {
						const source = respondTo?.[0] || null;
						const forcedTarget = ctx.event?.sourcex || null;

						// 若无法稳定拿到被要求的目标，就不做干预（避免误伤其他 chooseToUse 场景）
						if (!forcedTarget) return;
						if (typeof get?.itemtype === "function" && get.itemtype(forcedTarget) !== "player") return;

						const attToVictim = safeAttitude(get, player, forcedTarget);
						if (attToVictim > 0.3) {
							// 不对友方出杀：宁可交武器也不误伤
							ctx.score -= 9999;
							return;
						}

						const attToSource = source ? safeAttitude(get, player, source) : 0;
						if (attToVictim < -0.3) {
							// 敌方借刀：更愿意出杀，避免交武器给敌方
							if (attToSource < -0.3) {
								ctx.score += 2.6;
								return;
							}

							// 友军借刀：若“失去武器也不会卡距离”，则允许把武器交给友军（减少强行出杀）
							if (attToSource > 0.3) {
								const rangeInfo = estimateWeaponLossDistanceBlockRisk(player, game, get);
								const safeToDonate = rangeInfo.known && !rangeInfo.risk;

								// 若无法确认安全，则保守偏向“出杀保武器”
								if (!rangeInfo.known) {
									ctx.score += 0.8;
									return;
								}

								// 安全可交武器：在“武器对友军更有价值”时更倾向不出杀（交武器）
								if (safeToDonate) {
									const weapon = rangeInfo.weaponCard || safeGetWeaponCard(player, get);
									const vToSource = weapon ? safeGetCardValue(weapon, source, get) : 0;
									const vToMe = weapon ? safeGetCardValue(weapon, player, get) : 0;
									const sourceHasWeapon = !!(source && safeGetWeaponCard(source, get));
									const sourceOffenseNeed = source ? hasImmediateOffenseNeed(source, game, get) : false;

									let donateBenefit = 0;
									if (!sourceHasWeapon) donateBenefit += 0.9;
									if (sourceOffenseNeed) donateBenefit += 0.5;
									if (vToSource >= 5) donateBenefit += 0.7;
									const delta = vToSource - vToMe;
									if (delta > 0.5) donateBenefit += clampNumber(delta, 0, 4) * 0.18;

									if (donateBenefit >= 1.1) {
										ctx.score -= 2.4;
										return;
									}

									// 仍可配合出杀，但不再强制推高（避免总是压过“交武器”的策略）
									ctx.score += 0.35;
									return;
								}

								// 交武器会卡距离：更偏向出杀保武器
								ctx.score += 1.8;
								return;
							}

							// 中立来源：轻度偏向出杀（避免无脑交武器）
							ctx.score += 1.2;
							return;
						}
						return;
					}
				}

				// 2) 响应：温和“卖血保杀”（回合外稀缺杀更不愿意用在南蛮/决斗的响应上）
				if (isRespondContext(ctx.event)) {
					if (name !== "sha") return;

					// 先做轻度“形态保留”：优先用黑杀响应，尽量留火/雷/红杀
					const tier = getShaTier(card, get);
					if (tier === "black") ctx.score += 0.18;
					else if (tier === "red") ctx.score -= 0.05;
					else if (tier === "thunder") ctx.score -= 0.12;
					else if (tier === "fire") ctx.score -= 0.16;

					// forced 响应不做“卖血”干预
					if (ctx.event?.forced) return;
					if (dying) return;

					const shaCount = safeCountCardsByName(player, "h", "sha");
					if (hp < 3 || shaCount > 1) return;

					const src = findEventCard(ctx.event);
					const srcName = String(src?.name || "");
					if (srcName !== "nanman" && srcName !== "juedou") return;

					// 温和强度：只做轻度降权，避免把“明显该防的致命伤”也放掉
					ctx.score -= 1.2;
					return;
				}

				// 3) 出牌阶段：酒的时机（“先喝酒再找牌”）按本局 habit 分流
				if (name === "jiu" && isPhaseUseContext(ctx.event) && isUseCardContext(ctx.event)) {
					const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
					if (base <= 0) return;

					const cardHist = safeGetPhaseUseCardHistory(player);
					const skillHist = safeGetPhaseUseSkillHistory(player, get);
					const progress = cardHist.length + skillHist.length;
					if (progress > 1) return;

					const usedJiu = cardHist.some(evt => String(evt?.card?.name || evt?.cards?.[0]?.name || "") === "jiu");
					if (usedJiu) return;

					// 仅在“存在明显敌对目标”时才考虑“喝酒搏节奏”，避免空喝酒
					const hasEnemy = (game.players || []).some(p => {
						if (!p || p === player) return false;
						try {
							if (typeof p.isDead === "function" && p.isDead()) return false;
						} catch (e) {
							return false;
						}
						return safeAttitude(get, player, p) < -0.6;
					});
					if (!hasEnemy) return;

					const habit = getJiuSearchShaHabit(player);
					const earlyFactor = clampNumber(1 - progress / 2, 0, 1);
					if (earlyFactor <= 0) return;

					const shaCount = safeCountCardsByName(player, "h", "sha");
					const all = Array.isArray(ctx.all) ? ctx.all : [];
					const hasDrawLike = all.some(c => {
						if (!c || c === card) return false;
						return isDrawLikeCandidate(c, player, ctx.event, get);
					});

					// 保守：手里已有杀/可打节奏时更愿意先喝酒；没杀则不空喝
					if (habit === "conservative") {
						if (shaCount <= 0) return;
						ctx.score += 0.35 * earlyFactor;
						return;
					}

					// 启发式：允许“先喝酒再找牌”，但需要存在过牌候选作为“找牌”载体
					if (shaCount > 0) {
						ctx.score += 0.45 * earlyFactor;
						return;
					}
					if (!hasDrawLike) return;

					ctx.score += 0.55 * earlyFactor;
				}
			},
			{ priority: 5 }
		);
	}

	// 通用技巧：能存住牌强过只有血量健康 —— 选目标时适度把“可留住的手牌”视为更高权重资源
	if (!game.__slqjAiPersona._handStoragePriorityHookInstalled) {
		game.__slqjAiPersona._handStoragePriorityHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target) return;

				const card = findEventCard(ctx.event);
				const tv = getResultNumberForTarget(card, ctx.event?.skill, player, target, get);
				if (tv === 0) return;

				const hp = typeof target.hp === "number" && !Number.isNaN(target.hp) ? target.hp : 0;
				const dying = hp <= 0 || (typeof target.isDying === "function" && target.isDying());
				if (dying) return;

				const att = safeAttitude(get, player, target);
				const { keepable, overflow, limit } = getHandStorageInfo(target);

				// 1) 敌对目标：优先处理“能存住牌”的威胁，而不是只看血量健康
				if (tv < 0 && att < -0.6) {
					if (hp <= 1) return;
					let delta = (keepable - hp) * 0.22;
					// 低血线：只加分不扣分，避免影响“补刀/压血线”的直觉
					if (hp <= 2) delta = Math.max(0, delta);
					ctx.score += clampNumber(delta, -1.1, 1.1);
					return;
				}

				// 2) 桃：若目标当前溢出，回血可提升“存牌能力”（手牌上限≈体力）因此略加分
				if (tv > 0 && String(card?.name || "") === "tao") {
					const friendlyLike = target === player || att > 0.6;
					if (!friendlyLike) return;
					if (limit <= 0 || overflow <= 0) return;
					ctx.score += clampNumber(overflow * 0.35, 0, 0.9);
				}
			},
			{ priority: 4 }
		);
	}

	// 情绪：怒气（全局 + 定向）
	// - 仅出牌阶段生效，避免干扰响应/弃牌等场景
	// - 仅对“已是正分的候选”轻推：不把强门槛压到负分的项抬成可选
	if (!game.__slqjAiPersona._rageBiasHookInstalled) {
		game.__slqjAiPersona._rageBiasHookInstalled = true;

		// 1) 选目标：更偏向处理“对其怒气”更高的敌对目标
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target) return;
				if (!isPhaseUseContext(ctx.event)) return;

				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				const current = typeof ctx.score === "number" && !Number.isNaN(ctx.score) ? ctx.score : base;
				if (base <= 0) return;
				if (current <= 0) return;

				const card = findEventCard(ctx.event);
				if (!card) return;
				const tv = getResultNumberForTarget(card, ctx.event?.skill, player, target, get);
				if (tv >= 0) return;

				const att = safeAttitude(get, player, target);
				if (att > -0.5) return;

				const rage = safeGetRage(player);
				const rageTo = safeGetRageTowards(player, target);
				if (rageTo < 1.5 && rage < 2) return;

				const personaId = safeGetPersonaId(player);
				const { wT, wG } = getRageBiasWeights(personaId);
				const t = clampNumber(rageTo / 20, 0, 1);
				const g = clampNumber(rage / 20, 0, 1);
				const scale = clampNumber(1 - base / 7, 0.2, 1);
				const bonus = scale * (wT * 1.6 * t + wG * 0.5 * g);
				ctx.score += bonus;
			},
			{ priority: 3 }
		);

		// 2) 选牌：怒气高时更偏向进攻/压制类牌
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
				const player = ctx.player;
				const card = ctx.candidate;
				if (!player || !card) return;
				if (!isPhaseUseContext(ctx.event)) return;

				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				const current = typeof ctx.score === "number" && !Number.isNaN(ctx.score) ? ctx.score : base;
				if (base <= 0) return;
				if (current <= 0) return;

				const rage = safeGetRage(player);
				if (rage < 2) return;

				const cardName = String(card?.name || "");
				const aggressive =
					cardName === "sha" ||
					cardName === "juedou" ||
					cardName === "nanman" ||
					cardName === "wanjian" ||
					cardName === "huogong" ||
					cardName === "guohe" ||
					cardName === "shunshou" ||
					cardName === "lebu" ||
					cardName === "bingliang" ||
					isOffensiveGroupTrickCard(card, player, game, get);
				if (!aggressive) return;

				const personaId = safeGetPersonaId(player);
				const { wG } = getRageBiasWeights(personaId);
				const g = clampNumber(rage / 20, 0, 1);
				const scale = clampNumber(1 - base / 6, 0.2, 1);
				ctx.score += scale * wG * 0.9 * g;
			},
			{ priority: 3 }
		);
	}

	// 通用技巧：马上能用出来的牌更有价值
	// - 拆/顺/攻击：优先干扰“本轮还没行动”的目标（更可能好牌多、还没展开）
	// - 补牌：优先给“马上行动”的友方（更可能把资源转化为即时收益）
	if (!game.__slqjAiPersona._immediateUseValueHookInstalled) {
		game.__slqjAiPersona._immediateUseValueHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target) return;
				if (!isUseCardContext(ctx.event)) return;

				const card = findEventCard(ctx.event);
				if (!card) return;

				const tv = getResultNumberForTarget(card, ctx.event?.skill, player, target, get);
				if (tv === 0) return;

				const att = safeAttitude(get, player, target);
				const dist = getTurnOrderDistance(player, target, game);
				if (!Number.isFinite(dist) || dist <= 0) return;

				const cardName = String(card?.name || "");

				// 1) 拆顺/攻击：优先“还没行动过”的目标（只做加分，不强行扣分）
				if (tv < 0) {
					// 仅对明确敌对目标生效（避免影响“打队友触发收益”等特殊套路）
					if (att > 0.6) return;
					if (!hasNotActedYetThisRound(player, target)) return;

					// 越接近行动（dist 越小）越紧迫：下家收益最大
					const urgency = clampNumber((3 - dist) / 2, 0, 1); // dist=1 -> 1, dist=2 -> 0.5, dist>=3 -> 0
					const kindScale =
						cardName === "guohe" || cardName === "shunshou"
							? 1
							: cardName === "sha" || cardName === "juedou" || cardName === "huogong"
								? 0.85
								: 0.65;
					const bonus = (0.55 + 0.65 * urgency) * kindScale;
					ctx.score += bonus;
					return;
				}

				// 2) 补牌：尽量补给“马上行动”的友方（draw/gain 标签）
				if (tv > 0) {
					const friendlyLike = target === player || att > 0.6;
					if (!friendlyLike) return;

					const isSupply = safeGetCardAiTag(card, "draw", get) || safeGetCardAiTag(card, "gain", get);
					if (!isSupply) return;

					// dist 越小越可能“马上用出来”；给到太远收益不变，但更容易来不及用/被控
					const urgency = clampNumber((4 - dist) / 3, 0, 1); // dist=1 -> 1, dist=2 -> 0.66, dist=3 -> 0.33
					const bonus = 0.25 + 0.55 * urgency;
					ctx.score += bonus;
				}
			},
			{ priority: 4 }
		);
	}

	// 通用技巧：先过牌，再想怎么行动 —— 出牌阶段优先“过牌（draw）”以确立资源，再做最大化决策
	if (!game.__slqjAiPersona._drawFirstThenActHookInstalled) {
		game.__slqjAiPersona._drawFirstThenActHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				const player = ctx.player;
				const candidate = ctx.candidate;
				if (!player || !candidate) return;
				// chooseCard 可能包含“技能字符串”（见 ai.basic.chooseCard：cards + get.skills()）
				if (typeof candidate !== "string") {
					if (typeof get?.itemtype === "function" && get.itemtype(candidate) !== "card") return;
				}
				if (!isPhaseUseContext(ctx.event)) return;

				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				if (base <= 0) return;

				// 仅在“当前仍存在可用过牌牌”时做调节
				const all = Array.isArray(ctx.all) ? ctx.all : [];
				const hasDrawCandidate = all.some(c => isDrawLikeCandidate(c, player, ctx.event, get));
				if (!hasDrawCandidate) return;

				// 若已经开始出“非过牌”的牌，则不再强行推“先过牌”
				const cardHist = safeGetPhaseUseCardHistory(player);
				const skillHist = safeGetPhaseUseSkillHistory(player, get);
				const usedNonDraw =
					cardHist.some(evt => {
						const c = evt?.card;
						return !!c && !isDrawLikeCandidate(c, player, ctx.event, get);
					}) ||
					skillHist.some(evt => {
						const s = evt?.skill;
						if (typeof s !== "string") return false;
						return !isDrawLikeCandidate(s, player, evt?.event || ctx.event, get);
					});
				if (usedNonDraw) return;

				const startedScale = cardHist.length + skillHist.length <= 0 ? 1 : 0.55;

				// 1) 过牌候选（卡牌/技能）：加分（越犹豫/越低 base 的过牌越需要被抬一点）
				if (isDrawLikeCandidate(candidate, player, ctx.event, get)) {
					const t = clampNumber(1 - clampNumber(base / 2.8, 0, 1), 0, 1);
					ctx.score += (0.45 + 0.65 * t) * startedScale;
					return;
				}

				// 2) 其他候选：仅在“手牌仍有空间”且收益不算极高时轻度降分，避免过早定打法
				const { hand, limit } = getHandStorageInfo(player);
				const hasRoom = hand < limit;
				if (!hasRoom) return;

				// 回复/保命类不做抑制（例如桃/救助技）
				if (typeof candidate === "string") {
					if (safeGetCardAiTag(candidate, "recover", get) || safeGetCardAiTag(candidate, "save", get)) return;
					const info = safeGetSkillInfo(candidate, get);
					const promptText = safeGetSkillPromptText(candidate, info, ctx.event, player, get);
					const text = String(promptText || "");
					if (text.includes("回复") || text.includes("救")) return;
				} else {
					const name = String(candidate?.name || "");
					if (name === "tao" || safeGetCardAiTag(candidate, "recover", get) || safeGetCardAiTag(candidate, "save", get)) return;
				}

				// 高收益行为不抑制（例如明显击杀/关键拆迁等）
				if (base >= 3.2) return;

				const t = clampNumber(1 - clampNumber(base / 3.2, 0, 1), 0, 1);
				ctx.score -= (0.18 + 0.38 * t) * startedScale;
			},
			{ priority: 4 }
		);
	}

	// 行为规则：连弩起爆前，压制提前出杀（让“卖血拿牌”先完成梭哈再爆发输出）。
	// - 条件：本次 chooseCard 候选集中存在满足“连弩起爆梭哈”条件的主动卖血技能，且尚未出过杀
	// - 行为：对【杀】做轻度降权（不推翻明显击杀等极高收益）
	if (!game.__slqjAiPersona._activeMaixieZhugeAllInDelayShaHookInstalled) {
		game.__slqjAiPersona._activeMaixieZhugeAllInDelayShaHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.stage !== "final") return;
				if (ctx.kind !== "chooseCard") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;

				const player = ctx.player;
				const card = ctx.candidate;
				if (!player || !card) return;
				if (!isPhaseUseContext(ctx.event)) return;

				const name = String(card?.name || "");
				if (name !== "sha") return;

				// 已进入“爆发输出”阶段则不再延后出杀
				const cardHist = safeGetPhaseUseCardHistory(player);
				if (cardHist.some(ev => String(ev?.card?.name || ev?.cards?.[0]?.name || "") === "sha")) return;

				const all = ctx.all;
				if (!Array.isArray(all) || !all.length) return;

				let hasAllInSkill = false;
				for (const cand of all) {
					if (typeof cand !== "string" || !cand) continue;
					const info = safeGetSkillInfo(cand, get);
					const aiInfo = info?.ai;
					if (!aiInfo || typeof aiInfo !== "object") continue;
					if (!aiInfo[TAG_ACTIVE_MAIXIE]) continue;
					const c = getActiveMaixieZhugeAllInContext(player, cand, info, ctx.event, game, get);
					if (c.ok) {
						hasAllInSkill = true;
						break;
					}
				}
				if (!hasAllInSkill) return;

				// 明显高收益（击杀/关键破局）不干预
				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				if (base >= 6.8) return;

				ctx.score -= 2.4;
			},
			{ priority: 5 }
		);
	}

	// 行为规则：连弩起爆——主动卖血拿牌可“梭哈”。
	// - 条件：主动卖血技能满足“一血换二牌”及以上；有诸葛连弩且不卡距离；自己或友方有桃兜底
	// - 行为：在出牌阶段（未开始出杀）强力提高该卖血技能的优先级，倾向先把牌“狂拿”到位，再靠连弩猛出杀
	if (!game.__slqjAiPersona._activeMaixieZhugeAllInHookInstalled) {
		game.__slqjAiPersona._activeMaixieZhugeAllInHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.stage !== "final") return;
				if (ctx.kind !== "chooseCard" && ctx.kind !== "chooseButton") return;
				const player = ctx.player;
				if (!player) return;
				if (!isPhaseUseContext(ctx.event)) return;

				let skill = "";
				if (ctx.kind === "chooseCard") {
					const candidate = ctx.candidate;
					if (typeof candidate !== "string" || !candidate) return;
					skill = candidate;
				} else {
					const link = ctx.candidate?.link;
					if (typeof link !== "string" || !link) return;
					skill = link;
				}

				const info = safeGetSkillInfo(skill, get);
				const aiInfo = info?.ai;
				if (!aiInfo || typeof aiInfo !== "object") return;
				if (!aiInfo[TAG_ACTIVE_MAIXIE]) return;

				// 一旦已经开始出杀（进入“爆发输出”阶段），不再强推继续卖血（避免来回摇摆）
				const cardHist = safeGetPhaseUseCardHistory(player);
				if (cardHist.some(ev => String(ev?.card?.name || ev?.cards?.[0]?.name || "") === "sha")) return;

				const c = getActiveMaixieZhugeAllInContext(player, skill, info, ctx.event, game, get);
				if (!c.ok) return;

				// 一血换二牌≈小赚；越高越赚 -> 加分更大
				const ratio = clampNumber(c.economy.cardsPerHp, 0, 6);
				const profit = clampNumber((ratio - 2) / 2, 0, 1.5);
				let bonus = 4.2 + 3.2 * profit;
				if (c.allyTao > 0) bonus += 0.45;
				if (c.zhugeEquipped) bonus += 0.25;

				// 更激进：当“本次卖血可能直接卖到濒死”且存在救援兜底时，强推继续梭哈。
				// - 若依赖盟友桃（allyTao>0），更敢卖到濒死
				// - 若仅自带桃（selfTao>0），也允许但略保守（避免无意义消耗自保资源）
				const hp = typeof player.hp === "number" && !Number.isNaN(player.hp) ? player.hp : 0;
				const hpCost = typeof c.economy.hpCost === "number" && Number.isFinite(c.economy.hpCost) ? c.economy.hpCost : 1;
				const afterHp = hp - Math.max(1, hpCost);
				const willDying = afterHp <= 0;
				if (willDying) {
					bonus += c.allyTao > 0 ? 10.5 : 6.5;
				} else if (afterHp <= 1) {
					bonus += c.allyTao > 0 ? 4.2 : 2.4;
				} else if (afterHp <= 2) {
					bonus += c.allyTao > 0 ? 2.0 : 1.2;
				}

				ctx.score += bonus;
			},
			{ priority: 6 }
		);
	}

	// 行为规则：主动卖血在低血线时禁用（除非手里有桃）。
	// - 条件：hp < ceil(maxHp/2)，且候选为“主动卖血”技能（slqj_ai_active_maixie）
	// - 例外：手牌区存在【桃】时允许使用（自保兜底）
	// - 例外：满足“连弩起爆梭哈”条件时允许继续主动卖血拿牌（见 getActiveMaixieZhugeAllInContext）
	if (!game.__slqjAiPersona._activeMaixieLowHpGuardHookInstalled) {
		game.__slqjAiPersona._activeMaixieLowHpGuardHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.stage !== "final") return;
				if (ctx.kind !== "chooseCard" && ctx.kind !== "chooseButton") return;
				const player = ctx.player;
				if (!player) return;
				if (!isPhaseUseContext(ctx.event)) return;

				let skill = "";
				if (ctx.kind === "chooseCard") {
					const candidate = ctx.candidate;
					if (typeof candidate !== "string" || !candidate) return;
					skill = candidate;
				} else {
					const link = ctx.candidate?.link;
					if (typeof link !== "string" || !link) return;
					skill = link;
				}

				const info = safeGetSkillInfo(skill, get);
				const aiInfo = info?.ai;
				if (!aiInfo || typeof aiInfo !== "object") return;
				if (!aiInfo[TAG_ACTIVE_MAIXIE]) return;

				// 若满足“连弩起爆梭哈”条件，则低血线不再强行禁用（让它敢卖）
				const allIn = getActiveMaixieZhugeAllInContext(player, skill, info, ctx.event, game, get);
				if (allIn.ok) return;

				const hp = typeof player.hp === "number" && !Number.isNaN(player.hp) ? player.hp : 0;
				const maxHpRaw =
					typeof player.maxHp === "number" && !Number.isNaN(player.maxHp) ? player.maxHp : hp;
				const maxHp = Math.max(0, maxHpRaw);
				const halfCeil = Math.ceil(maxHp / 2);
				if (!(hp < halfCeil)) return;

				const taoCount = safeCountCardsByName(player, "h", "tao");
				if (taoCount > 0) return;

				ctx.score -= 9999;
			},
			{ priority: 7 }
		);
	}

	// 行为规则：开路斩友（极激进）。
	// - 场景：敌人被盟友隔开（下家=盟友，其下家=敌人），当前因距离打不到敌人
	// - 条件：具备多次出杀能力，且手里杀足够覆盖“击杀盟友 + 击杀敌人”
	// - 行为：允许先对盟友出杀以“开路”，再转火下家敌人
	if (!game.__slqjAiPersona._friendlyFireOpenPathHookInstalled) {
		game.__slqjAiPersona._friendlyFireOpenPathHookInstalled = true;

		// 1) 选牌：若存在开路线，则轻度抬高【杀】的出牌倾向（否则可能永远不会进入选目标阶段）。
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
				const player = ctx.player;
				const card = ctx.candidate;
				if (!player || !card) return;
				if (!isPhaseUseContext(ctx.event)) return;
				if (String(card?.name || card?.viewAs || "") !== "sha") return;

				const c = getFriendlyFireOpenPathContext(player, card, game, get);
				if (!c.ok) return;

				// 顺风时不乱斩友；除非目标是主公（击杀即终局）
				const s = getSituationIndex(player, game, get);
				const zhu = game?.zhu;
				const enemyIsZhu = !!zhu && c.enemy === zhu;
				if (s > 0.22 && !enemyIsZhu) return;

				const intensity = clampNumber(Math.max(0, -s), 0, 1);
				const threaten = safeGetThreaten(get, c.enemy, player);
				const threatFactor = clampNumber((threaten - 0.9) / 1.4, 0, 1);
				const slack = c.shaCount - c.needSha;
				const slackFactor = clampNumber(slack / 3, 0, 1);

				let bonus = 2.2 + 2.4 * intensity + 1.2 * threatFactor + 0.9 * slackFactor;
				if (enemyIsZhu) bonus += 2.4;
				if (c.zhugeEquipped) bonus += 0.35;
				ctx.score += bonus;
			},
			{ priority: 8 }
		);

		// 2) 选目标：对“开路盟友”加分，使其在【杀】的选目标中可被选中。
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target || target === player) return;
				if (!isPhaseUseContext(ctx.event)) return;

				const card = findEventCard(ctx.event);
				if (!card || String(card?.name || card?.viewAs || "") !== "sha") return;

				const c = getFriendlyFireOpenPathContext(player, card, game, get);
				if (!c.ok) return;
				if (target !== c.ally) return;

				// 顺风时不乱斩友；除非目标是主公（击杀即终局）
				const s = getSituationIndex(player, game, get);
				const zhu = game?.zhu;
				const enemyIsZhu = !!zhu && c.enemy === zhu;
				if (s > 0.22 && !enemyIsZhu) return;

				const intensity = clampNumber(Math.max(0, -s), 0, 1);
				const threaten = safeGetThreaten(get, c.enemy, player);
				const threatFactor = clampNumber((threaten - 0.9) / 1.4, 0, 1);
				const slack = c.shaCount - c.needSha;
				const slackBonus = clampNumber(slack * 0.65, 0, 4.0);

				const enemyHp = typeof c.enemy?.hp === "number" && !Number.isNaN(c.enemy.hp) ? c.enemy.hp : 0;
				const enemyLowHpBonus = enemyHp <= 1 ? 1.8 : enemyHp <= 2 ? 0.9 : 0;

				let bonus = 12.5 + 8.2 * intensity + 3.0 * threatFactor + slackBonus + enemyLowHpBonus;
				if (enemyIsZhu) bonus += 8.8;
				if (c.zhugeEquipped) bonus += 1.2;
				ctx.score += bonus;
			},
			{ priority: 8 }
		);
	}

	// 通用技巧：锦囊牌通用技巧 —— 越关键的锦囊越后用（保守实现：仅做顺序偏好，不强制改动最优解）
	// - 延时锦囊最后贴：出牌阶段前段，若仍存在其他可用动作，则对延时锦囊轻度降权
	// - 拆顺优先于伤害动作：同回合存在拆顺与伤害动作时，轻度偏向先拆顺
	if (!game.__slqjAiPersona._trickGeneralOrderHookInstalled) {
		game.__slqjAiPersona._trickGeneralOrderHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
				const player = ctx.player;
				const card = ctx.candidate;
				if (!player || !card) return;
				if (!isPhaseUseContext(ctx.event)) return;

				const cardName = String(card?.name || "");
				if (!cardName || cardName === "wuxie") return;

				const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
				if (base <= 0) return;

				const cardHist = safeGetPhaseUseCardHistory(player);
				const skillHist = safeGetPhaseUseSkillHistory(player, get);
				const progress = cardHist.length + skillHist.length;
				const earlyFactor = clampNumber(1 - progress / 3, 0, 1);
				if (earlyFactor <= 0) return;

				const all = Array.isArray(ctx.all) ? ctx.all : [];

				// 1) 延时锦囊最后贴：前段若仍有其他可用动作，则轻度降权
				if (isDelayTrickCard(card, get)) {
					// 显著高收益的延时锦囊不打断（例如关键乐/闪电的决定性回合）
					if (base < 3) {
						const hasOtherNonDelay = all.some(c => {
							if (!c || c === card) return false;
							if (typeof c === "string") return false;
							if (typeof get?.itemtype === "function" && get.itemtype(c) !== "card") return false;
							const n = String(c?.name || "");
							if (!n || n === "wuxie") return false;
							return !isDelayTrickCard(c, get);
						});
						if (hasOtherNonDelay) {
							const baseFactor = clampNumber(1 - base / 2.8, 0, 1);
							const penalty = 0.55 * earlyFactor * (0.35 + 0.65 * baseFactor);
							ctx.score -= penalty;
						}
					}
					return;
				}

				// 2) 拆顺/伤害顺序取舍（来自通用技巧，保守实现）：
				// - 若同回合同时存在【杀】与【拆/顺】，前段略偏向“先杀再拆顺”（打不死时更容易拿到好牌）
				// - 否则：若同回合存在【拆/顺】与其他伤害动作，则仍保留“先拆顺再伤害”的轻量偏好
				if (base >= 3.2) return;

				let hasDismantle = false;
				let hasSha = false;
				let hasOtherDamageAction = false;
				for (const c of all) {
					if (!c || typeof c === "string") continue;
					if (typeof get?.itemtype === "function" && get.itemtype(c) !== "card") continue;
					const n = String(c?.name || "");
					if (n === "guohe" || n === "shunshou") hasDismantle = true;
					if (n === "sha") hasSha = true;
					else if (n === "juedou" || n === "huogong" || n === "nanman" || n === "wanjian") hasOtherDamageAction = true;
					if (hasDismantle && hasSha) break;
				}
				if (!hasDismantle) return;

				// 情况 A：同回合既有【杀】又有【拆/顺】——轻量偏向“先杀再拆顺”
				if (hasSha) {
					if (cardName === "sha") {
						ctx.score += 0.22 * earlyFactor;
						return;
					}
					if (cardName === "guohe" || cardName === "shunshou") {
						ctx.score -= 0.18 * earlyFactor;
						return;
					}
					return;
				}

				// 情况 B：无杀，但同回合存在【拆/顺】与其他伤害动作——仍偏向先拆顺
				if (!hasOtherDamageAction) return;

				if (cardName === "guohe" || cardName === "shunshou") {
					ctx.score += 0.24 * earlyFactor;
					return;
				}

				if (cardName === "juedou" || cardName === "huogong" || cardName === "nanman" || cardName === "wanjian") {
					// 回复/保命类不参与“伤害动作”降权（兜底：避免误标/特殊牌）
					if (safeGetCardAiTag(card, "recover", get) || safeGetCardAiTag(card, "save", get)) return;
					ctx.score -= 0.18 * earlyFactor;
				}
			},
			{ priority: 4 }
		);
	}

	// 通用技巧：锦囊牌通用技巧（子章节）—— AOE/五谷/桃园/火攻/决斗/乐/兵/闪电/借刀等
	// 说明：均为“保守偏好”，只在收益接近或局势/阶段明显时轻推，不推翻强收益候选。
	if (!game.__slqjAiPersona._trickSubsectionsHookInstalled) {
		game.__slqjAiPersona._trickSubsectionsHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.stage !== "final") return;
				const player = ctx.player;
				if (!player) return;

				// 1) 选牌：AOE/桃园/五谷/闪电/决斗（出牌阶段）
				if (ctx.kind === "chooseCard") {
					if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
					const card = ctx.candidate;
					if (!card) return;
					if (!isPhaseUseContext(ctx.event)) return;

					const cardName = String(card?.name || "");
					if (!cardName || cardName === "wuxie") return;

					const base = typeof ctx.base === "number" && !Number.isNaN(ctx.base) ? ctx.base : 0;
					if (base <= 0) return;

					const all = Array.isArray(ctx.all) ? ctx.all : [];
					const cardHist = safeGetPhaseUseCardHistory(player);
					const skillHist = safeGetPhaseUseSkillHistory(player, get);
					const progress = cardHist.length + skillHist.length;
					const earlyFactor = clampNumber(1 - progress / 3, 0, 1);

					// AOE：开局身份局倾向 + 万箭略优于南蛮（轻量影响）
					if (cardName === "nanman" || cardName === "wanjian") {
						const mode = typeof get?.mode === "function" ? String(get.mode()) : "";
						if (mode === "identity") {
							const round = typeof game?.roundNumber === "number" ? game.roundNumber : 0;
							if (round > 0 && round <= 2 && base < 3.2) {
								const id = String(player.identity || "");
								if (id === "fan") ctx.score -= 0.85 * earlyFactor;
								else if (id === "zhu" || id === "zhong" || id === "mingzhong") ctx.score += 0.35 * earlyFactor;
								else if (id === "nei") ctx.score -= 0.2 * earlyFactor;
							}
						}

						// 决斗顺序：若同回合同时存在 AOE 与 决斗，前段略偏向先决斗
						const hasJuedou = all.some(c => typeof c !== "string" && c && String(c.name || "") === "juedou");
						if (hasJuedou && base < 3.2) ctx.score -= 0.12 * earlyFactor;

						const hasNanman = all.some(c => typeof c !== "string" && c && String(c.name || "") === "nanman");
						const hasWanjian = all.some(c => typeof c !== "string" && c && String(c.name || "") === "wanjian");
						if (hasNanman && hasWanjian) {
							if (cardName === "wanjian") ctx.score += 0.18 * (0.4 + 0.6 * earlyFactor);
							else ctx.score -= 0.12 * (0.4 + 0.6 * earlyFactor);
						}
						return;
					}

					// 桃园/五谷：身份局的阵营倾向（轻量影响；不推翻既有门槛）
					if (cardName === "taoyuan" || cardName === "wugu") {
						const mode = typeof get?.mode === "function" ? String(get.mode()) : "";
						if (mode === "identity" && base < 3.2) {
							const id = String(player.identity || "");
							const scale = clampNumber(1 - clampNumber(base / 3.2, 0, 1), 0, 1);
							if (cardName === "taoyuan") {
								// 桃园：反向 AOE，更利于“人数更多”的阵营；这里用身份做极轻量倾向
								if (id === "fan") ctx.score += 0.28 * scale;
								else if (id === "zhu" || id === "zhong" || id === "mingzhong") ctx.score -= 0.18 * scale;
							} else {
								// 五谷：开局谁开五谷默认跳反（开局更明显；中后期仍由门槛/基础收益决定）
								const round = typeof game?.roundNumber === "number" ? game.roundNumber : 0;
								const roundScale = round > 0 && round <= 2 ? 1 : 0.45;
								if (id === "fan") ctx.score += 0.55 * scale * roundScale;
								else if (id === "zhu" || id === "zhong" || id === "mingzhong") ctx.score -= 0.45 * scale * roundScale;
								else if (id === "nei") ctx.score -= 0.15 * scale * roundScale;
							}
						}
						return;
					}

					// 闪电：劣势更愿意挂；大优势更谨慎（去拆闪电由其他 hook 处理）
					if (cardName === "shandian") {
						const s = getSituationIndex(player, game, get);
						const mode = typeof get?.mode === "function" ? String(get.mode()) : "";
						const modeScale = mode === "identity" ? 0.55 : 1;
						const ahead = s > 0.22;
						const behind = s < -0.22;
						const intensity = clampNumber(Math.abs(s), 0, 1) * modeScale;
						if (behind) ctx.score += 0.95 * intensity;
						if (ahead) ctx.score -= 0.9 * intensity;
						return;
					}

					// 决斗：牌多收割时，若同时存在 AOE，前段略偏向先决斗（轻量，不强制）
					if (cardName === "juedou") {
						const hand = safeCountCards(player, "h");
						if (hand >= 4 && base < 3.2) {
							const hasAOE = all.some(c => typeof c !== "string" && c && (String(c.name || "") === "nanman" || String(c.name || "") === "wanjian"));
							if (hasAOE) ctx.score += 0.22 * earlyFactor;
						}

						// 残局：人数更少时决斗更像“稳定收割”（极轻量）
						const alive = (game.players || []).filter(p => p && !(p.isDead && p.isDead()));
						if (alive.length > 0 && alive.length <= 3) ctx.score += 0.12;
						return;
					}
					return;
				}

				// 2) 选目标：乐/兵（贴马上行动敌人）、火攻（多伤/击杀倾向）、借刀（优先高威胁武器）
				if (ctx.kind === "chooseTarget") {
					if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
					const target = ctx.candidate;
					if (!target || target === player) return;
					if (!isUseCardContext(ctx.event)) return;

					const card = findEventCard(ctx.event);
					const cardName = String(card?.name || "");
					if (!cardName) return;

					// 乐/兵：尽量贴“马上行动”的敌人
					if (cardName === "lebu" || cardName === "bingliang") {
						const mode = typeof get?.mode === "function" ? String(get.mode()) : "";
						if (mode === "identity" && !isExposedEnemyTarget(player, target, game, get)) return;
						const tv = getResultNumberForTarget(card, ctx.event?.skill, player, target, get);
						if (tv >= 0) return;
						const att = safeAttitude(get, player, target);
						if (att > -0.6) return;

						const dist = getTurnOrderDistance(player, target, game);
						if (!Number.isFinite(dist) || dist <= 0) return;
						const urgency = clampNumber((4 - dist) / 3, 0, 1); // dist=1 -> 1, dist=2 -> 0.66, dist=3 -> 0.33

						if (cardName === "lebu") {
							ctx.score += 0.65 * urgency;
							return;
						}

						// 兵粮：整体弱于乐；仅在“压制摸牌系/残局”时更值得
						let drawLike = false;
						if (typeof target?.hasSkillTag === "function") {
							try {
								drawLike = !!target.hasSkillTag("abnormalDraw") || !!target.hasSkillTag("guanxing");
							} catch (e) {
								drawLike = false;
							}
						}
						const alive = (game.players || []).filter(p => p && !(p.isDead && p.isDead()));
						const endgameLike = alive.length > 0 && alive.length <= 3;
						if (drawLike || endgameLike) ctx.score += 0.5 * urgency;
						else ctx.score += 0.18 * urgency;
						return;
					}

					// 火攻：优先“可能击杀/多伤收益”的目标；手牌过少时降低冲动
					if (cardName === "huogong") {
						const tv = getResultNumberForTarget(card, ctx.event?.skill, player, target, get);
						if (tv >= 0) return;
						const att = safeAttitude(get, player, target);
						if (att > -0.6) return;

						const hand = safeCountCards(player, "h");
						const hp = typeof target.hp === "number" && !Number.isNaN(target.hp) ? target.hp : 0;
						const linked = isLinked(target);

						if (hp > 0 && hp <= 2) ctx.score += 0.35;
						if (linked) ctx.score += 0.22;
						if (hand > 4) ctx.score += 0.12;
						if (hand > 0 && hand <= 2) ctx.score -= 0.35;
						return;
					}

					// 借刀：优先处理敌方高威胁武器（尤其诸葛连弩）
					if (cardName === "jiedao") {
						// 说明：借刀是 singleCard + filterAddedTarget 的“二段选目标”牌。
						// - 第一段：选“被借刀者”（需有武器）
						// - 第二段：选“出杀目标”（addedTarget），引擎会把第一段目标放进 ui.selected.targets
						const selected = safeGetSelectedTargets(ctx.event);
						const preTarget = selected.length ? selected[selected.length - 1] : null;
						const isAddedTargetPick = !!preTarget;

						// 友敌阈值：参考身份局证据系统的规则（±0.3 比 ±0.6 更稳健）
						const att = safeAttitude(get, player, target);
						const friendlyLike = att > 0.3;
						const enemyLike = att < -0.3;

						// addedTarget（出杀目标）阶段：强制避免“借队友刀杀自己人”
						if (isAddedTargetPick) {
							// 1) 我方/偏友目标不作为出杀目标（除非无可选项；通过极大惩罚让其几乎不被选）
							if (friendlyLike) {
								ctx.score -= 9999;
								return;
							}

							// 2) 若“被借刀者”偏友，也避免选其偏友目标，降低队友互砍概率
							const preToMe = safeAttitude(get, player, preTarget);
							if (preToMe > 0.3) {
								const preToVictim = safeAttitude(get, preTarget, target);
								if (preToVictim > 0.3) {
									ctx.score -= 9999;
									return;
								}
							}

							// 3) 轻量偏向明确敌对目标；中立目标更保守（避免“乱借刀乱砍”）
							if (enemyLike) ctx.score += 0.55;
							else ctx.score -= 0.2;
							return;
						}

						// 第一段（被借刀者）阶段：只偏向敌方高威胁武器；不鼓励把友方武器当作“借刀目标”
						if (enemyLike) ctx.score += 0.45;
						else if (friendlyLike) {
							// 约束：若自己已有 >1 距离武器，则不向友军借刀（避免无谓消耗与伤害队友）
							try {
								if (typeof player?.getEquipRange === "function") {
									const myEquipRange = player.getEquipRange();
									if (typeof myEquipRange === "number" && Number.isFinite(myEquipRange) && myEquipRange > 1.001) {
										ctx.score -= 9999;
										return;
									}
								}
							} catch (e) {
								// ignore
							}

							// 允许“借友军的刀”，但前提：
							// - 友军手里确有【杀】（避免强行薅走武器）
							// - 友军失去武器后不会明显被卡距离（否则会害队友）
							let hasSha = false;
							if (typeof target?.hasSha === "function") {
								try {
									hasSha = !!target.hasSha();
								} catch (e) {
									hasSha = false;
								}
							}

							if (!hasSha) {
								ctx.score -= 9999;
								return;
							}

							const rangeInfo = estimateWeaponLossDistanceBlockRisk(target, game, get);
							if (!rangeInfo.known || rangeInfo.risk) {
								ctx.score -= 9999;
								return;
							}

							const weapon = rangeInfo.weaponCard || safeGetWeaponCard(target, get);
							const vToMe = weapon ? safeGetCardValue(weapon, player, get) : 0;
							const vToAlly = weapon ? safeGetCardValue(weapon, target, get) : 0;
							const delta = vToMe - vToAlly;

							const meHasWeapon = !!safeGetWeaponCard(player, get);
							const meOffenseNeed = hasImmediateOffenseNeed(player, game, get);

							let bonus = 0.15; // 抵消“对友军用锦囊”的机会成本（但不盖过敌方借刀收益）
							if (!meHasWeapon) bonus += 1.05;
							if (meOffenseNeed) bonus += 0.55;
							if (vToMe >= 5) bonus += 0.6;
							if (delta > 0.5) bonus += clampNumber(delta, 0, 4) * 0.22;
							else if (delta < -0.5) bonus -= clampNumber(-delta, 0, 4) * 0.12;

							// 若武器对友军自身也很关键，则保守降低收益（避免“拿走队友核心武器”）
							if (vToAlly >= 6) bonus -= 0.55;

							ctx.score += bonus;
						}

						// 识别目标武器（仅对“敌方目标”加权；避免误把队友/第二段目标的武器当作收益来源）
						if (enemyLike) {
							const equips = safeGetCards(target, "e");
							let weaponName = "";
							for (const ec of equips) {
								const info = safeGetInfo(ec, get);
								const subtype = String(info?.subtype || ec?.subtype || "");
								if (subtype === "equip1") {
									weaponName = String(ec?.name || "");
									break;
								}
							}
							if (weaponName === "zhuge") ctx.score += 0.75;
							else if (weaponName === "guding" || weaponName === "zhuque") ctx.score += 0.35;
						}
						return;
					}
					return;
				}

				// 3) 选按钮：五谷选牌优先级（乐 > 桃/无懈/aoe > 其他）
				if (ctx.kind === "chooseButton") {
					const eventCard = findEventCard(ctx.event);
					if (String(eventCard?.name || "") !== "wugu") return;
					const link = ctx.candidate?.link;
					const name = String(link?.name || "");
					if (!name) return;

					// 最高优先：乐不思蜀
					if (name === "lebu") {
						ctx.score += 2.2;
						return;
					}

					// 次优先：桃 / 无懈 / AOE
					if (name === "tao") {
						ctx.score += 1.35;
						return;
					}
					if (name === "wuxie") {
						ctx.score += 1.25;
						return;
					}
					if (name === "nanman" || name === "wanjian") {
						ctx.score += 1.05;
						return;
					}
				}
			},
			{ priority: 4 }
		);
	}

	// 通用技巧：锦囊牌通用技巧（同段落：铁索/拆顺/无中/无懈）
	// 说明：依然以基础收益为主，只在“局势/阶段/目标状态”较明确时做轻量影响。
	if (!game.__slqjAiPersona._trickSpecificTipsHookInstalled) {
		game.__slqjAiPersona._trickSpecificTipsHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.stage !== "final") return;
				const player = ctx.player;
				if (!player) return;

				// 1) 选牌：无中生有（溢出折损）/ 铁索重铸 / 无懈可击（仅响应决策）
				if (ctx.kind === "chooseCard") {
					const candidate = ctx.candidate;
					if (!candidate) return;

					// 1.1 无懈可击：仅处理“是否出无懈”的响应决策
					if (isAskWuxieEvent(ctx.event)) {
						if (typeof get?.itemtype === "function" && get.itemtype(candidate) !== "card") return;
						const card = candidate;
						if (!isWuxieCard(card)) return;

						const map = resolveWuxieInfoMap(ctx.event);
						const respondTo = Array.isArray(ctx.event?.respondTo) ? ctx.event.respondTo : null;
						const source = respondTo?.[0] || map?.player || null;
						const respondCard = respondTo?.[1] || map?.card || null;
						const respondName = String(respondCard?.name || respondCard?.viewAs || "");

						const firstTarget = map?.target || (Array.isArray(map?.targets) ? map.targets[0] : null);
						const allTargets = Array.isArray(map?.targets) ? map.targets : null;

						// 0) 行为规则：我不无懈自己的锦囊（直接取消），但会反无懈保护自己的锦囊生效
						if (respondName === "wuxie") {
							const info = resolveWuxieChain(ctx.event, get);
							if (
								info &&
								info.player === player &&
								(isNormalTrickCard(info.card, get) || isDelayTrickCard(info.card, get))
							) {
								// 原始牌是我出的：更倾向反无懈，让它生效
								ctx.score += 2.4;
								return;
							}
						} else if (respondName && source === player) {
							// 原始牌是我出的：不主动用无懈取消自己的锦囊
							if (isNormalTrickCard(respondCard, get) || isDelayTrickCard(respondCard, get)) {
								ctx.score -= 9999;
								return;
							}
						}

						// ① 最重要：管乐；敌方中乐则不管
						if (respondName === "lebu") {
							const t = firstTarget;
							const att = t ? safeAttitude(get, player, t) : 0;
							if (att > 0.6) ctx.score += 2.2;
							else if (att < -0.6) ctx.score -= 1.6;
							return;
						}

						// 次重要：兵粮（弱于乐，仍可适度处理）
						if (respondName === "bingliang") {
							const t = firstTarget;
							const att = t ? safeAttitude(get, player, t) : 0;
							if (att > 0.6) ctx.score += 1.15;
							else if (att < -0.6) ctx.score -= 0.85;
							return;
						}

						// ② 拆顺：手牌一般不管；但拆延时锦囊/关键装备时更值得无懈
						if (respondName === "guohe" || respondName === "shunshou") {
							let delta = -1.1;
							const t = firstTarget;
							const att = t ? safeAttitude(get, player, t) : 0;
							if (t && att > 0.6) {
								const j = safeGetCards(t, "j");
								const e = safeGetCards(t, "e");
								const hasKeyDelay = j.some(c => {
									const n = String(c?.viewAs || c?.name || "");
									return n === "lebu" || n === "bingliang" || n === "shandian" || n === "fulei";
								});
								const hasKeyEquip = e.some(c => {
									const name = String(c?.name || "");
									if (name === "zhuge") return true;
									if (typeof get?.value !== "function") return false;
									try {
										return get.value(c, t) >= 6;
									} catch (e) {
										return false;
									}
								});
								if (hasKeyDelay || hasKeyEquip) delta = 1.0;
							}
							ctx.score += delta;
							return;
						}

						// ③ 火攻/铁索/借刀：一般不管，除非明显 2 伤+ / 击杀风险（用“低血线/高负效应”做代理）
						if (respondName === "huogong" || respondName === "tiesuo" || respondName === "jiedao") {
							let delta = -0.9;
							const t = firstTarget;
							const att = t ? safeAttitude(get, player, t) : 0;
							if (t && att > 0.6) {
								const hp = typeof t.hp === "number" && !Number.isNaN(t.hp) ? t.hp : 0;
								if (hp > 0 && hp <= 1) delta = Math.max(delta, 1.6);
							}
							if (t && source && typeof get?.effect === "function") {
								try {
									const eff = get.effect(t, respondCard, source, player);
									if (typeof eff === "number" && eff <= -2) delta = Math.max(delta, 1.2);
								} catch (e) {
									// ignore
								}
							}
							ctx.score += delta;
							return;
						}

						// ④ 无中：牌多的可以不管；牌少或额外收益再管（用“手牌溢出/低手牌”做代理）
						if (respondName === "wuzhong") {
							let delta = -0.6;
							if (source) {
								const { hand, overflow } = getHandStorageInfo(source);
								if (overflow <= 0 && hand > 0 && hand <= 2) delta = 0.7;
								if (overflow >= 1) delta -= 0.8;
							}
							ctx.score += delta;
							return;
						}

						// ⑤ 伤害锦囊：优先管“最后一下”（用“己方残血目标”做代理）
						if (respondName === "nanman" || respondName === "wanjian" || respondName === "juedou") {
							const list = allTargets && allTargets.length ? allTargets : firstTarget ? [firstTarget] : [];
							for (const t of list) {
								if (!t) continue;
								const att = safeAttitude(get, player, t);
								if (att <= 0.6) continue;
								const hp = typeof t.hp === "number" && !Number.isNaN(t.hp) ? t.hp : 0;
								if (hp > 0 && hp <= 1) {
									ctx.score += 1.4;
									return;
								}
							}
						}
						return;
					}

					// 1.2 出牌阶段：无中生有在“手牌溢出”时收益折损（轻量）
					if (typeof candidate !== "string") {
						if (typeof get?.itemtype === "function" && get.itemtype(candidate) !== "card") return;
						const card = candidate;
						if (!card) return;
						if (String(card?.name || "") === "wuzhong" && isPhaseUseContext(ctx.event)) {
							const { overflow } = getHandStorageInfo(player);
							if (overflow >= 1) ctx.score -= 0.35 * clampNumber(Math.min(overflow, 4), 1, 4);
							return;
						}

						// 1.3 重铸选牌：无属性伤害来源且无明显铁索目标时，温和倾向重铸铁索
						if (String(card?.name || "") === "tiesuo" && isRecastCardSelectContext(ctx.event)) {
							if (!hasElementalDamageSource(player, get)) ctx.score += 0.55;
						}
						return;
					}

					// 1.4 出牌阶段：没有属性伤害来源且无明显铁索目标时，温和倾向走“重铸”把铁索早点换掉
					if (!isRecastSkillCandidate(candidate)) return;
					if (!isPhaseUseContext(ctx.event)) return;

					const hs = safeGetCards(player, "h");
					const hasTiesuo = hs.some(c => String(c?.name || "") === "tiesuo");
					if (!hasTiesuo) return;
					if (hasElementalDamageSource(player, get)) return;

					// 若自己/友方已有“铁索隐患”需要解锁，则不鼓励改去重铸
					let hasUnchainNeed = false;
					for (const p of game.players || []) {
						if (!p || (typeof p.isDead === "function" && p.isDead())) continue;
						const att = safeAttitude(get, player, p);
						if (p === player || att > 0.6) {
							if (isLinked(p)) {
								hasUnchainNeed = true;
								break;
							}
						}
					}
					if (hasUnchainNeed) return;

					// 逆风时若存在“可连敌方”机会，也不强推去重铸（仍交给基础收益决策）
					const s = getSituationIndex(player, game, get);
					const behind = s < -0.22;
					if (behind) {
						let hasChainOpportunity = false;
						for (const p of game.players || []) {
							if (!p || (typeof p.isDead === "function" && p.isDead())) continue;
							const att = safeAttitude(get, player, p);
							if (att > -0.6) continue;
							if (isLinked(p)) continue;
							if (isMaixieLikeTarget(p)) continue;
							hasChainOpportunity = true;
							break;
						}
						if (hasChainOpportunity) return;
					}

					ctx.score += 0.35;
					return;
				}

				// 2) 选目标：拆顺更关注“关键目标”（关键延时/关键装备/蓄爆/未行动）
				if (ctx.kind === "chooseTarget") {
					if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
					const target = ctx.candidate;
					if (!target || target === player) return;
					if (!isUseCardContext(ctx.event)) return;

					const card = findEventCard(ctx.event);
					const cardName = String(card?.name || "");
					if (cardName !== "guohe" && cardName !== "shunshou") return;

					const tv = getResultNumberForTarget(card, ctx.event?.skill, player, target, get);
					if (tv === 0) return;
					const att = safeAttitude(get, player, target);

					// 2.1 拆顺队友：若目标被关键延时控制（乐/兵/闪电），更值得用拆顺处理
					if (tv > 0 && att > 0.6) {
						const j = safeGetCards(target, "j");
						const hasLebu = j.some(c => String(c?.viewAs || c?.name || "") === "lebu");
						const hasBingliang = j.some(c => String(c?.viewAs || c?.name || "") === "bingliang");
						const hasShandian = j.some(c => {
							const n = String(c?.viewAs || c?.name || "");
							return n === "shandian" || n === "fulei";
						});
						if (hasLebu) ctx.score += 0.6;
						if (hasShandian) ctx.score += 0.45;
						if (hasBingliang) ctx.score += 0.35;
						return;
					}

					// 2.2 拆顺敌方：起手/蓄爆/关键装备更值得拆顺
					if (tv < 0 && att < -0.6) {
						// 起手牌/未行动：更可能好牌多、尚未展开
						if (hasNotActedYetThisRound(player, target)) ctx.score += 0.18;

						// 蓄爆（启发式）：手牌更多
						const hand = safeCountCards(target, "h");
						if (hand >= 5) ctx.score += 0.25;
						else if (hand >= 4) ctx.score += 0.12;

						// 关键装备（启发式）：高价值装备 + 特判连弩
						const e = safeGetCards(target, "e");
						let equipBonus = 0;
						for (const ec of e) {
							const name = String(ec?.name || "");
							if (name === "zhuge") equipBonus = Math.max(equipBonus, 0.45);
							if (typeof get?.value === "function") {
								try {
									const v = get.value(ec, target);
									if (typeof v === "number" && !Number.isNaN(v) && v >= 6) equipBonus = Math.max(equipBonus, 0.35);
								} catch (e) {
									// ignore
								}
							}
						}
						ctx.score += equipBonus;
					}
					return;
				}

				// 3) 选按钮：拆顺选牌优先级（关键延时/关键装备等）
				if (ctx.kind === "chooseButton") {
					const eventCard = findEventCard(ctx.event);
					const cardName = String(eventCard?.name || "");
					if (cardName !== "guohe" && cardName !== "shunshou") return;

					const link = ctx.candidate?.link;
					if (!link) return;

					// 尽量从事件里拿 owner（choosePlayerCard/discardPlayerCard 都会写 target）
					const owner = ctx.event?.target || (typeof get?.owner === "function" ? get.owner(link) : null);
					const att = owner ? safeAttitude(get, player, owner) : 0;

					let pos = "";
					try {
						pos = typeof get?.position === "function" ? String(get.position(link) || "") : "";
					} catch (e) {
						pos = "";
					}

					// 判定区：对友方优先拆“负面延时”，对敌方则不必帮其解控
					if (pos === "j") {
						const viewAs = String(link?.viewAs || link?.name || "");
						if (att > 0.6) {
							if (viewAs === "lebu") ctx.score += 2.0;
							else if (viewAs === "shandian" || viewAs === "fulei") ctx.score += 1.6;
							else if (viewAs === "bingliang") ctx.score += 1.2;
						} else if (att < -0.6) {
							if (viewAs === "lebu") ctx.score -= 1.2;
							else if (viewAs === "shandian" || viewAs === "fulei") ctx.score -= 0.8;
							else if (viewAs === "bingliang") ctx.score -= 0.6;
						}
						return;
					}

					// 装备区：优先拆敌方高价值装备（关键装备）
					if (pos === "e") {
						const name = String(link?.name || "");
						if (att < -0.6 && name === "zhuge") ctx.score += 0.45;
						if (owner && typeof get?.value === "function") {
							try {
								const v = get.value(link, owner);
								if (typeof v === "number" && !Number.isNaN(v) && v >= 6) {
									if (att < -0.6) ctx.score += 0.8;
									else if (att > 0.6) ctx.score -= 0.7;
								}
							} catch (e) {
								// ignore
							}
						}
						return;
					}

					// 手牌：若明确可见桃（或选牌可见），拆掉桃通常更关键
					if (pos === "h") {
						const name = String(link?.name || "");
						if (att < -0.6 && name === "tao") ctx.score += 0.55;
					}
				}
			},
			{ priority: 4 }
		);
	}

	// 扩展策略：顺风求稳，逆风求变（跨模式通用；identity 下会叠加已有的更强门槛，因此此处默认更“轻”）
	if (!game.__slqjAiPersona._situationTempoHookInstalled) {
		game.__slqjAiPersona._situationTempoHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.stage !== "final") return;
				const player = ctx.player;
				if (!player) return;

				const s = getSituationIndex(player, game, get);
				// identity 模式已有强门槛：这里降低权重避免过度叠加
				const mode = typeof get?.mode === "function" ? String(get.mode()) : "";
				const modeScale = mode === "identity" ? 0.55 : 1;

				const ahead = s > 0.22;
				const behind = s < -0.22;
				const intensity = clampNumber(Math.abs(s), 0, 1) * modeScale;

				// 1) 选牌：群体牌（AOE / 五谷 / 桃园）随局势调整“求稳/求变”倾向
				if (ctx.kind === "chooseCard") {
					if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
					const card = ctx.candidate;
					if (!card) return;

					if (isOffensiveGroupTrickCard(card, player, game, get)) {
						// 逆风更愿意用 AOE 搏局，顺风更谨慎以减少变数
						if (behind) ctx.score += 0.9 * intensity;
						if (ahead) ctx.score -= 0.7 * intensity;
						return;
					}

					if (isBeneficialGroupTrickCard(card, player, game, get)) {
						const name = String(card?.name || "");
						// 五谷：逆风容忍“给全场送资源”来求变；顺风则倾向稳步推进，避免给敌方补强
						if (name === "wugu") {
							if (behind) ctx.score += 1.1 * intensity;
							if (ahead) ctx.score -= 0.9 * intensity;
							return;
						}
						// 桃园：顺风更倾向用来巩固血线；逆风优先考虑制造破口（AOE/拆顺等）
						if (name === "taoyuan") {
							if (ahead) ctx.score += 0.6 * intensity;
							if (behind) ctx.score -= 0.35 * intensity;
							return;
						}

						// 其他群体有益牌：顺风更保守，逆风略放宽
						if (behind) ctx.score += 0.45 * intensity;
						if (ahead) ctx.score -= 0.45 * intensity;
					}

					return;
				}

				// 2) 选目标：顺风减少“喂卖血/制造铁索隐患”，逆风放宽“制造变数”的行为
				if (ctx.kind === "chooseTarget") {
					if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
					const target = ctx.candidate;
					if (!target) return;

					const card = findEventCard(ctx.event);
					const cardName = String(card?.name || "");
					const tv = getTargetUseValueFromEvent(player, target, ctx.event, get);

					const att = safeAttitude(get, player, target);
					const friendlyLike = target === player || att > 0.6;
					const enemyLike = att < -0.6;

					// 卖血门槛：进攻前评估“对方受伤后能赚多少收益”，据此决定是否值得喂卖血。
					if (tv < 0 && enemyLike && isDamageLikeChooseTargetEvent(ctx.event, get)) {
						const mx = estimateMaixieRewardOnDamaged(target, ctx.event, get);
						if (mx.isMaixie && mx.reward > 0) {
							const hp = typeof target.hp === "number" && !Number.isNaN(target.hp) ? target.hp : 0;
							const lowHpScale = hp <= 1 ? 0.6 : hp <= 2 ? 0.8 : 1;

							// tv 越“有害”（对目标越痛），越值得承受一定卖血收益，因此轻度减弱惩罚
							const harm = clampNumber(-tv, 0, 6);
							const harmScale = clampNumber(1.1 - harm * 0.08, 0.6, 1.1);

							// 顺风更谨慎，逆风仍保留轻度门槛（但不强行“弃攻”）
							const situationScale = ahead
								? 0.9 + 0.7 * intensity
								: behind
									? 0.35 + 0.35 * intensity
									: 0.65 + 0.5 * intensity;

							const penalty = mx.reward * situationScale * lowHpScale * harmScale * modeScale;
							ctx.score -= penalty;
						}
					}

					// 顺风：优先“解铁索”而不是“乱连铁索”（尤其避免把自己/友方从未连变为已连）
					// 逆风：更容忍连锁（求变），但仍尽量避免把敌方卖血将作为铁索起点
					if (cardName === "tiesuo") {
						const linked = isLinked(target);

						// 敌方卖血将：尽量不“新连上”（解锁则更好）
						if (enemyLike && isMaixieLikeTarget(target)) {
							// 已连：顺手解锁；未连：减少把其作为铁索起点的冲动（顺风时已有通用卖血门槛，这里更轻）
							if (linked) ctx.score += 0.35 * intensity;
							else if (!ahead) ctx.score -= 0.55 * (0.4 + 0.6 * intensity);
						}

						// 顺风：友方/自己已连 -> 加分（倾向解锁）；未连 -> 扣分（避免制造隐患）
						if (ahead && friendlyLike) {
							if (linked) ctx.score += 0.75 * intensity;
							else ctx.score -= 0.55 * intensity;
						}

						// 顺风：敌方已连也更倾向解锁（排除铁索隐患）；未连则更谨慎
						if (ahead && enemyLike) {
							if (linked) ctx.score += 0.35 * intensity;
							else ctx.score -= 0.25 * intensity;
						}

						// 逆风：更容忍连锁搏局（不强行反向加分，避免误伤）
						if (behind && enemyLike && !linked) {
							ctx.score += 0.35 * intensity;
						}
					}

					// 顺风：拆掉闪电/连弩（在选目标阶段先提高命中目标的倾向）
					if (ahead && (cardName === "guohe" || cardName === "shunshou")) {
						const j = safeGetCards(target, "j");
						const e = safeGetCards(target, "e");
						const hasShandian = j.some(c => String(c?.name || "") === "shandian");
						const hasZhuge = e.some(c => String(c?.name || "") === "zhuge");
						if (hasShandian) ctx.score += 1.0 * intensity;
						if (hasZhuge) ctx.score += 0.75 * intensity;
					}

					return;
				}

				// 3) 选按钮：在拆/顺/拿牌等场景，顺风更优先处理“闪电/连弩”等高波动风险源
				if (ctx.kind === "chooseButton") {
					const link = ctx.candidate?.link;
					const name = String(link?.name || "");
					if (name !== "shandian" && name !== "zhuge") return;

					// 顺风更强烈；逆风仍保留轻度偏好（去掉连弩/闪电通常也提升胜率）
					if (ahead) {
						ctx.score += (name === "shandian" ? 1.35 : 1.05) * intensity;
						return;
					}
					if (behind) {
						ctx.score += (name === "shandian" ? 0.45 : 0.35) * intensity;
					}
				}
			},
			{ priority: 4 }
		);
	}

	// 行为规则：「刚刚被我攻击的人我不救」（仅本次结算链内生效）
	if (!game.__slqjAiPersona._noRescueRecentAttackHookInstalled) {
		game.__slqjAiPersona._noRescueRecentAttackHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const player = ctx.player;
				const target = ctx.candidate;
				if (!player || !target) return;

				const recent = player?.storage?.[STORAGE_KEY]?.runtime?.recentAttack;
				if (!recent || !recent.targetPid) return;
				if (getPid(target) !== recent.targetPid) return;

				if (!isRescueLikeChooseTargetEvent(ctx.event, player, get)) return;

				// 强制不救：不做任何例外（即便主公/高好感）
				ctx.score -= 9999;
			},
			{ priority: 7 }
		);
	}

	// 默认策略：桃更关键，优先留给“已暴露且友方”的目标，避免拿桃去救不明身份的“友方”
	if (!game.__slqjAiPersona._taoReserveHookInstalled) {
		game.__slqjAiPersona._taoReserveHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				const card = findEventCard(ctx.event);
				if (!isTaoCard(card)) return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const target = ctx.candidate;
				if (!shouldReserveTao(ctx.player, target, game, get)) return;
				const taoCount = typeof ctx.player?.countCards === "function" ? ctx.player.countCards("h", "tao") : 1;
				const dying = target && (target.hp <= 0 || (typeof target.isDying === "function" && target.isDying()));
				let penalty = taoCount <= 1 ? 5 : 2.5;
				if (dying) penalty *= 0.5;
				ctx.score -= penalty;
			},
			{ priority: 5 }
		);
	}

	// 默认策略：延时锦囊不贸然下给“未暴露”的目标，避免误伤潜在友军（identity 模式）
	if (!game.__slqjAiPersona._delayTrickTargetHookInstalled) {
		game.__slqjAiPersona._delayTrickTargetHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (get?.mode?.() !== "identity") return;
				const card = findEventCard(ctx.event);
				if (!isDelayTrickCard(card, get)) return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const target = ctx.candidate;
				if (isExposedEnemyTarget(ctx.player, target, game, get)) return;
				ctx.score -= 8;
			},
			{ priority: 5 }
		);
	}

	// 默认策略：其他锦囊（type=trick）同样不乱用：
	// - 有害锦囊：只对“已暴露且敌对”的目标使用
	// - 有益锦囊：只对“已暴露且友方”的目标使用（自用不受限）
	if (!game.__slqjAiPersona._trickTargetSafetyHookInstalled) {
		game.__slqjAiPersona._trickTargetSafetyHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseTarget" || ctx.stage !== "final") return;
				if (get?.mode?.() !== "identity") return;
				const card = findEventCard(ctx.event);
				if (!isNormalTrickCard(card, get)) return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "player") return;
				const target = ctx.candidate;
				if (!target) return;
				if (target === ctx.player) return; // 自用允许（例如部分锦囊可指定自己）

				const tv = getResultNumberForTarget(card, ctx.event?.skill, ctx.player, target, get);
				if (tv === 0) return; // 影响不明确：不做强约束

				if (tv < 0) {
					if (isExposedEnemyTarget(ctx.player, target, game, get)) return;
					ctx.score -= 7;
					return;
				}

				// tv > 0：有益锦囊
				if (isExposedFriendlyTarget(ctx.player, target, game, get)) return;
				ctx.score -= 6;
			},
			{ priority: 5 }
		);
	}

	// 默认策略：群体进攻锦囊（跨卡牌包通用识别）仅在“排除死亡后再排除内奸，友军人数 < 敌军人数”时使用
	if (!game.__slqjAiPersona._groupTrickGateHookInstalled) {
		game.__slqjAiPersona._groupTrickGateHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				if (typeof ctx.base === "number" && ctx.base <= 0) return;
				if (get?.mode?.() !== "identity") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
				const card = ctx.candidate;
				if (!isOffensiveGroupTrickCard(card, ctx.player, game, get)) return;
				if (shouldUseOffensiveGroupTrick(ctx.player, game, get)) return;
				ctx.score -= 9;
			},
			{ priority: 5 }
		);
	}

	// 默认策略：群体有益锦囊（跨卡牌包同类牌）也不乱开
	if (!game.__slqjAiPersona._groupBeneficialTrickGateHookInstalled) {
		game.__slqjAiPersona._groupBeneficialTrickGateHookInstalled = true;
		hooks.on(
			"slqj_ai_score",
			ctx => {
				if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
				if (typeof ctx.base === "number" && ctx.base <= 0) return;
				if (get?.mode?.() !== "identity") return;
				if (typeof get?.itemtype === "function" && get.itemtype(ctx.candidate) !== "card") return;
				const card = ctx.candidate;
				if (!isBeneficialGroupTrickCard(card, ctx.player, game, get)) return;
				if (shouldUseBeneficialGroupTrick(ctx.player, game, get, card)) return;
				ctx.score -= 9;
			},
			{ priority: 5 }
		);
	}
}
