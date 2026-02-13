import { guessIdentityFor, explainGuessIdentityFor } from "../guess_identity.js";
import { getCampOutputCorePlayer, getPlayerCamp } from "../stats.js";

/**
 * 判断当前是否满足“忠臣已全部阵亡”（基于真实身份）。
 *
 * 说明：
 * - 该判断仅用于身份局中后期的门禁放宽：当主忠侧已无忠臣存活时，误伤忠臣的风险显著下降
 * - 这里读取引擎真实身份字段，但仅用于布尔判定，不对外暴露任何玩家身份信息
 *
 * @param {*} game
 * @returns {boolean}
 */
function isAllZhongDead(game) {
	const players = (game && game.players) || [];
	for (const p of players) {
		if (!p) continue;
		if (p.isDead && p.isDead()) continue;
		const id = String(p.identity || "");
		if (id === "zhong" || id === "mingzhong") return false;
	}
	return true;
}

/**
 * 按“猜测身份”判定某目标是否为敌方（仅用于身份局的保守目标门禁）。
 *
 * @param {*} selfIdentity
 * @param {*} guessIdentity
 * @returns {boolean}
 */
export function isGuessedEnemyIdentity(selfIdentity, guessIdentity) {
	const selfId = String(selfIdentity || "");
	const gid = String(guessIdentity || "");

	if (["zhu", "zhong", "mingzhong"].includes(selfId)) return gid === "fan";
	if (selfId === "fan") return ["zhu", "zhong", "mingzhong"].includes(gid);
	// 内奸不做阵营硬判定：更保守，避免在身份未明置时贸然下延时
	if (selfId === "nei") return false;
	return false;
}

/**
 * 身份未明置时，判断目标是否可视为“已暴露敌方”（高软暴露 + 猜测为敌方 + 置信度足够）。
 *
 * @param {*} player
 * @param {*} target
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
export function isExposedEnemyTarget(player, target, game, get) {
	if (!player || !target) return false;
	if (target === player) return true;

	// 已明置：允许使用引擎态度（此时信息已公开）
	if (target.identityShown) return typeof get?.attitude === "function" ? get.attitude(player, target) < 0 : true;

	// 未明置：仅在“高软暴露 + 猜测为敌方（且置信度足够）”时允许
	const selfId = String(player.identity || "");
	if (selfId === "nei") return false;

	// 残局策略：当忠臣已全部阵亡时，主忠侧以“态度负面”为主要敌对判据，避免因猜测 unknown 导致弃权。
	if (get?.mode?.() === "identity" && ["zhu", "zhong", "mingzhong"].includes(selfId) && isAllZhongDead(game)) {
		if (typeof get?.attitude === "function") {
			try {
				return get.attitude(player, target) < -0.6;
			} catch (e) {
				return false;
			}
		}
	}

	const shown = target.ai && typeof target.ai.shown === "number" ? target.ai.shown : 0;
	if (shown < 0.85) return false;
	const g = guessIdentityFor(player, target, game);
	const gid = String(g?.identity || "unknown");
	const conf = typeof g?.confidence === "number" ? g.confidence : 0;
	if (conf < 0.55) return false;
	return isGuessedEnemyIdentity(player.identity, gid);
}

/**
 * 身份未明置时，判断目标是否可视为“已暴露友方”（软暴露/高软暴露 + 猜测忠方 + 置信度足够）。
 *
 * @param {*} player
 * @param {*} target
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
export function isExposedFriendlyTarget(player, target, game, get) {
	if (!player || !target) return false;
	if (target.identityShown) return typeof get?.attitude === "function" ? get.attitude(player, target) > 0 : false;
	const shown = target.ai && typeof target.ai.shown === "number" ? target.ai.shown : 0;
	const g = explainGuessIdentityFor(player, target, game);
	const gid = String(g?.identity || "unknown");
	const conf = typeof g?.confidence === "number" ? g.confidence : 0;
	const why = String(g?.reason || "");
	const softAssigned = why === "soft_assigned_remaining_allies";

	// 软赋予身份：允许在未达到“软暴露阈值”时也视为友军（仍保留 attitude 兜底，避免反贼侧误救）。
	if (!softAssigned && shown < 0.7) return false;
	if (conf < 0.55) return false;
	if (!["zhu", "zhong", "mingzhong"].includes(gid)) return false;
	return typeof get?.attitude === "function" ? get.attitude(player, target) > 0 : true;
}

/**
 * 桃优先保留策略：不救“未暴露友方”（避免在身份不明时浪费关键资源）。
 *
 * @param {*} player
 * @param {*} target
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
export function shouldReserveTao(player, target, game, get) {
	// 仅身份局；且不影响自救/救主公
	if (get?.mode?.() !== "identity") return false;
	if (!player || !target) return false;
	if (target === player) return false;
	if (game?.zhu && target === game.zhu) return false;
	return !isExposedFriendlyTarget(player, target, game, get);
}

/**
 * 群体进攻锦囊门禁（身份局）：排除死亡后再排除内奸，友军人数 < 敌军人数时才允许使用。
 *
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
export function shouldUseOffensiveGroupTrick(player, game, get) {
	if (!player || !game) return false;
	if (get?.mode?.() !== "identity") return false;
	const selfId = String(player.identity || "");
	if (selfId === "nei") return false;

	const isZhuSide = id => ["zhu", "zhong", "mingzhong"].includes(String(id || ""));

	let ally = 0;
	let enemy = 0;

	for (const p of game.players || []) {
		if (!p) continue;
		if (p.isDead && p.isDead()) continue;
		const pid = String(p.identity || "");
		// 口径：排除内奸（nei）后再进行人数对比
		if (pid === "nei") continue;

		if (pid === "fan") {
			if (selfId === "fan") ally++;
			else enemy++;
			continue;
		}

		if (isZhuSide(pid)) {
			if (isZhuSide(selfId)) ally++;
			else enemy++;
			continue;
		}
	}

	// 仅在“友军人数 < 敌军人数”时使用
	return ally < enemy;
}

/**
 * 群体有益锦囊门禁（身份局）：避免弱势时把资源也送给敌方。
 *
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @param {*} card
 * @returns {boolean}
 */
