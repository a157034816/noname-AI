import { STORAGE_KEY } from "../lib/constants.js";

/**
 * 确保 lib.skill[name] 存在（缺失则写入默认定义）。
 *
 * @param {*} lib
 * @param {string} name
 * @param {*} def
 * @returns {void}
 */
function ensureSkill(lib, name, def) {
	if (!lib.skill[name]) lib.skill[name] = def;
}

/**
 * 安装人格系统所需的全局技能（inspect/init/统计/回合/事件等）。
 *
 * 注意：skill.content 执行环境可能丢失模块闭包变量，因此 content 内只通过
 * `game.__slqjAiPersona.*` 间接访问运行时逻辑。
 *
 * @param {{lib:any, game:any, get:any, _status:any}} param0
 * @returns {void}
 */
export function installPersonaSkills({ lib, game, get, _status }) {
	const inspectLang = game?.__slqjAiPersona?.cfg?.inspectLang || "en";

	ensureSkill(lib, "slqj_ai_inspect", {
		mark: true,
		charlotte: true,
		marktext: inspectLang === "zh" ? "AI" : "AI",
		popup: false,
		nopop: true,
		intro: {
			name: inspectLang === "zh" ? "AI面板" : "AIPanel",
			content(storage, player) {
				const lang = game.__slqjAiPersona?.cfg?.inspectLang || "en";
				return (
					game.__slqjAiPersona?.buildInspectText?.(player, game, get, lang) ||
					game.__slqjAiPersona?.getInspectNoDataText?.(lang) ||
					""
				);
			},
		},
	});

	ensureSkill(lib, "slqj_ai_init", {
		trigger: { global: ["gameStart", "roundStart"] },
		forced: true,
		silent: true,
		popup: false,
		priority: Infinity,
		filter(event, player) {
			return player === game.me && !game.__slqjAiPersona?._initOnceDone;
		},
		content() {
			game.__slqjAiPersona._initOnceDone = true;
			game.removeGlobalSkill("slqj_ai_init");
			game.__slqjAiPersona?.initAllPlayersStats?.(game);
			game.__slqjAiPersona?.initAllAiPlayers?.(game, _status);

			// 为所有角色挂上查看标记（仅本地）
			if (game.__slqjAiPersona?.cfg?.inspectEnable) {
				for (const p of game.players) {
					if (!p) continue;
					if (typeof p.addSkill !== "function") continue;
					if (typeof p.hasSkill === "function" && p.hasSkill("slqj_ai_inspect")) continue;
					p.addSkill("slqj_ai_inspect");
				}
			}
		},
	});
	game.addGlobalSkill("slqj_ai_init");

	// AI 标记：引擎默认会在死亡时清理 marks；这里将 slqj_ai_inspect 加入 die 事件的 excludeMark，便于死亡后仍可查看面板
	ensureSkill(lib, "slqj_ai_inspect_keep_on_die", {
		trigger: { global: "die" },
		forced: true,
		silent: true,
		popup: false,
		priority: Infinity,
		filter(event, player) {
			if (_status.connectMode) return false;
			const g = typeof game !== "undefined" ? game : globalThis.game;
			return !!g?.__slqjAiPersona?.cfg?.inspectEnable;
		},
		content() {
			try {
				const ex = Array.isArray(trigger.excludeMark) ? trigger.excludeMark : [];
				if (!ex.includes("slqj_ai_inspect")) ex.push("slqj_ai_inspect");
				trigger.excludeMark = ex;
			} catch (e) {}
		},
	});
	game.addGlobalSkill("slqj_ai_inspect_keep_on_die");

	// 统计：过牌量（drawAfter）与造成伤害量（damageEnd），用于“输出核心”判定与面板展示
	ensureSkill(lib, "slqj_ai_stat_draw", {
		trigger: { player: "drawAfter" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			return !!player;
		},
		content() {
			const n = trigger.num || (trigger.cards && trigger.cards.length) || 0;
			if (n > 0) game.__slqjAiPersona?.addDrawStat?.(player, n, game);
			game.__slqjAiPersona?.onDrawAfterTurnMemory?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_stat_draw");

	ensureSkill(lib, "slqj_ai_stat_damage", {
		trigger: { source: "damageEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			return !!player;
		},
		content() {
			const n = trigger.num || 1;
			if (n > 0) game.__slqjAiPersona?.addDamageDealtStat?.(player, n, game);
		},
	});
	game.addGlobalSkill("slqj_ai_stat_damage");

	// 基本牌节奏推断：对手【杀】出的越快，越可能“杀多”（仅用公开信息，不读暗牌）
	ensureSkill(lib, "slqj_ai_basic_tempo", {
		trigger: { player: "useCardAfter" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (!event || !event.card) return false;
			return String(event.card.name || "") === "sha";
		},
		content() {
			game.__slqjAiPersona?.onUseCardAfterBasicTempo?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_basic_tempo");

	// 行为规则：「刚刚被我攻击的人我不救」
	// - 仅记录“单目标主动进攻”所指向的目标
	// - 窗口：本次结算链（useCardToTargeted -> useCardAfter）
	ensureSkill(lib, "slqj_ai_recent_attack_mark", {
		trigger: { player: "useCardToTargeted" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (!event || !event.card || !event.target) return false;
			return game.__slqjAiPersona?.isAiPersonaTrackedPlayer?.(player, game, _status);
		},
		content() {
			game.__slqjAiPersona?.onRecentAttackMark?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_recent_attack_mark");

	ensureSkill(lib, "slqj_ai_recent_attack_clear", {
		trigger: { player: "useCardAfter" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (!event) return false;
			if (!game.__slqjAiPersona?.isAiPersonaTrackedPlayer?.(player, game, _status)) return false;
			const st = player?.storage?.[STORAGE_KEY];
			return !!st?.runtime?.recentAttack;
		},
		content() {
			game.__slqjAiPersona?.onRecentAttackClear?.(trigger, player);
		},
	});
	game.addGlobalSkill("slqj_ai_recent_attack_clear");

	// 行为规则：「刚刚被我攻击的人我不救」（chooseUseTarget -> chooseBool 分支兜底）
	// - 典型场景：濒死阶段用【桃】救人（【桃】常见为 selectTarget:-1，chooseUseTarget 会走 chooseBool）
	ensureSkill(lib, "slqj_ai_no_rescue_recent_attack_chooseBool", {
		trigger: { player: "chooseBoolBegin" },
		forced: true,
		silent: true,
		popup: false,
		priority: Infinity,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (!event || !player) return false;
			if (!game.__slqjAiPersona?.isLocalAIPlayer?.(player, game, _status)) return false;
			const st = player?.storage?.[STORAGE_KEY];
			if (!st?.persona) return false;
			if (!st?.runtime?.recentAttack?.targetPid) return false;
			return !!game.__slqjAiPersona?.shouldForbidRescueRecentAttackInChooseBool?.(event, player, game, get);
		},
		content() {
			// 强制不救：覆盖本次 chooseBool 的默认 choice/ai
			trigger.choice = false;
			trigger.ai = function () {
				return false;
			};
		},
	});
	game.addGlobalSkill("slqj_ai_no_rescue_recent_attack_chooseBool");

	// 行为规则：主公首轮全暗时，群攻可直接使用（用于试探信息）
	ensureSkill(lib, "slqj_ai_zhu_round1_aoe_probe_chooseBool", {
		trigger: { player: "chooseBoolBegin" },
		forced: true,
		silent: true,
		popup: false,
		priority: Infinity,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (!event || !player) return false;
			if (!game.__slqjAiPersona?.isLocalAIPlayer?.(player, game, _status)) return false;
			const st = player?.storage?.[STORAGE_KEY];
			if (!st?.persona) return false;
			return !!game.__slqjAiPersona?.shouldForceZhuRound1AoeProbeInChooseBool?.(event, player, game, get);
		},
		content() {
			// 强制使用：覆盖本次 chooseBool 的默认 choice/ai
			trigger.choice = true;
			trigger.ai = function () {
				return true;
			};
		},
	});
	game.addGlobalSkill("slqj_ai_zhu_round1_aoe_probe_chooseBool");

	ensureSkill(lib, "slqj_ai_turn", {
		trigger: { global: "phaseBeginStart" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			return player === game.me && game.__slqjAiPersona?.isAiPersonaTrackedPlayer?.(event.player, game, _status);
		},
		content() {
			game.__slqjAiPersona?.incTurnsTaken?.(trigger.player);
			game.__slqjAiPersona?.decayMentalModel?.(trigger.player);
		},
	});
	game.addGlobalSkill("slqj_ai_turn");

	// 回合记忆：每回合清空一次，并记录本回合的扣血/加血/弃牌/摸牌（含来源）
	ensureSkill(lib, "slqj_ai_turn_memory_reset", {
		trigger: { global: "phaseBeginStart" },
		forced: true,
		silent: true,
		popup: false,
		priority: Infinity,
		filter(event, player) {
			if (_status.connectMode) return false;
			return !!event && !!event.player;
		},
		content() {
			game.__slqjAiPersona?.onPhaseBeginStartTurnMemoryReset?.(trigger, game, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_turn_memory_reset");

	ensureSkill(lib, "slqj_ai_turn_memory_damage", {
		trigger: { player: "damageEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			return !!(event && player);
		},
		content() {
			game.__slqjAiPersona?.onDamageEndTurnMemory?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_turn_memory_damage");

	ensureSkill(lib, "slqj_ai_turn_memory_losehp", {
		trigger: { player: "loseHpEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			return !!(event && player);
		},
		content() {
			game.__slqjAiPersona?.onLoseHpEndTurnMemory?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_turn_memory_losehp");

	ensureSkill(lib, "slqj_ai_turn_memory_recover", {
		trigger: { player: "recoverEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			const n = typeof event?.num === "number" && !Number.isNaN(event.num) ? event.num : 1;
			if (n <= 0) return false;
			return !!player;
		},
		content() {
			game.__slqjAiPersona?.onRecoverEndTurnMemory?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_turn_memory_recover");

	ensureSkill(lib, "slqj_ai_turn_memory_discard", {
		trigger: { player: "discardAfter" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			return !!(player && event && Array.isArray(event.cards) && event.cards.length);
		},
		content() {
			game.__slqjAiPersona?.onDiscardAfterTurnMemory?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_turn_memory_discard");

	ensureSkill(lib, "slqj_ai_turn_memory_lose_to_discardpile", {
		trigger: { player: "loseToDiscardpileAfter" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			return !!(player && event && Array.isArray(event.cards) && event.cards.length);
		},
		content() {
			game.__slqjAiPersona?.onLoseToDiscardpileAfterTurnMemory?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_turn_memory_lose_to_discardpile");

	ensureSkill(lib, "slqj_ai_damage", {
		trigger: { player: "damageEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			// 身份局：主公受伤属于全场公开信息；即便主公是人类玩家，也需要让观察者记录线索。
			if (!player) return false;
			if (get?.mode?.() === "identity" && game?.zhu && player === game.zhu) return true;
			return game.__slqjAiPersona?.isAiPersonaTrackedPlayer?.(player, game, _status);
		},
		content() {
			game.__slqjAiPersona?.onDamageEnd?.(trigger, player, game, get, _status);
			game.__slqjAiPersona?.onDamageEndRage?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_damage");

	ensureSkill(lib, "slqj_ai_recover", {
		trigger: { player: "recoverEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			return get.mode() === "identity" && player === game.zhu;
		},
		content() {
			game.__slqjAiPersona?.onRecoverEnd?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_recover");

	// 情绪：怒气（受伤/拆顺/加血）
	ensureSkill(lib, "slqj_ai_rage_recover", {
		trigger: { player: "recoverEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (!event || !player) return false;
			const n = typeof event.num === "number" && !Number.isNaN(event.num) ? event.num : 1;
			if (n <= 0) return false;
			return game.__slqjAiPersona?.isAiPersonaTrackedPlayer?.(player, game, _status);
		},
		content() {
			game.__slqjAiPersona?.onRecoverEndRage?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_rage_recover");

	ensureSkill(lib, "slqj_ai_rage_guohe", {
		trigger: { player: "rewriteDiscardResult" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (!event || !player) return false;
			const parent = typeof event.getParent === "function" ? event.getParent() : null;
			if (String(parent?.name || "") !== "guohe") return false;
			const target = event.target;
			if (!target || target === player) return false;
			return game.__slqjAiPersona?.isAiPersonaTrackedPlayer?.(target, game, _status);
		},
		content() {
			game.__slqjAiPersona?.onRewriteDiscardResultRage?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_rage_guohe");

	ensureSkill(lib, "slqj_ai_rage_shunshou", {
		trigger: { player: "rewriteGainResult" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (!event || !player) return false;
			const parent = typeof event.getParent === "function" ? event.getParent() : null;
			if (String(parent?.name || "") !== "shunshou") return false;
			const target = event.target;
			if (!target || target === player) return false;
			return game.__slqjAiPersona?.isAiPersonaTrackedPlayer?.(target, game, _status);
		},
		content() {
			game.__slqjAiPersona?.onRewriteGainResultRage?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_rage_shunshou");

	// 身份局：敌友判断因素（行为→证据）—— 兜底：非主公的伤害结算（补齐缺少 ai.result 的技能/效果）
	ensureSkill(lib, "slqj_ai_identity_action_evidence_damage_end", {
		trigger: { player: "damageEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (get?.mode?.() !== "identity") return false;
			if (!event || !player) return false;
			if (game?.zhu && player === game.zhu) return false;
			if (!event.source || event.source === player) return false;
			const cardName = String(event?.card?.name || "");
			if (cardName) return false;
			return true;
		},
		content() {
			game.__slqjAiPersona?.onDamageEndEvidenceGeneral?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_identity_action_evidence_damage_end");

	// 身份局：敌友判断因素（行为→证据）—— 兜底：非主公的回复结算（补齐缺少 ai.result 的技能/效果）
	ensureSkill(lib, "slqj_ai_identity_action_evidence_recover_end", {
		trigger: { player: "recoverEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (get?.mode?.() !== "identity") return false;
			if (!event || !player) return false;
			if (game?.zhu && player === game.zhu) return false;
			if (!event.source || event.source === player) return false;
			const cardName = String(event?.card?.name || "");
			if (cardName) return false;
			return true;
		},
		content() {
			game.__slqjAiPersona?.onRecoverEndEvidenceGeneral?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_identity_action_evidence_recover_end");

	ensureSkill(lib, "slqj_ai_soft_expose", {
		trigger: { player: "useCardToTargeted" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (get.mode() !== "identity") return false;
			if (_status.connectMode) return false;
			if (!event || !event.card || !event.target) return false;
			if (!player || player.identityShown) return false;
			if (typeof player.isOnline === "function" && player.isOnline()) return false;
			return true;
		},
		content() {
			game.__slqjAiPersona?.onUseCardToTargetedExpose?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_soft_expose");

	// 身份局：敌友判断因素（行为→证据）—— 单目标用牌
	ensureSkill(lib, "slqj_ai_identity_action_evidence_card", {
		trigger: { player: "useCardToTargeted" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (get?.mode?.() !== "identity") return false;
			return !!(event && event.card && player);
		},
		content() {
			game.__slqjAiPersona?.onUseCardToTargetedEvidence?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_identity_action_evidence_card");

	// 身份局：敌友判断因素（行为→证据）—— 拆/顺结果（按实际被拆/被顺的牌区域细化）
	ensureSkill(lib, "slqj_ai_identity_action_evidence_rewrite_discard", {
		trigger: { player: "rewriteDiscardResult" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (get?.mode?.() !== "identity") return false;
			if (!event || !player) return false;
			if (!event.target || !Array.isArray(event.cards)) return false;
			const parent = typeof event.getParent === "function" ? event.getParent() : null;
			return String(parent?.name || "") === "guohe";
		},
		content() {
			game.__slqjAiPersona?.onRewriteDiscardResultEvidence?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_identity_action_evidence_rewrite_discard");

	ensureSkill(lib, "slqj_ai_identity_action_evidence_rewrite_gain", {
		trigger: { player: "rewriteGainResult" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (get?.mode?.() !== "identity") return false;
			if (!event || !player) return false;
			if (!event.target || !Array.isArray(event.cards)) return false;
			const parent = typeof event.getParent === "function" ? event.getParent() : null;
			return String(parent?.name || "") === "shunshou";
		},
		content() {
			game.__slqjAiPersona?.onRewriteGainResultEvidence?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_identity_action_evidence_rewrite_gain");

	// 身份局：敌友判断因素（行为→证据）—— 单目标用技能（跳过 viewAs，避免与用牌重复计数）
	ensureSkill(lib, "slqj_ai_identity_action_evidence_skill", {
		trigger: { player: "useSkill" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (_status.connectMode) return false;
			if (get?.mode?.() !== "identity") return false;
			return !!(event && event.skill && player);
		},
		content() {
			game.__slqjAiPersona?.onUseSkillEvidence?.(trigger, player, game, get, _status);
		},
	});
	game.addGlobalSkill("slqj_ai_identity_action_evidence_skill");

	if (lib.config.dev) {
		const api = {
			get(player) {
				return player?.storage?.[STORAGE_KEY] || null;
			},
		};
		window.slqjAI = api;
	}
}
