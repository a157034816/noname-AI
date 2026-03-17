import { isLocalAIPlayer, isAiPersonaTrackedPlayer } from "./lib/utils.js";
import { createHookBus } from "./lib/hook_bus.js";
import { incTurnsTaken, decayMentalModel } from "./memory.js";
import { installAttitudePatch } from "./attitude_patch.js";
import { installSelectorPatch } from "./selector_patch.js";
import { buildInspectText, getInspectNoDataText } from "./ui/inspect_valuebox_i18n.js";
import { ensureStats, addDrawStat, addDamageDealtStat, getCampOutputCorePlayer, getPlayerCamp } from "./stats.js";
import { initAllAiPlayers, initAllPlayersStats } from "./runtime/player_init.js";
import {
  onDamageEnd,
  onDamageEndEvidenceGeneral,
  onRecoverEnd,
  onRecoverEndEvidenceGeneral,
  onUseCardToTargetedExpose,
  onUseCardToTargetedEvidence,
  onRewriteDiscardResultEvidence,
  onRewriteGainResultEvidence,
  onUseSkillEvidence,
} from "./events/identity_events.js";
import { onRecentAttackMark, onRecentAttackClear } from "./events/recent_attack_events.js";
import {
  onDamageEndRage,
  onRecoverEndRage,
  onRewriteDiscardResultRage,
  onRewriteGainResultRage,
} from "./events/rage_events.js";
import { installLoyalistProtectLordGuard } from "./loyalist_protect_lord_guard.js";
import {
  onPhaseBeginStartTurnMemoryReset,
  onDamageEndTurnMemory,
  onLoseHpEndTurnMemory,
  onRecoverEndTurnMemory,
  onDrawAfterTurnMemory,
  onDiscardAfterTurnMemory,
  onLoseToDiscardpileAfterTurnMemory,
} from "./events/turn_memory_events.js";
import {
  installDefaultScoreHooks,
  shouldForbidRescueRecentAttackInChooseBool,
  shouldForceZhuRound1AoeProbeInChooseBool,
} from "./strategies/default_score_hooks.js";
import { installChooseCharacterBias } from "./strategies/choose_character_bias.js";
import { installPersonaSkills } from "./skills/persona_skills.js";

/**
 * @typedef {import("./lib/jsdoc_types.js").Persona} Persona
 * @typedef {import("./lib/jsdoc_types.js").SlqjAiStorage} SlqjAiStorage
 * @typedef {import("./lib/jsdoc_types.js").SlqjAiHookBus} SlqjAiHookBus
 * @typedef {import("./lib/jsdoc_types.js").IdentityId} IdentityId
 */

let installed = false;

/**
 * 取得/创建扩展在 game 上的根对象（`__slqjAiPersona`）。
 *
 * @param {*} game
 * @returns {Record<string, any>}
 */
function ensurePersonaRoot(game) {
  if (!game) return /** @type {any} */ ({});
  const root = game.__slqjAiPersona && typeof game.__slqjAiPersona === "object" ? game.__slqjAiPersona : {};
  game.__slqjAiPersona = root;
  return root;
}

/**
 * 从 game 上取得对外 Hook Bus。
 *
 * @param {*} game
 * @returns {*|null}
 */
function pickExternalHooks(game) {
  const h1 = game?.slqjAiHooks;
  if (h1 && typeof h1.emit === "function") return h1;
  return null;
}

/**
 * 读取本局“身份牌堆构成”（公开信息）并统计每种身份数量。
 *
 * 说明：
 * - 该数据来自 `lib.config.mode_config.identity.identity`，用于推断本局“应有多少反贼/忠臣/内奸”等
 * - 与逐个读取 `player.identity`（全知/作弊）不同，这里只使用房间配置/规则层的公开构成
 * - 若无法读取，则返回 null，由调用方决定回退策略
 *
 * @param {*} lib
 * @param {*} game
 * @param {*} get
 * @returns {Record<string, number>|null}
 */
