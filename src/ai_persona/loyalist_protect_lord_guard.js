/**
 * 忠臣护主门禁（本地 AI 专用）：
 * - 禁止忠臣对主公使用负面控场牌（如【乐不思蜀】、【兵粮寸断】）
 * - 禁止忠臣对主公使用“单目标伤害牌”（如【杀】/【决斗】等）
 *
 * 说明：
 * - 仅在身份局（identity）生效
 * - 仅对“本地 AI 玩家”生效（避免影响人类手操）
 */

const SKILL_ID = "slqj_ai_loyalist_protect_lord_guard";

/** @type {Set<string>} */
const CONTROL_CARD_NAMES = new Set(["lebu", "bingliang", "fulei"]);

/**
 * 安全取得卡名（兼容字符串/实体牌/虚拟牌）。
 *
 * @param {*} card
 * @returns {string}
 */
function getCardName(card) {
	if (!card) return "";
	if (typeof card === "string") return card;
	if (typeof card?.name === "string") return card.name;
	if (typeof card?.viewAs === "string") return card.viewAs;
	if (typeof card?.viewAs?.name === "string") return card.viewAs.name;
	return "";
}

/**
 * 判断一张牌“基础上是否为单目标”（不考虑技能额外目标等 mod）。
 *
 * @param {*} card
 * @param {*} player
 * @param {*} get
 * @returns {boolean}
 */
function isSingleTargetCard(card, player, get) {
	if (typeof get?.info !== "function") return false;
	let info = null;
	try {
		info = get.info(card);
	} catch (e) {
		info = null;
	}
	if (!info) return false;

	let select = info.selectTarget;
	/** @type {[number, number]|null} */
	let range = null;
	if (select === undefined || select === null) {
		range = [1, 1];
	} else if (typeof select === "number") {
		range = [select, select];
	} else if (typeof get?.itemtype === "function" && get.itemtype(select) === "select") {
		range = select;
	} else if (typeof select === "function") {
		try {
			range = select(card, player);
			if (typeof range === "number") range = [range, range];
		} catch (e) {
			range = null;
		}
	}

	if (!Array.isArray(range) || range.length < 2) return false;
	return range[0] === 1 && range[1] === 1;
}

/**
 * 判断一张牌是否为“单目标伤害牌”。
 *
 * @param {*} card
 * @param {*} player
 * @param {*} get
 * @returns {boolean}
 */
function isSingleTargetDamageCard(card, player, get) {
	if (typeof get?.tag !== "function") return false;
	let isDamage = false;
	try {
		isDamage = !!get.tag(card, "damage");
	} catch (e) {
		isDamage = false;
	}
	if (!isDamage) return false;
	return isSingleTargetCard(card, player, get);
}

/**
 * 安装“忠臣护主门禁”：以全局技能的 mod.playerEnabled 拦截不合理目标。
 *
 * @param {{lib:any, game:any, get:any, _status:any}} opts
 * @returns {void}
 */
export function installLoyalistProtectLordGuard({ lib, game, get, _status }) {
	if (!lib || !game) return;

	if (!lib.skill[SKILL_ID]) {
		lib.skill[SKILL_ID] = {
			charlotte: true,
			locked: true,
			priority: 10,
			mod: {
				/**
				 * 身份局：本地 AI 的忠臣禁止对主公做负面控场/单目标伤害。
				 *
				 * @param {*} card
				 * @param {*} player
				 * @param {*} target
				 * @returns {boolean|void}
				 */
				playerEnabled(card, player, target) {
					try {
						if (!card || !player || !target) return;
						if (typeof get?.mode === "function" && get.mode() !== "identity") return;
						if (!game?.zhu || target !== game.zhu) return;
						const selfId = String(player.identity || "");
						if (selfId !== "zhong" && selfId !== "mingzhong") return;

						// 仅影响“本地 AI”，避免影响人类手操
						const isLocalAI =
							typeof game?.__slqjAiPersona?.isLocalAIPlayer === "function"
								? game.__slqjAiPersona.isLocalAIPlayer(player, game, _status)
								: player !== game?.me || player?.isAuto === true;
						if (!isLocalAI) return;

						const cardName = getCardName(card);
						if (CONTROL_CARD_NAMES.has(cardName)) return false;
						if (isSingleTargetDamageCard(card, player, get)) return false;
					} catch (e) {
						// ignore
					}
				},
			},
		};
	}

	try {
		game.addGlobalSkill(SKILL_ID);
	} catch (e) {
		// ignore
	}
}
