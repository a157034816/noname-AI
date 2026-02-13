import { isLocalAIPlayer, ensureStorage } from "../lib/utils.js";
import { createPersona } from "../persona.js";
import { initMentalModel } from "../memory.js";
import { ensureStats } from "../stats.js";

/**
 * 从 game 上读取“人格开关”配置快照（可能为空）。
 *
 * @param {*} game
 * @returns {Partial<Record<import("../lib/jsdoc_types.js").PersonaId, boolean>>|null}
 */
function getPersonaEnabledCfg(game) {
	const enabled = game?.__slqjAiPersona?.cfg?.personaEnabled;
	if (!enabled || typeof enabled !== "object") return null;
	return enabled;
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
 * 初始化全场玩家的 stats（用于 UI 展示/策略）。
 *
 * @param {*} game
 * @returns {void}
 */
export function initAllPlayersStats(game) {
	for (const p of game.players || []) {
		if (!p) continue;
		ensureStats(p);
	}
}

/**
 * 初始化全部“本地 AI 玩家”的 persona/memory（并触发 persona_init hook）。
 *
 * 说明：
 * - 默认只初始化“非自机”的本地 AI 玩家
 * - 自机玩家（game.me）也会在开局初始化这些属性（用于面板展示与托管接管）
 *
 * @param {*} game
 * @param {*} _status
 * @returns {void}
 */
export function initAllAiPlayers(game, _status) {
	if (!game || !Array.isArray(game.players)) return;
	const personaEnabled = getPersonaEnabledCfg(game);
	for (const p of game.players) {
		if (!p) continue;
		// 自机始终初始化；其余玩家仍按“本地 AI”口径筛选
		if (p !== game.me && !isLocalAIPlayer(p, game, _status)) continue;
		const st = ensureStorage(p);
		const beforePersona = st.persona;
		st.persona ??= createPersona(personaEnabled ? { enabled: personaEnabled } : undefined);
		initMentalModel(p, game, _status);
		// hook: 允许外部在开局阶段修正人格/traits（不持久化，仅本局生效）
		if (!beforePersona && st.persona) {
			const hooks = game?.__slqjAiPersona?.hooks || pickExternalHooks(game);
			if (hooks && typeof hooks.emit === "function") {
				const payload = { player: p, persona: st.persona, storage: st, game };
				hooks.emit("slqj_ai_persona_init", payload);
			}
		}
	}
}
