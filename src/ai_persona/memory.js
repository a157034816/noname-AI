import { ensureStorage, getPid, clamp } from "./lib/utils.js";

/**
 * 怒气衰减率（每名本地 AI 在其回合开始时乘法衰减）。
 *
 * 说明：
 * - 值越接近 1 → 衰减越慢 → 更容易把怒气/定向怒气堆到更高（例如 >4）
 * - 值越小 → 衰减越快 → 更容易“冷静下来”
 *
 * 可在文件头部直接调参（满足“核心代码头部可配置常量”的需求）。
 *
 * @type {{
 *  default: { rageRate: number, rageTowardsRate: number },
 *  impulsive: { rageRate: number, rageTowardsRate: number },
 *  petty: { rageRate: number, rageTowardsRate: number },
 *  camouflage: { rageRate: number, rageTowardsRate: number }
 * }}
 */
const RAGE_DECAY_RATES = {
	// 默认：比旧版更慢衰减（更易堆到 4+）
	default: { rageRate: 0.88, rageTowardsRate: 0.92 },
	// 冲动：更难冷静（更慢衰减）
	impulsive: { rageRate: 0.9, rageTowardsRate: 0.93 },
	// 小心眼：更记仇（定向怒气更慢衰减）
	petty: { rageRate: 0.89, rageTowardsRate: 0.95 },
	// 伪装：更克制（更快冷静）
	camouflage: { rageRate: 0.86, rageTowardsRate: 0.9 },
};

/**
 * 为“酒的时机：先喝酒再找牌”生成本局固定习惯（启发式/保守）。
 *
 * 设计目标：同一局内不同 AI 可能采用不同风格，但同一 AI 的选择应保持稳定，避免来回摇摆。
 *
 * @param {import("./lib/jsdoc_types.js").Persona|null|undefined} persona
 * @returns {"heuristic"|"conservative"}
 */
function pickJiuSearchShaHabit(persona) {
	const id = String(persona?.id || "");
	const r = Math.random();
	// 冲动：更愿意“先喝酒再找牌”搏节奏
	if (id === "impulsive") return r < 0.7 ? "heuristic" : "conservative";
	// 伪装：更谨慎，避免空喝酒暴露意图
	if (id === "camouflage") return r < 0.25 ? "heuristic" : "conservative";
	// 小心眼：中性略偏启发式（更偏向抓机会打输出）
	if (id === "petty") return r < 0.55 ? "heuristic" : "conservative";
	// 均衡：对半
	return r < 0.5 ? "heuristic" : "conservative";
}

/**
 * 初始化并清理玩家的“心智模型”存储（persona/memory/runtime）。
 *
 * 说明：
 * - 仅在首次初始化时生成“第一印象”（firstImpression）
 * - 会按当前存活玩家集合清理脏数据，避免 map 无限增长
 *
 * @param {*} player
 * @param {*} game
 * @param {*} _status
 * @returns {import("./lib/jsdoc_types.js").SlqjAiStorage} 返回 ensureStorage(player) 的结果（扩展后的 storage 片段）
 */