export function shouldUseBeneficialGroupTrick(player, game, get, card) {
	if (!player || !game) return false;
	if (get?.mode?.() !== "identity") return false;
	const selfId = String(player.identity || "");
	if (selfId === "nei") return false;

	const isZhuSide = id => ["zhu", "zhong", "mingzhong"].includes(String(id || ""));
	const camp = getPlayerCamp(selfId);

	let ally = 0;
	let enemy = 0;
	let allyMissing = 0;
	let enemyMissing = 0;

	for (const p of game.players || []) {
		if (!p) continue;
		if (p.isDead && p.isDead()) continue;
		const pid = String(p.identity || "");
		if (pid === "nei") continue;

		const missing = Math.max(0, (p.maxHp || 0) - (p.hp || 0));
		if (pid === "fan") {
			if (selfId === "fan") {
				ally++;
				allyMissing += missing;
			} else {
				enemy++;
				enemyMissing += missing;
			}
			continue;
		}
		if (isZhuSide(pid)) {
			if (isZhuSide(selfId)) {
				ally++;
				allyMissing += missing;
			} else {
				enemy++;
				enemyMissing += missing;
			}
			continue;
		}
	}

	const name = String(card?.name || "");
	const zhu = game?.zhu;
	const zhuCritical =
		isZhuSide(selfId) &&
		zhu &&
		!(typeof zhu.isDead === "function" && zhu.isDead()) &&
		((zhu.hp || 0) <= 1 || (typeof zhu.isDying === "function" && zhu.isDying()));

	let campCoreCritical = false;
	if (camp === "zhu" || camp === "fan") {
		const core = getCampOutputCorePlayer(game, camp);
		if (core) {
			const missing = Math.max(0, (core.maxHp || 0) - (core.hp || 0));
			const dying = (core.hp || 0) <= 0 || (typeof core.isDying === "function" && core.isDying());
			campCoreCritical = missing > 0 && ((core.hp || 0) <= 1 || dying);
		}
	}
	const coreCritical = camp === "zhu" ? zhuCritical || campCoreCritical : camp === "fan" ? campCoreCritical : false;

	// 桃园：按缺失体力判断（只在“我方更需要群体治疗”时开）
	if (name === "taoyuan") {
		// 需要有明确治疗收益
		if (allyMissing <= 0) return false;
		// 主公濒危：优先保命（即便敌方也能回血）
		if (coreCritical) return true;
		return allyMissing > enemyMissing;
	}

	// 其他群体有益锦囊（如五谷）：默认更保守，只在“友军人数 > 敌军人数”时开
	if (ally > enemy) return true;

	// 弱势时也可开，但需要满足额外门槛：
	// - 主公濒危：允许用群体资源牌抢救局势
	// - 或友军总缺失体力显著高于敌军（避免给敌方回血/补资源）
	if (coreCritical) return true;

	const diff = allyMissing - enemyMissing;
	if (diff >= 3) return true;
	if (allyMissing >= 3 && enemyMissing > 0 && allyMissing / enemyMissing >= 1.8) return true;
	return false;
}
