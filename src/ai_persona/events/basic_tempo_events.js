import { isAiPersonaTrackedPlayer, ensureStorage, getPid, clamp } from "../lib/utils.js";

/**
 * 判断一次 useCard 事件是否发生在“出牌阶段（phaseUse）”。
 *
 * @param {*} evt
 * @param {*} player
 * @returns {boolean}
 */
function isPhaseUseEvent(evt, player) {
	if (!evt) return false;
	if (typeof evt.isPhaseUsing === "function") {
		try {
			return !!evt.isPhaseUsing(player);
		} catch (e) {
			// ignore
		}
	}
	let e = evt;
	for (let i = 0; i < 8 && e; i++) {
		const name = String(e.name || "");
		if (name === "phaseUse") return true;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return false;
}

/**
 * 从 useCard 历史里统计“本回合出牌阶段”的出牌序列（缺失时回退空数组）。
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
 * 更新“对手【杀】密度倾向”推断：
 * - 基于公开信息：useCardAfter + 出牌阶段进度
 * - 口径：越早在出牌阶段打出【杀】，越可能“杀多”；连续出杀信号更强
 *
 * 写入位置：观察者的 `player.storage.slqj_ai.memory.basicTempo[targetPid].sha`
 *
 * @param {*} trigger useCard 事件（useCardAfter）
 * @param {*} actor 出牌者
 * @param {*} game
 * @param {*} get
 * @param {*} _status
 * @returns {void}
 */
export function onUseCardAfterBasicTempo(trigger, actor, game, get, _status) {
	if (_status?.connectMode) return;
	if (!trigger || !actor || !game) return;
	const cardName = String(trigger?.card?.name || "");
	if (cardName !== "sha") return;
	if (!isPhaseUseEvent(trigger, actor)) return;

	const phaseHist = safeGetPhaseUseCardHistory(actor);
	if (!phaseHist.length) return;

	const progressBefore = Math.max(0, phaseHist.length - 1);
	let shaCount = 0;
	for (const evt of phaseHist) {
		const n = String(evt?.card?.name || evt?.cards?.[0]?.name || "");
		if (n === "sha") shaCount++;
	}
	const firstShaThisPhase = shaCount <= 1;
	const prev = phaseHist.length >= 2 ? phaseHist[phaseHist.length - 2] : null;
	const prevName = String(prev?.card?.name || prev?.cards?.[0]?.name || "");
	const consecutiveSha = prevName === "sha";

	let delta = 0;
	if (progressBefore <= 1) delta += 0.45;
	else if (progressBefore <= 3) delta += 0.2;
	else if (progressBefore >= 6 && firstShaThisPhase) delta -= 0.15;

	// 连续出杀：更强信号（更可能“杀多”）
	if (consecutiveSha) delta += 0.12;
	else if (shaCount >= 2) delta += 0.08;
	if (shaCount >= 3) delta += 0.08;

	if (!delta) return;

	const round = typeof game?.roundNumber === "number" && !Number.isNaN(game.roundNumber) ? game.roundNumber : 0;
	const targetPid = getPid(actor);

	for (const observer of game.players || []) {
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer || observer === actor) continue;
		const st = ensureStorage(observer);
		if (!st?.persona) continue;

		st.memory ??= /** @type {any} */ ({});
		st.memory.basicTempo ??= {};

		const rec = st.memory.basicTempo[targetPid] && typeof st.memory.basicTempo[targetPid] === "object" ? st.memory.basicTempo[targetPid] : null;
		const base = rec && typeof rec.sha === "number" && !Number.isNaN(rec.sha) ? rec.sha : 0;
		const next = clamp(base * 0.85 + delta, -2, 2);
		const samples = rec && typeof rec.shaSamples === "number" && !Number.isNaN(rec.shaSamples) ? rec.shaSamples : 0;

		st.memory.basicTempo[targetPid] = {
			sha: next,
			shaSamples: samples + 1,
			lastRound: round,
		};
	}
}