export function initMentalModel(player, game, _status) {
	const st = ensureStorage(player);
	st.persona ??= null;
	st.memory = {
		firstImpression: {},
		evidence: {},
		grudge: {},
		rage: 0,
		rageTowards: {},
		zhuSignal: {},
		zhuHelp: {},
		zhuHarm: {},
		habits: {},
	};
	st.runtime = {
		turnsTaken: 0,
		installedAtRound: game.roundNumber || 0,
		recentAttack: null,
		turnMemory: { turnId: 0, activePid: "", events: [] },
	};

	// 仅在开局/首次初始化时生成第一印象
	if (!st.runtime._impressionInited) {
		st.runtime._impressionInited = true;
		for (const p of game.players) {
			if (p === player) continue;
			const pid = getPid(p);
			st.memory.firstImpression[pid] ??= (Math.random() - 0.5) * 0.6; // -0.3~0.3
			st.memory.evidence[pid] ??= 0;
			st.memory.grudge[pid] ??= 0;
			st.memory.rageTowards[pid] ??= 0;
			st.memory.zhuSignal[pid] ??= 0;
			st.memory.zhuHelp[pid] ??= 0;
			st.memory.zhuHarm[pid] ??= 0;
		}
	}

	// 仅在开局/首次初始化时生成本局“习惯”（避免多次 init 导致风格抖动）
	if (!st.runtime._habitsInited) {
		st.runtime._habitsInited = true;
		st.memory.habits.jiuSearchSha ??= pickJiuSearchShaHabit(st.persona);
	}

	// 清理：防止玩家变化导致脏数据无限增长
	for (const mapName of ["firstImpression", "evidence", "grudge", "rageTowards", "zhuSignal", "zhuHelp", "zhuHarm"]) {
		const map = st.memory[mapName];
		if (!map || typeof map !== "object") continue;
		for (const key of Object.keys(map)) {
			if (!game.players.some(p => getPid(p) === key)) {
				delete map[key];
			}
		}
	}

	return st;
}

/**
 * 增加“已行动回合数”（用于伪装/回合推进等策略）。
 *
 * @param {*} player
 * @returns {void}
 */
export function incTurnsTaken(player) {
	const st = ensureStorage(player);
	st.runtime ??= { turnsTaken: 0, installedAtRound: 0 };
	st.runtime.turnsTaken = (st.runtime.turnsTaken || 0) + 1;
}

/**
 * 对心智模型进行衰减（证据/仇恨/阵营线索），避免一次事件永久锁死判断。
 *
 * @param {*} player
 * @returns {void}
 */
export function decayMentalModel(player) {
	const st = ensureStorage(player);
	const persona = st.persona;
	const mem = st.memory;
	if (!persona || !mem) return;

	const traits = persona.traits || {};
	// 证据衰减：避免一次事件永久锁死阵营判断
	const evidenceRate = clamp(0.9 + (traits.insight || 0) * 0.06, 0.9, 0.98);
	// 阵营线索衰减：更像“会遗忘/会重新评估”的推理
	const zhuRate = clamp(0.9 + (traits.insight || 0) * 0.05, 0.9, 0.98);
	// 仇恨衰减：小心眼更记仇，但也会慢慢淡忘
	const grudgeRate = clamp(0.88 + (traits.revengeWeight || 1) * 0.03, 0.88, 0.97);
	// 怒气衰减：按人格类型设定（更“上头”的人格更难冷静）
	const personaId = String(persona.id || "");
	const rageCfg = RAGE_DECAY_RATES[personaId] || RAGE_DECAY_RATES.default;
	const rageRate = rageCfg.rageRate;
	const rageTowardsRate = rageCfg.rageTowardsRate;

	for (const key of Object.keys(mem.evidence || {})) {
		mem.evidence[key] *= evidenceRate;
		if (Math.abs(mem.evidence[key]) < 0.05) mem.evidence[key] = 0;
	}
	for (const key of Object.keys(mem.grudge || {})) {
		mem.grudge[key] *= grudgeRate;
		if (mem.grudge[key] < 0.05) mem.grudge[key] = 0;
	}
	if (typeof mem.rage !== "number" || Number.isNaN(mem.rage)) mem.rage = 0;
	mem.rage = clamp(mem.rage * rageRate, 0, 20);
	if (mem.rage < 0.05) mem.rage = 0;
	if (!mem.rageTowards || typeof mem.rageTowards !== "object") mem.rageTowards = {};
	for (const key of Object.keys(mem.rageTowards || {})) {
		const v = mem.rageTowards[key];
		if (typeof v !== "number" || Number.isNaN(v)) {
			mem.rageTowards[key] = 0;
			continue;
		}
		mem.rageTowards[key] = clamp(v * rageTowardsRate, 0, 20);
		if (mem.rageTowards[key] < 0.05) mem.rageTowards[key] = 0;
	}
	for (const key of Object.keys(mem.zhuSignal || {})) {
		mem.zhuSignal[key] *= zhuRate;
		if (Math.abs(mem.zhuSignal[key]) < 0.05) mem.zhuSignal[key] = 0;
	}
	for (const key of Object.keys(mem.zhuHelp || {})) {
		mem.zhuHelp[key] *= zhuRate;
		if (mem.zhuHelp[key] < 0.05) mem.zhuHelp[key] = 0;
	}
	for (const key of Object.keys(mem.zhuHarm || {})) {
		mem.zhuHarm[key] *= zhuRate;
		if (mem.zhuHarm[key] < 0.05) mem.zhuHarm[key] = 0;
	}
}

