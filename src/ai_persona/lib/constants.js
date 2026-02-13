/**
 * 本扩展写入 player.storage 的根键名。
 * @type {string}
 */
export const STORAGE_KEY = "slqj_ai";

/**
 * 人格类型枚举。
 * @type {import("./jsdoc_types.js").PersonaId[]}
 */
export const PERSONA_IDS = ["balanced", "impulsive", "petty", "camouflage"];

/**
 * 默认特质参数（不同人格会在此基础上覆写）。
 * @type {import("./jsdoc_types.js").PersonaTraits}
 */
export const DEFAULT_TRAITS = {
	aggressiveness: 0.5,
	// NOTE: 选择器评分噪声默认关闭；如开启也仅 impulsive 使用（见 selector_patch.js）
	randomness: 0,
	revengeWeight: 1.0,
	insight: 0.5,
	// 非伪装人格默认不伪装；伪装人格会在 persona.js 中单独覆写该值
	camouflageRounds: 0,
};
