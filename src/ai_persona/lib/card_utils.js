/**
 * 从事件链中向上查找 card/cads（用于 score hook 获取当前决策牌）。
 *
 * @param {*} event
 * @returns {*|null}
 */
export function findEventCard(event) {
	let e = event;
	for (let i = 0; i < 8 && e; i++) {
		if (e.card) return e.card;
		if (e.cards && e.cards.length) return e.cards[0];
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return null;
}

/**
 * @param {*} card
 * @returns {boolean}
 */
export function isTaoCard(card) {
	return !!(card && card.name === "tao");
}

/**
 * @param {*} card
 * @returns {boolean}
 */
export function isWuxieCard(card) {
	return !!(card && card.name === "wuxie");
}

/**
 * 尝试获取卡牌类型（兼容 card.type 与 get.info(card).type）。
 *
 * @param {*} card
 * @param {*} get
 * @returns {string}
 */
export function getCardType(card, get) {
	if (!card) return "";
	if (typeof card.type === "string") return card.type;
	if (typeof get?.info === "function") {
		try {
			const info = get.info(card);
			if (info && typeof info.type === "string") return info.type;
		} catch (e) {
			// ignore
		}
	}
	return "";
}

/**
 * @param {*} card
 * @param {*} get
 * @returns {boolean}
 */
export function isDelayTrickCard(card, get) {
	return getCardType(card, get) === "delay";
}

/**
 * @param {*} card
 * @param {*} get
 * @returns {boolean}
 */
export function isNormalTrickCard(card, get) {
	return getCardType(card, get) === "trick";
}

/**
 * 从 get.result(card, skill) 中取出对 target 的数值结果（尽量兼容 target_use/target 函数形式）。
 *
 * @param {*} card
 * @param {string|undefined|null} skill
 * @param {*} source
 * @param {*} target
 * @param {*} get
 * @returns {number}
 */
export function getResultNumberForTarget(card, skill, source, target, get) {
	if (!card || !source || !target) return 0;
	let s = skill;
	if (typeof s !== "string") s = undefined;
	const res = get.result(card, s);
	let tv = res?.target_use ?? res?.target;
	if (typeof tv === "function") {
		try {
			tv = tv(source, target, card);
		} catch (e) {
			tv = 0;
		}
	}
	if (typeof tv !== "number" || Number.isNaN(tv)) return 0;
	return tv;
}

/**
 * 通用识别“群体进攻锦囊”：selectTarget:-1 且整体收益对目标为负。
 *
 * @param {*} card
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
export function isOffensiveGroupTrickCard(card, player, game, get) {
	if (!card || !player || !game) return false;
	if (!isNormalTrickCard(card, get)) return false;

	// 通用识别：通常为 selectTarget:-1（全体/任意多目标）且整体收益对目标为负
	let info = null;
	if (typeof get?.info === "function") {
		try {
			info = get.info(card);
		} catch (e) {
			info = null;
		}
	}
	const st = info ? info.selectTarget : undefined;
	const isGroupLike = st === -1 || (Array.isArray(st) && st.includes(-1));
	if (!isGroupLike) return false;

	// 排除自用类 selectTarget:-1：必须存在至少一个“其他角色”可用作目标
	let sample = null;
	for (const p of game.players || []) {
		if (!p || p === player) continue;
		if (p.isDead && p.isDead()) continue;
		if (typeof player.canUse === "function") {
			try {
				if (!player.canUse(card, p)) continue;
			} catch (e) {
				// ignore
			}
		}
		sample = p;
		break;
	}
	if (!sample) return false;

	const tv = getResultNumberForTarget(card, undefined, player, sample, get);
	return tv < 0;
}

/**
 * 通用识别“群体有益锦囊”：selectTarget:-1 且整体收益对目标为正。
 *
 * @param {*} card
 * @param {*} player
 * @param {*} game
 * @param {*} get
 * @returns {boolean}
 */
export function isBeneficialGroupTrickCard(card, player, game, get) {
	if (!card || !player || !game) return false;
	if (!isNormalTrickCard(card, get)) return false;

	let info = null;
	if (typeof get?.info === "function") {
		try {
			info = get.info(card);
		} catch (e) {
			info = null;
		}
	}
	const st = info ? info.selectTarget : undefined;
	const isGroupLike = st === -1 || (Array.isArray(st) && st.includes(-1));
	if (!isGroupLike) return false;

	let sample = null;
	for (const p of game.players || []) {
		if (!p || p === player) continue;
		if (p.isDead && p.isDead()) continue;
		if (typeof player.canUse === "function") {
			try {
				if (!player.canUse(card, p)) continue;
			} catch (e) {
				// ignore
			}
		}
		sample = p;
		break;
	}
	if (!sample) return false;

	const tv = getResultNumberForTarget(card, undefined, player, sample, get);
	return tv > 0;
}
