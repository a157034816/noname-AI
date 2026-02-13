import { DEFAULT_TRAITS, PERSONA_IDS } from "./lib/constants.js";

/**
 * 默认人格抽取权重（用于开局随机）。
 * @type {Record<import("./lib/jsdoc_types.js").PersonaId, number>}
 */
const DEFAULT_PERSONA_WEIGHTS = {
	balanced: 45,
	impulsive: 20,
	petty: 20,
	camouflage: 15,
};

/**
 * 从带权重的候选列表中按概率抽取一个 id。
 *
 * @param {{id: import("./lib/jsdoc_types.js").PersonaId, w:number}[]} list
 * @returns {import("./lib/jsdoc_types.js").PersonaId}
 */
function pickWeighted(list) {
	const total = list.reduce((s, x) => s + x.w, 0);
	let r = Math.random() * total;
	for (const x of list) {
		r -= x.w;
		if (r <= 0) return x.id;
	}
	return list[list.length - 1].id;
}

/**
 * 生成一个人格配置（类型 id + traits）。
 *
 * 说明：
 * - traits 基于 DEFAULT_TRAITS，按人格类型覆写部分字段
 * - 可通过 opts.enabled 按配置过滤可用人格
 * - 返回值保证 id 在 PERSONA_IDS 内（否则回退 balanced）
 *
 * @param {{
 *  enabled?: Partial<Record<import("./lib/jsdoc_types.js").PersonaId, boolean>>
 * }=} opts
 * @returns {import("./lib/jsdoc_types.js").Persona}
 */
export function createPersona(opts) {
	const enabled = opts && typeof opts === "object" ? opts.enabled : null;
	/** @type {{id: import("./lib/jsdoc_types.js").PersonaId, w:number}[]} */
	const candidates = [];
	for (const id of PERSONA_IDS) {
		if (enabled && enabled[id] === false) continue;
		const w = DEFAULT_PERSONA_WEIGHTS[id] || 0;
		if (!(w > 0)) continue;
		candidates.push({ id, w });
	}
	// 兜底：若用户关闭了全部人格开关，仍保证能生成一个人格
	if (!candidates.length) candidates.push({ id: "balanced", w: 1 });

	const id = pickWeighted(candidates);
	const traits = { ...DEFAULT_TRAITS };
	if (id === "impulsive") {
		traits.aggressiveness = 0.8;
		// 冲动型：允许在“评分噪声开关”开启时引入少量扰动
		traits.randomness = 0.12;
		traits.insight = 0.35;
	}
	if (id === "petty") {
		traits.aggressiveness = 0.6;
		traits.revengeWeight = 2.2;
		traits.insight = 0.5;
	}
	if (id === "camouflage") {
		traits.aggressiveness = 0.55;
		traits.insight = 0.6;
		traits.camouflageRounds = 3;
	}
	if (!PERSONA_IDS.includes(id)) {
		return { id: "balanced", traits };
	}
	return { id, traits };
}
