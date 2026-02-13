/**
 * 开局选将偏置（身份局）：实现“反贼多选群体型辅助”等经验规则。
 *
 * 设计目标：
 * - 不改动引擎 AI 评估函数，仅通过重排候选列表影响“AI 更可能选到哪些武将”
 * - 仅在 chooseCharacter 阶段触发，不影响对局中行为
 * - 仅对 AI 生效，不影响玩家
 */

import { isLocalAIPlayer } from "../lib/utils.js";

/**
 * 安装开局选将偏置：包装 `game.createEvent`，在创建 `chooseCharacter` 事件时 patch `event.ai`。
 *
 * @param {{game:any, lib:any, get:any, _status:any}} param0
 * @returns {void}
 */
export function installChooseCharacterBias({ game, lib, get, _status }) {
	if (!game || !lib) return;
	if (!game.__slqjAiPersona || typeof game.__slqjAiPersona !== "object") return;
	if (game.__slqjAiPersona._chooseCharacterBiasInstalled) return;
	game.__slqjAiPersona._chooseCharacterBiasInstalled = true;

	const originalCreateEvent = game.createEvent;
	if (typeof originalCreateEvent !== "function") return;
	if (originalCreateEvent.__slqjAiChooseCharacterBiasWrapped) return;

	/**
	 * @param {*} ev
	 * @returns {void}
	 */
	function patchChooseCharacterEvent(ev) {
		if (!ev || typeof ev.ai !== "function") return;
		if (ev.__slqjAiChooseCharacterBiasPatched) return;
		ev.__slqjAiChooseCharacterBiasPatched = true;

		const originalAi = ev.ai;
		ev.ai = function (player, list, list2, back) {
			try {
				if (_status?.event?.name !== "chooseCharacter") return originalAi.apply(this, arguments);
				if (!player) return originalAi.apply(this, arguments);
				if (player === game.me) {
					const st = _status || globalThis._status;
					if (!isLocalAIPlayer(player, game, st)) return originalAi.apply(this, arguments);
				}

				// 身份局额外规则：反贼多选群体型辅助（在热门倾向基础上叠加）
				const identity = String(player.identity || "");
				if (identity !== "fan") return originalAi.apply(this, arguments);

				const rebelCount = countIdentityPlayers(game, "fan");
				if (rebelCount < 2) return originalAi.apply(this, arguments);

				if (Array.isArray(list) && list.length) reorderGroupSupportFirst(list, lib);
				if (Array.isArray(list2) && list2.length && !Array.isArray(back)) reorderGroupSupportFirst(list2, lib);
			} catch (e) {
				// ignore：不阻断选将流程
			}
			return originalAi.apply(this, arguments);
		};
	}

	game.createEvent = function (name) {
		const ev = originalCreateEvent.apply(this, arguments);
		if (name === "chooseCharacter") {
			try {
				patchChooseCharacterEvent(ev);
			} catch (e) {
				// ignore
			}
		}
		return ev;
	};
	game.createEvent.__slqjAiChooseCharacterBiasWrapped = true;
}

/**
 * 统计某身份的存活/在场玩家数量（开局阶段通常都在场）。
 *
 * @param {*} game
 * @param {string} id
 * @returns {number}
 */
function countIdentityPlayers(game, id) {
	const want = String(id || "");
	const list = Array.isArray(game?.players) ? game.players : [];
	let n = 0;
	for (const p of list) {
		if (!p) continue;
		if (String(p.identity || "") === want) n++;
	}
	return n;
}

/**
 * 将“群体型辅助”倾向的武将排到候选列表前面（原地重排）。
 *
 * @param {string[]} list
 * @param {*} lib
 * @returns {void}
 */
function reorderGroupSupportFirst(list, lib) {
	if (!Array.isArray(list) || !list.length) return;
	const scored = list.map((k, i) => ({ k: String(k || ""), i, s: scoreGroupSupportCharacter(String(k || ""), lib) }));
	scored.sort((a, b) => {
		if (b.s !== a.s) return b.s - a.s;
		return a.i - b.i;
	});
	for (let i = 0; i < scored.length; i++) list[i] = scored[i].k;
}

/**
 * 群体型辅助识别：技能标签权重表。
 *
 * 说明：
 * - 无名杀的“技能标签”来自 `player.hasSkillTag(tag, ...)` 机制，对应 `skill.ai[tag]` 字段。
 * - 这里不解析翻译文本（避免语言/模板差异），仅用标签做启发式排序。
 *
 * @type {Record<string, number>}
 */
const GROUP_SUPPORT_SKILL_TAG_WEIGHTS = {
	// 可救助：往往意味着能在濒死阶段“救人/自救”，偏辅助
	save: 3.2,
	respondTao: 2.6,

	// 改判/减伤：偏团队辅助与保命
	rejudge: 1.4,
	filterDamage: 1.2,

	// 防御/保护向（弱权重）：更多用于“稳住队友回合外”
	respondShan: 0.9,
	freeShan: 0.8,
	respondSha: 0.4,
	freeSha: 0.3,
};

/**
 * 估算“群体型辅助”程度的分数（越高越偏群辅）。
 *
 * 说明：此处采用“技能标签（skill.ai[tag]）”启发式（不追求绝对准确）。
 *
 * @param {string} characterKey
 * @param {*} lib
 * @returns {number}
 */
function scoreGroupSupportCharacter(characterKey, lib) {
	const ch = lib?.character?.[characterKey];
	if (!ch || !Array.isArray(ch) || !Array.isArray(ch[3])) return 0;
	const skills = ch[3].map(s => String(s || "")).filter(Boolean);
	if (!skills.length) return 0;

	let score = 0;
	for (const sk of skills) {
		score += scoreGroupSupportSkillTags(sk, lib);
	}
	return score;
}

/**
 * 基于技能标签计算“群体型辅助”启发式分数。
 *
 * @param {string} skillId
 * @param {*} lib
 * @returns {number}
 */
function scoreGroupSupportSkillTags(skillId, lib) {
	const sk = lib?.skill?.[skillId];
	if (!sk || typeof sk !== "object") return 0;
	const ai = sk.ai;
	if (!ai || typeof ai !== "object") return 0;

	let s = 0;
	for (const [tag, w] of Object.entries(GROUP_SUPPORT_SKILL_TAG_WEIGHTS)) {
		if (!Object.prototype.hasOwnProperty.call(ai, tag)) continue;
		const v = ai[tag];

		// 兼容：
		// - true/数字：视为“具备该标签”
		// - 字符串：引擎语义通常为“ai[tag]===arg 才命中”，此处按更保守的“可能具备”折算
		if (v === true) {
			s += w;
			continue;
		}
		if (typeof v === "number" && !Number.isNaN(v) && v !== 0) {
			s += w * 0.9;
			continue;
		}
		if (typeof v === "string" && v) {
			s += w * 0.55;
		}
	}
	return s;
}