/**
 * 增加“仇恨”。
 *
 * @param {*} victim 被影响者（记录仇恨的主体）
 * @param {*} source 仇恨来源
 * @param {number} amount 增量
 * @returns {void}
 */
export function addGrudge(victim, source, amount) {
	const st = ensureStorage(victim);
	if (!st.memory) return;
	const pid = getPid(source);
	st.memory.grudge[pid] = clamp((st.memory.grudge[pid] || 0) + amount, 0, 20);
}

/**
 * 增加（或减少）全局“怒气”。
 *
 * @param {*} player 怒气主体
 * @param {number} amount 增量（可为负）
 * @returns {void}
 */
export function addRage(player, amount) {
	if (typeof amount !== "number" || Number.isNaN(amount) || !amount) return;
	const st = ensureStorage(player);
	const mem = st.memory;
	if (!mem) return;
	if (typeof mem.rage !== "number" || Number.isNaN(mem.rage)) mem.rage = 0;
	mem.rage = clamp(mem.rage + amount, 0, 20);
}

/**
 * 增加（或减少）对某玩家的“定向怒气”。
 *
 * @param {*} player 怒气主体
 * @param {*} target 定向目标
 * @param {number} amount 增量（可为负）
 * @returns {void}
 */
export function addRageTowards(player, target, amount) {
	if (typeof amount !== "number" || Number.isNaN(amount) || !amount) return;
	const st = ensureStorage(player);
	const mem = st.memory;
	if (!mem) return;
	if (!mem.rageTowards || typeof mem.rageTowards !== "object") mem.rageTowards = {};
	const pid = getPid(target);
	mem.rageTowards[pid] = clamp((mem.rageTowards[pid] || 0) + amount, 0, 20);
}

/**
 * 增加“证据”（对阵营/身份的推断线索）。
 *
 * @param {*} observer 观察者（记录证据的主体）
 * @param {*} actor 行为者（被记录的一方）
 * @param {number} amount 增量（可为负）
 * @returns {void}
 */
export function addEvidence(observer, actor, amount) {
	const st = ensureStorage(observer);
	if (!st.memory) return;
	const pid = getPid(actor);
	st.memory.evidence[pid] = clamp((st.memory.evidence[pid] || 0) + amount, -10, 10);
}

/**
 * 增加“主公阵营倾向”线索：+ 表示更偏向帮助主公，- 表示更偏向伤害主公。
 *
 * 同时会分别累计：
 * - zhuHelp（正向）
 * - zhuHarm（反向的绝对值）
 *
 * @param {*} observer 观察者（记录线索的主体）
 * @param {*} actor 行为者（被记录的一方）
 * @param {number} amount 增量（可为负）
 * @returns {void}
 */
export function addZhuSignal(observer, actor, amount) {
	const st = ensureStorage(observer);
	const mem = st.memory;
	if (!mem) return;
	mem.zhuSignal ??= {};
	mem.zhuHelp ??= {};
	mem.zhuHarm ??= {};
	const pid = getPid(actor);
	const v = clamp((mem.zhuSignal[pid] || 0) + amount, -20, 20);
	mem.zhuSignal[pid] = v;
	if (amount > 0) {
		mem.zhuHelp[pid] = clamp((mem.zhuHelp[pid] || 0) + amount, 0, 20);
	} else if (amount < 0) {
		mem.zhuHarm[pid] = clamp((mem.zhuHarm[pid] || 0) + -amount, 0, 20);
	}
}