function getIdentityPileCounts(lib, game, get) {
  try {
    if (!lib || !game || !get) return null;
    if (typeof get.mode === "function" && get.mode() !== "identity") return null;

    const table = lib?.config?.mode_config?.identity?.identity;
    if (!Array.isArray(table)) return null;

    // 关键：身份局的身份牌堆构成取决于“开局总人数”，而不是当前存活人数。
    // 无名杀中死亡玩家通常会从 `game.players` 移到 `game.dead`，因此这里需要合并统计。
    const alive = (game.players && game.players.length) || 0;
    const dead = (game.dead && game.dead.length) || 0;
    const n = alive + dead;
    const idx = n - 2;
    const list = table[idx];
    if (!Array.isArray(list) || !list.length) return null;

    /** @type {Record<string, number>} */
    const out = Object.create(null);
    for (const x of list) {
      const key = String(x || "");
      if (!key) continue;
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  } catch (e) {
    return null;
  }
}

/**
 * 安装“人格系统”：
 * - 为本地 AI 生成 persona/memory/runtime
 * - 安装 attitude/selector 补丁与若干默认策略 hook
 * - 将关键 API 挂载到 game.__slqjAiPersona / game.slqjAiHooks 供 scripts/外部调用
 *
 * @param {{lib:any, game:any, get:any, ai:any, _status:any, config:any}} param0
 * @returns {void}
 */
export function installPersonaSystem({ lib, game, get, ai, _status, config }) {
	if (installed) return;
	if (_status.connectMode) return;
	installed = true;

	const inspectLang =
		config?.slqj_ai_inspect_lang ?? lib.config.slqj_ai_inspect_lang ?? "zh";
	const inspectEnable =
		config?.slqj_ai_inspect_enable ?? lib.config.slqj_ai_inspect_enable ?? false;
	const blindHandcardRandom =
		config?.slqj_ai_blind_handcard_random ?? lib.config.slqj_ai_blind_handcard_random ?? true;
	const scoreNoiseEnable =
		config?.slqj_ai_score_noise_enable ?? lib.config.slqj_ai_score_noise_enable ?? true;
	const outputCoreDrawThresholdRaw =
		config?.slqj_ai_output_core_draw_threshold ?? lib.config.slqj_ai_output_core_draw_threshold;
	const outputCoreDamageThresholdRaw =
		config?.slqj_ai_output_core_damage_threshold ??
		lib.config.slqj_ai_output_core_damage_threshold;
	const outputCoreDrawThreshold = Number.isFinite(Number(outputCoreDrawThresholdRaw))
		? Number(outputCoreDrawThresholdRaw)
		: 8;
	const outputCoreDamageThreshold = Number.isFinite(Number(outputCoreDamageThresholdRaw))
		? Number(outputCoreDamageThresholdRaw)
		: 3;
	const personaEnabled = {
		balanced: !!(
			config?.slqj_ai_persona_enable_balanced ??
			lib.config.slqj_ai_persona_enable_balanced ??
			true
		),
		impulsive: !!(
			config?.slqj_ai_persona_enable_impulsive ??
			lib.config.slqj_ai_persona_enable_impulsive ??
			true
		),
		petty: !!(
			config?.slqj_ai_persona_enable_petty ??
			lib.config.slqj_ai_persona_enable_petty ??
			true
		),
		// 伪装人格默认关闭（可在扩展配置中手动开启）
		camouflage: !!(
			config?.slqj_ai_persona_enable_camouflage ??
			lib.config.slqj_ai_persona_enable_camouflage ??
			false
		),
	};

	// NOTE:
	// 非常多的技能content会被引擎编译/序列化后再执行，导致丢失模块闭包变量。
	// 因此不要在skill.content里直接引用模块内的局部函数；改为挂到game上供运行时访问。
	ensurePersonaRoot(game);

	// hooks: 给其他扩展/脚本提供可注册的“决策插入点”
	// - game.__slqjAiPersona.hooks：扩展内部标准入口
	// - game.slqjAiHooks：对外便捷入口（避免其他脚本需要知道 __slqjAiPersona）
	const existingExternalHooks = pickExternalHooks(game);
	game.__slqjAiPersona.hooks ??= existingExternalHooks || createHookBus();
	if (!game.slqjAiHooks) game.slqjAiHooks = game.__slqjAiPersona.hooks;

	const identityCounts = getIdentityPileCounts(lib, game, get);
	game.__slqjAiPersona.cfg = {
		inspectLang,
		inspectEnable,
		blindHandcardRandom,
		scoreNoiseEnable,
		outputCoreDrawThreshold,
		outputCoreDamageThreshold,
		personaEnabled,
		identityCounts,
	};
	game.__slqjAiPersona.isLocalAIPlayer = isLocalAIPlayer;
	game.__slqjAiPersona.isAiPersonaTrackedPlayer = isAiPersonaTrackedPlayer;
	game.__slqjAiPersona.initAllAiPlayers = initAllAiPlayers;
	game.__slqjAiPersona.incTurnsTaken = incTurnsTaken;
	game.__slqjAiPersona.decayMentalModel = decayMentalModel;
	game.__slqjAiPersona.onDamageEnd = onDamageEnd;
	game.__slqjAiPersona.onDamageEndEvidenceGeneral = onDamageEndEvidenceGeneral;
	game.__slqjAiPersona.onRecoverEnd = onRecoverEnd;
	game.__slqjAiPersona.onRecoverEndEvidenceGeneral = onRecoverEndEvidenceGeneral;
	game.__slqjAiPersona.onUseCardToTargetedExpose = onUseCardToTargetedExpose;
	game.__slqjAiPersona.onUseCardToTargetedEvidence = onUseCardToTargetedEvidence;
	game.__slqjAiPersona.onRewriteDiscardResultEvidence = onRewriteDiscardResultEvidence;
	game.__slqjAiPersona.onRewriteGainResultEvidence = onRewriteGainResultEvidence;
	game.__slqjAiPersona.onUseSkillEvidence = onUseSkillEvidence;
	game.__slqjAiPersona.onRecentAttackMark = onRecentAttackMark;
	game.__slqjAiPersona.onRecentAttackClear = onRecentAttackClear;
	game.__slqjAiPersona.shouldForbidRescueRecentAttackInChooseBool = shouldForbidRescueRecentAttackInChooseBool;
	game.__slqjAiPersona.shouldForceZhuRound1AoeProbeInChooseBool = shouldForceZhuRound1AoeProbeInChooseBool;
	game.__slqjAiPersona.onDamageEndRage = onDamageEndRage;
	game.__slqjAiPersona.onRecoverEndRage = onRecoverEndRage;
	game.__slqjAiPersona.onRewriteDiscardResultRage = onRewriteDiscardResultRage;
	game.__slqjAiPersona.onRewriteGainResultRage = onRewriteGainResultRage;
	game.__slqjAiPersona.onPhaseBeginStartTurnMemoryReset = onPhaseBeginStartTurnMemoryReset;
	game.__slqjAiPersona.onDamageEndTurnMemory = onDamageEndTurnMemory;
	game.__slqjAiPersona.onLoseHpEndTurnMemory = onLoseHpEndTurnMemory;
	game.__slqjAiPersona.onRecoverEndTurnMemory = onRecoverEndTurnMemory;
	game.__slqjAiPersona.onDrawAfterTurnMemory = onDrawAfterTurnMemory;
	game.__slqjAiPersona.onDiscardAfterTurnMemory = onDiscardAfterTurnMemory;
	game.__slqjAiPersona.onLoseToDiscardpileAfterTurnMemory = onLoseToDiscardpileAfterTurnMemory;
	game.__slqjAiPersona.buildInspectText = buildInspectText;
	game.__slqjAiPersona.getInspectNoDataText = getInspectNoDataText;
	game.__slqjAiPersona.initAllPlayersStats = initAllPlayersStats;
	game.__slqjAiPersona.ensureStats = ensureStats;
	game.__slqjAiPersona.addDrawStat = addDrawStat;
	game.__slqjAiPersona.addDamageDealtStat = addDamageDealtStat;
	game.__slqjAiPersona.getPlayerCamp = getPlayerCamp;
	game.__slqjAiPersona.getCampOutputCorePlayer = getCampOutputCorePlayer;

	// 开局选将影响（身份局）：反贼人数较多时更偏向群体型辅助等经验规则
	installChooseCharacterBias({ game, lib, get, _status });

	installDefaultScoreHooks({ game, get, _status });

	installLoyalistProtectLordGuard({ lib, game, get, _status });

	// 在 hooks 初始化完成后再安装补丁，方便补丁内部直接读取 hooks
	installAttitudePatch({ get, game, _status });
	installSelectorPatch({ ai, get, game, _status });

	installPersonaSkills({ lib, game, get, _status });
}
