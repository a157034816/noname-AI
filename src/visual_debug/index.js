/**
 * 身临其境：视觉调试（可选功能，默认关闭）。
 *
 * 目标：
 * - 出牌阶段：高亮 AI 最可能出的牌，并用指示线指向预测目标
 * - 弃牌阶段：用不同边框高亮区分“建议弃置/建议留下”
 *
 * 说明：
 * - 仅对“本地可操控”的交互选择 UI 生效（`event.isMine()` 或 `event.player.isUnderControl(true)`），避免旁观/联机影响
 * - 使用 `lib.hooks.checkEnd` 进行统一刷新；内部做 rAF 节流与签名去重
 */

/**
 * @typedef {import("../ai_persona/lib/jsdoc_types.js").SlqjAiExtensionConfig} SlqjAiExtensionConfig
 */

const STYLE_ID = "slqj-ai-visual-debug-style";

const CLASS_BEST_CARD = "slqj-ai-vd-best-card";
const CLASS_BEST_TARGET = "slqj-ai-vd-best-target";
const CLASS_DISCARD = "slqj-ai-vd-discard";
const CLASS_KEEP = "slqj-ai-vd-keep";
const CLASS_LINE = "slqj-ai-vd-line";

/** @type {boolean} */
let installed = false;

/** @type {null|Function} */
let checkEndHook = null;

/** @type {null|HTMLStyleElement} */
let styleNode = null;

/** @type {number} */
let rafId = 0;

/** @type {*|null} */
let pendingEvent = null;

/** @type {number} */
let scheduleToken = 0;

const state = {
	/** @type {"use"|"discard"|null} */
	mode: null,
	/** @type {string} */
	lastSignature: "",
	/** @type {*|null} */
	bestCard: null,
	/** @type {any[]} */
	bestTargets: [],
	/** @type {any[]} */
	discardCards: [],
	/** @type {any[]} */
	keepCards: [],
	/** @type {any[]} */
	lineNodes: [],
};

/**
 * 在不影响真实交互选择的前提下，临时模拟 `ui.selected.targets`。
 *
 * 说明：部分多目标牌（如【铁索连环】）的 AI 评分会参考 `ui.selected.targets.length`，
 * 需要在“第 N 个目标”的评分时模拟“已选目标数”。
 *
 * @template T
 * @param {*} ui
 * @param {any[]} virtualTargets
 * @param {() => T} fn
 * @returns {T}
 */
function withVirtualSelectedTargets(ui, virtualTargets, fn) {
	const selected = ui?.selected;
	if (!selected) return fn();
	const prev = selected.targets;
	try {
		selected.targets = virtualTargets;
		return fn();
	} catch (e) {
		return fn();
	} finally {
		try {
			selected.targets = prev;
		} catch (e) {
			// ignore
		}
	}
}

/**
 * 判断视觉调试是否启用。
 *
 * @param {*} lib
 * @param {SlqjAiExtensionConfig|any} config
 * @returns {boolean}
 */
function isEnabled(lib, config) {
	// 运行期优先读取 lib.config（即时生效）；同时兼容 extension_ 前缀键（部分环境下全局键可能缺失）。
	try {
		// 全局键（与其他模块一致）
		if (lib?.config?.slqj_ai_visual_debug_enable) return true;
		// 扩展前缀键（扩展菜单保存的主键）
		if (lib?.config?.["extension_身临其境的AI_slqj_ai_visual_debug_enable"]) return true;
		// precontent 传入的快照配置（兜底）
		if (config?.slqj_ai_visual_debug_enable) return true;
	} catch (e) {
		// ignore
	}
	return false;
}

/**
 * 注入样式（仅一次）。
 * @returns {void}
 */
function ensureStyle() {
	if (styleNode) return;
	try {
		if (typeof document === "undefined" || !document.head) return;
		const node = document.createElement("style");
		node.id = STYLE_ID;
		node.textContent = `
/* 身临其境的AI - 视觉调试 */
.${CLASS_BEST_CARD}{
	position: relative;
	/* 提升层级：避免被手牌堆叠遮住（不移动位置，仅改变叠放顺序） */
	z-index: 6;
	box-shadow: 0 0 0 2px rgba(236,201,71,0.95), 0 0 14px rgba(236,201,71,0.45) !important;
}
.${CLASS_BEST_CARD}::after{
	content: "AI";
	position: absolute;
	left: 4px;
	top: 4px;
	padding: 1px 4px;
	border-radius: 4px;
	font-size: 12px;
	line-height: 1.2;
	background: rgba(0,0,0,0.65);
	color: rgba(236,201,71,0.95);
	border: 1px solid rgba(236,201,71,0.85);
	z-index: 7;
	pointer-events: none;
}
.${CLASS_BEST_TARGET}{
	box-shadow: 0 0 0 2px rgba(236,201,71,0.75), 0 0 18px rgba(236,201,71,0.35) !important;
}
.${CLASS_DISCARD}{
	/* 不使用 !important：避免覆盖“已选中”红色高亮 */
	box-shadow: 0 0 0 2px rgba(255,80,80,0.95), 0 0 12px rgba(255,80,80,0.35);
	outline: 2px solid rgba(255,80,80,0.95) !important;
	outline-offset: -2px;
}
.${CLASS_KEEP}{
	/* 不使用 !important：避免覆盖“已选中”红色高亮 */
	box-shadow: 0 0 0 2px rgba(80,255,120,0.85), 0 0 12px rgba(80,255,120,0.25);
	outline: 2px solid rgba(80,255,120,0.85) !important;
	outline-offset: -2px;
}
.${CLASS_LINE}{
	pointer-events: none;
	z-index: 1001;
}
`;
		document.head.appendChild(node);
		styleNode = node;
	} catch (e) {
		// ignore
	}
}

/**
 * 移除样式。
 * @returns {void}
 */
function removeStyle() {
	if (!styleNode) return;
	try {
		styleNode.remove();
	} catch (e) {
		// ignore
	}
	styleNode = null;
}

/**
 * 安全移除某个 class。
 *
 * @param {*} node
 * @param {string} className
 * @returns {void}
 */
function safeRemoveClass(node, className) {
	try {
		if (node && node.classList && node.classList.contains(className)) {
			node.classList.remove(className);
		}
	} catch (e) {
		// ignore
	}
}

/**
 * 安全添加某个 class。
 *
 * @param {*} node
 * @param {string} className
 * @returns {void}
 */
function safeAddClass(node, className) {
	try {
		if (node && node.classList && !node.classList.contains(className)) {
			node.classList.add(className);
		}
	} catch (e) {
		// ignore
	}
}

/**
 * 清理所有视觉标记（不改变安装状态）。
 * @returns {void}
 */
function clearAll() {
	safeRemoveClass(state.bestCard, CLASS_BEST_CARD);
	for (const t of state.bestTargets) safeRemoveClass(t, CLASS_BEST_TARGET);
	for (const c of state.discardCards) safeRemoveClass(c, CLASS_DISCARD);
	for (const c of state.keepCards) safeRemoveClass(c, CLASS_KEEP);
	state.bestCard = null;
	state.bestTargets = [];
	state.discardCards = [];
	state.keepCards = [];
	state.mode = null;
	state.lastSignature = "";
	for (const n of state.lineNodes) {
		try {
			n && n.remove && n.remove();
		} catch (e) {
			// ignore
		}
	}
	state.lineNodes = [];
}

/**
 * 判断是否为“出牌阶段用牌选择”事件。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isPhaseChooseToUse(event) {
	if (!event) return false;
	if (String(event.name || "") !== "chooseToUse") return false;
	return String(event.type || "") === "phase";
}

/**
 * 判断是否为“本地可操控”的交互事件。
 *
 * 说明：`event.isMine()` 依赖 `game.me` 与 `_status.auto`，在“换人控制/单人控制”等场景下可能为 false；
 * 这里额外兼容 `event.player.isUnderControl(true)`，用于“你当前操控的角色”。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isLocalControllableEvent(event) {
	try {
		const player = event?.player;
		if (player && typeof player.isUnderControl === "function" && player.isUnderControl(true)) return true;
	} catch (e) {
		// ignore
	}
	try {
		if (event && typeof event.isMine === "function" && event.isMine()) return true;
	} catch (e) {
		// ignore
	}
	return false;
}

/**
 * 从任意事件中提取“出牌阶段的 chooseToUse(phase)”事件（包含自身/父事件）。
 *
 * @param {*} event
 * @returns {*|null}
 */
function getPhaseChooseToUseEvent(event) {
	if (!event) return null;
	if (isPhaseChooseToUse(event)) return event;
	try {
		if (typeof event.getParent !== "function") return null;
		const parent = event.getParent("chooseToUse", true);
		if (parent && isPhaseChooseToUse(parent)) return parent;
	} catch (e) {
		// ignore
	}
	return null;
}

/**
 * 从任意事件中提取“弃牌阶段的 chooseToDiscard”事件（包含自身/父事件）。
 *
 * @param {*} event
 * @returns {*|null}
 */
function getPhaseChooseToDiscardEvent(event) {
	if (!event) return null;
	if (isPhaseChooseToDiscard(event)) return event;
	try {
		if (typeof event.getParent !== "function") return null;
		const parent = event.getParent("chooseToDiscard", true);
		if (parent && isPhaseChooseToDiscard(parent)) return parent;
	} catch (e) {
		// ignore
	}
	return null;
}

/**
 * 判断是否为“弃牌阶段（phaseDiscard）里的 chooseToDiscard”事件。
 *
 * @param {*} event
 * @returns {boolean}
 */
function isPhaseChooseToDiscard(event) {
	if (!event) return false;
	if (String(event.name || "") !== "chooseToDiscard") return false;
	let e = event;
	for (let i = 0; i < 8 && e; i++) {
		if (String(e.name || "") === "phaseDiscard") return true;
		e = typeof e.getParent === "function" ? e.getParent() : null;
	}
	return false;
}

/**
 * 将任意返回值尽量转为有限数值。
 *
 * @param {*} v
 * @param {number} [fallback=0]
 * @returns {number}
 */
function toFiniteNumber(v, fallback = 0) {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return v;
}

/**
 * 安全执行评分函数。
 *
 * @param {*} fn
 * @param {any[]} args
 * @returns {number}
 */
function safeScore(fn, args) {
	if (typeof fn !== "function") return 0;
	try {
		return toFiniteNumber(fn.apply(null, args), 0);
	} catch (e) {
		return 0;
	}
}

/**
 * 计算“当前选择范围”（select 规范），失败则返回 [0,0]。
 *
 * @param {*} get
 * @param {*} select
 * @returns {[number, number]}
 */
function safeSelectRange(get, select) {
	try {
		if (get && typeof get.select === "function") {
			const r = get.select(select);
			if (Array.isArray(r) && r.length >= 2) return [Number(r[0]) || 0, Number(r[1]) || 0];
		}
	} catch (e) {
		// ignore
	}
	if (typeof select === "number") return [select, select];
	if (Array.isArray(select) && select.length >= 2) return [Number(select[0]) || 0, Number(select[1]) || 0];
	return [0, 0];
}

/**
 * 计算节点中心点（相对 ui.arena 的坐标系）。
 *
 * @param {*} node
 * @param {*} ui
 * @param {*} game
 * @returns {[number, number] | null}
 */
function getCenterInArena(node, ui, game) {
	try {
		if (!node || typeof node.getBoundingClientRect !== "function") return null;
		if (!ui?.arena || typeof ui.arena.getBoundingClientRect !== "function") return null;
		const zoom = typeof game?.documentZoom === "number" && game.documentZoom ? game.documentZoom : 1;
		const arenaRect = ui.arena.getBoundingClientRect();
		const rect = node.getBoundingClientRect();
		const x = (rect.left - arenaRect.left) / zoom + rect.width / (2 * zoom);
		const y = (rect.top - arenaRect.top) / zoom + rect.height / (2 * zoom);
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		return [x, y];
	} catch (e) {
		return null;
	}
}

/**
 * 选择出牌阶段“最可能使用的牌”（近似模拟 ai.basic.chooseCard 的 check 逻辑）。
 *
 * @param {*} event
 * @param {*} get
 * @param {*} player
 * @param {any[]} cards
 * @returns {*|null}
 */
function pickBestUseCard(event, get, player, cards) {
	if (!cards || !cards.length) return null;
	const check = typeof event?.ai1 === "function" ? event.ai1 : get?.cacheOrder;
	let best = null;
	let bestScore = -Infinity;
	for (const c of cards) {
		const s = safeScore(check, [c, cards, player, event]);
		if (s > bestScore) {
			bestScore = s;
			best = c;
		}
	}
	return best;
}

/**
 * 选择“预测目标”（单目标近似）。
 *
 * @param {*} event
 * @param {*} get
 * @param {*} game
 * @param {*} player
 * @param {*} card
 * @returns {*|null}
 */
function pickBestTarget(event, get, game, player, card) {
	if (!event || !player || !card) return null;

	// 不需要目标的牌直接跳过指示线
	try {
		const info = typeof get?.info === "function" ? get.info(card) : null;
		if (info && info.notarget) return null;
	} catch (e) {
		// ignore
	}

	// selectTarget=0 或不可选目标时跳过
	const selectTarget = event?.selectTarget;
	let targetRange = [1, 1];
	try {
		if (typeof selectTarget === "function") {
			targetRange = safeSelectRange(get, selectTarget(card, player));
		} else {
			targetRange = safeSelectRange(get, selectTarget);
		}
	} catch (e) {
		targetRange = [1, 1];
	}
	if (targetRange[1] <= 0) return null;

	const filterTarget = typeof event?.filterTarget === "function" ? event.filterTarget : null;
	if (!filterTarget) return null;

	/** @type {any[]} */
	const candidates = [];
	try {
		const list = Array.isArray(game?.players) ? game.players.slice() : [];
		// deadTarget 支持：根据牌信息把 dead 加入候选
		let deadTarget = false;
		try {
			const info = typeof get?.info === "function" ? get.info(card) : null;
			deadTarget = !!info?.deadTarget;
		} catch (e) {
			deadTarget = false;
		}
		if (deadTarget && Array.isArray(game?.dead)) {
			for (const d of game.dead) list.push(d);
		}
		for (const t of list) {
			if (!t) continue;
			let ok = false;
			try {
				ok = !!filterTarget.call(event, card, player, t);
			} catch (e) {
				ok = false;
			}
			if (ok) candidates.push(t);
		}
	} catch (e) {
		// ignore
	}
	if (!candidates.length) return null;

	const check = typeof event?.ai2 === "function" ? event.ai2 : get?.cacheEffectUse;
	let best = null;
	let bestScore = -Infinity;
	for (const t of candidates) {
		let s = safeScore(check, [t, card, player, player, false]);
		if (!Number.isFinite(s)) s = safeScore(check, [t, candidates]);
		if (s > bestScore) {
			bestScore = s;
			best = t;
		}
	}
	return best;
}

/**
 * 选择“预测目标列表”（多目标支持；近似模拟 ai.basic.chooseTarget 的 greedy 逻辑）。
 *
 * @param {*} event
 * @param {{lib:any, game:any, ui:any, get:any, _status:any, config:any}} env
 * @param {*} card
 * @returns {any[]}
 */
function pickBestTargets(event, env, card) {
	const { get, game, ui } = env;
	const player = event?.player;
	if (!event || !player || !card) return [];

	// 不需要目标的牌直接跳过指示线
	try {
		const info = typeof get?.info === "function" ? get.info(card) : null;
		if (info && info.notarget) return [];
	} catch (e) {
		// ignore
	}

	// selectTarget=0 或不可选目标时跳过
	const selectTarget = event?.selectTarget;
	let targetRange = [1, 1];
	try {
		if (typeof selectTarget === "function") {
			targetRange = safeSelectRange(get, selectTarget(card, player));
		} else {
			targetRange = safeSelectRange(get, selectTarget);
		}
	} catch (e) {
		targetRange = [1, 1];
	}
	if (targetRange[1] <= 0) return [];

	const filterTarget = typeof event?.filterTarget === "function" ? event.filterTarget : null;
	if (!filterTarget) return [];

	const max = Number.isFinite(targetRange[1]) ? Math.max(0, targetRange[1]) : 0;
	const min = Number.isFinite(targetRange[0]) ? Math.max(0, targetRange[0]) : 0;
	if (max <= 0) return [];

	// 出于 UI 可读性考虑：最多展示 4 条引导线
	const capMax = Math.min(4, max);

	// 候选池
	/** @type {any[]} */
	const pool = [];
	try {
		const list = Array.isArray(game?.players) ? game.players.slice() : [];
		// deadTarget 支持：根据牌信息把 dead 加入候选
		let deadTarget = false;
		try {
			const info = typeof get?.info === "function" ? get.info(card) : null;
			deadTarget = !!info?.deadTarget;
		} catch (e) {
			deadTarget = false;
		}
		if (deadTarget && Array.isArray(game?.dead)) {
			for (const d of game.dead) list.push(d);
		}
		for (const t of list) {
			if (t) pool.push(t);
		}
	} catch (e) {
		// ignore
	}
	if (!pool.length) return [];

	/**
	 * @param {any[]} selectedTargets
	 * @returns {any[]}
	 */
	function getSelectableTargets(selectedTargets) {
		return withVirtualSelectedTargets(ui, selectedTargets, () => {
			/** @type {any[]} */
			const out = [];
			for (const t of pool) {
				if (!t) continue;
				if (selectedTargets && selectedTargets.includes(t)) continue;
				let ok = false;
				try {
					ok = !!filterTarget.call(event, card, player, t);
				} catch (e) {
					ok = false;
				}
				if (ok) out.push(t);
			}
			return out;
		});
	}

	/**
	 * @param {any} target
	 * @param {any[]} selectedTargets
	 * @returns {number}
	 */
	function scoreTarget(target, selectedTargets) {
		return withVirtualSelectedTargets(ui, selectedTargets, () => {
			// 使用 get.cacheEffectUse：显式传入 card，避免依赖 get.card()/ui 选择状态
			return safeScore(get?.cacheEffectUse, [target, card, player, player, false]);
		});
	}

	/** @type {any[]} */
	const selected = [];
	const forced = !!event?.forced;

	for (let i = 0; i < capMax; i++) {
		const remaining = getSelectableTargets(selected);
		if (!remaining.length) break;

		let best = null;
		let bestScore = -Infinity;
		for (const t of remaining) {
			const s = scoreTarget(t, selected);
			if (s > bestScore) {
				bestScore = s;
				best = t;
			}
		}
		if (!best) break;

		const ok = selected.length >= min;
		if (bestScore <= 0 && (!forced || ok)) break;

		selected.push(best);
	}

	return selected;
}

/**
 * 获取“出牌阶段”候选牌列表（尽量与引擎 `game.Check.card` 的筛选一致）。
 *
 * @param {*} event
 * @param {{lib:any}} env
 * @returns {any[]}
 */
function getUsePhaseCandidateCards(event, env) {
	const player = event?.player;
	if (!player || typeof player.getCards !== "function") return [];

	try {
		if (typeof player.isOut === "function" && player.isOut()) return [];
	} catch (e) {
		// ignore
	}

	const position = typeof event?.position === "string" ? event.position : "hs";
	const filterCard = typeof event?.filterCard === "function" ? event.filterCard : null;
	if (!filterCard) return [];

	/** @type {any[]} */
	const out = [];
	const cards = player.getCards(position);
	const isMine = typeof event?.isMine === "function" ? !!event.isMine() : false;
	const excluded = Array.isArray(event?._aiexclude) ? event._aiexclude : [];
	for (const card of cards) {
		if (!card || !card.classList) continue;
		if (card.classList.contains("uncheck")) continue;

		if (!isMine && excluded.includes(card)) continue;

		let ok = false;
		try {
			// 引擎 check 逻辑：event.filterCard(card, player)（this 绑定为 event）
			ok = !!filterCard.call(event, card, player);
		} catch (e) {
			ok = false;
		}
		if (ok) out.push(card);
	}
	return out;
}

/**
 * 刷新“出牌阶段”的视觉提示。
 *
 * @param {*} event
 * @param {{lib:any, game:any, ui:any, get:any, _status:any, config:any}} env
 * @returns {void}
 */
function refreshUsePhase(event, env) {
	const { lib, game, ui, get, _status, config } = env;
	const player = event?.player;
	if (!player) return;

	// 激活技能（且技能需要选牌）时，不显示“AI 最可能用牌”的卡牌框与连接线，避免干扰技能选牌交互。
	// 仅影响 use-phase 的 bestCard/bestTarget/line；弃牌阶段高亮不受影响。
	try {
		if (event?.skill) {
			const info = typeof get?.info === "function" ? get.info(event.skill) : null;
			const hasCardSelect =
				!!info?.filterCard &&
				(typeof event?.selectCard === "function" || safeSelectRange(get, event?.selectCard)[1] > 0);
			if (hasCardSelect) {
				const sig = [String(event?.id || ""), "use-skill", String(event?.skill || "")].join("|");
				state.lastSignature = sig;
				if (state.mode !== "use") {
					clearAll();
					state.mode = "use";
				}

				// 清理出牌/弃牌阶段残留（不影响安装状态）
				safeRemoveClass(state.bestCard, CLASS_BEST_CARD);
				for (const t of state.bestTargets) safeRemoveClass(t, CLASS_BEST_TARGET);
				for (const c of state.discardCards) safeRemoveClass(c, CLASS_DISCARD);
				for (const c of state.keepCards) safeRemoveClass(c, CLASS_KEEP);
				state.bestCard = null;
				state.bestTargets = [];
				state.discardCards = [];
				state.keepCards = [];
				for (const n of state.lineNodes) {
					try {
						n && n.remove && n.remove();
					} catch (e) {
						// ignore
					}
				}
				state.lineNodes = [];
				return;
			}
		}
	} catch (e) {
		// ignore
	}

	const selectedCard = ui?.selected?.cards?.[0] || null;
	const selectableCards =
		_status?.event === event && typeof get?.selectableCards === "function" ? get.selectableCards() : [];
	const candidates = selectableCards.length ? selectableCards : getUsePhaseCandidateCards(event, env);
	const candidateSig = candidates.map((c) => String(c?.cardid || "")).join(",");
	const sig = [
		String(event?.id || ""),
		"use",
		String(event?.skill || ""),
		String(selectedCard?.cardid || ""),
		candidateSig,
		String(ui?.selected?.targets?.length || 0),
	].join("|");
	if (sig === state.lastSignature) return;
	state.lastSignature = sig;

	if (state.mode !== "use") {
		clearAll();
		state.mode = "use";
	}

	// 清掉弃牌阶段残留
	for (const c of state.discardCards) safeRemoveClass(c, CLASS_DISCARD);
	for (const c of state.keepCards) safeRemoveClass(c, CLASS_KEEP);
	state.discardCards = [];
	state.keepCards = [];

	const bestCard = pickBestUseCard(event, get, player, candidates);
	if (bestCard !== state.bestCard) {
		safeRemoveClass(state.bestCard, CLASS_BEST_CARD);
		state.bestCard = bestCard || null;
		safeAddClass(state.bestCard, CLASS_BEST_CARD);
	}

	// 未选出“推荐牌”则清理目标/线
	if (!state.bestCard) {
		for (const t of state.bestTargets) safeRemoveClass(t, CLASS_BEST_TARGET);
		state.bestTargets = [];
		for (const n of state.lineNodes) {
			try {
				n && n.remove && n.remove();
			} catch (e) {
				// ignore
			}
		}
		state.lineNodes = [];
		return;
	}

	const bestTargets = pickBestTargets(event, env, state.bestCard);
	// 更新目标高亮（允许多目标）
	for (const t of state.bestTargets) safeRemoveClass(t, CLASS_BEST_TARGET);
	state.bestTargets = Array.isArray(bestTargets) ? bestTargets.filter(Boolean) : [];
	for (const t of state.bestTargets) safeAddClass(t, CLASS_BEST_TARGET);

	// 指示线
	if (!state.bestTargets.length || typeof game?.linexy !== "function") {
		for (const n of state.lineNodes) {
			try {
				n && n.remove && n.remove();
			} catch (e) {
				// ignore
			}
		}
		state.lineNodes = [];
		return;
	}

	const from = getCenterInArena(state.bestCard, ui, game);
	if (!from) {
		for (const n of state.lineNodes) {
			try {
				n && n.remove && n.remove();
			} catch (e) {
				// ignore
			}
		}
		state.lineNodes = [];
		return;
	}

	try {
		/** @type {any[]} */
		const newLines = [];
		for (let i = 0; i < state.bestTargets.length; i++) {
			const target = state.bestTargets[i];
			const to = getCenterInArena(target, ui, game);
			if (!to) continue;
			const existing = state.lineNodes[i] || null;
			if (!existing) {
				const node = game.linexy([from[0], from[1], to[0], to[1]], "drag");
				safeAddClass(node, CLASS_LINE);
				newLines.push(node);
			} else {
				existing.style.left = `${from[0]}px`;
				existing.style.top = `${from[1]}px`;
				game.linexy([from[0], from[1], to[0], to[1]], "drag", existing);
				newLines.push(existing);
			}
		}
		// 清理多余旧线
		for (let i = newLines.length; i < state.lineNodes.length; i++) {
			try {
				state.lineNodes[i] && state.lineNodes[i].remove && state.lineNodes[i].remove();
			} catch (e) {
				// ignore
			}
		}
		state.lineNodes = newLines;
	} catch (e) {
		// ignore
	}
}

/**
 * 刷新“弃牌阶段”的视觉提示。
 *
 * @param {*} event
 * @param {{lib:any, game:any, ui:any, get:any, _status:any, config:any}} env
 * @returns {void}
 */
function refreshDiscardPhase(event, env) {
	const { game, ui, get } = env;
	const player = event?.player;
	if (!player) return;

	// selectCard 为函数时无法可靠计算“需要弃置数量”，直接跳过
	if (typeof event?.selectCard === "function") return;
	const range = safeSelectRange(get, event?.selectCard);
	const discardNum = range[0] === range[1] ? range[0] : range[0];
	if (!discardNum || discardNum <= 0) return;

	const allCards = player.getCards(event.position || "h");
	const candidates = allCards.filter((c) => {
		if (!c || !c.classList) return false;
		if (c.classList.contains("removing")) return false;
		return c.classList.contains("selectable") || c.classList.contains("selected");
	});
	const candidateSig = candidates.map((c) => String(c?.cardid || "")).join(",");
	const sig = [
		String(event?.id || ""),
		"discard",
		String(discardNum),
		candidateSig,
		String(ui?.selected?.cards?.length || 0),
	].join("|");
	if (sig === state.lastSignature) return;
	state.lastSignature = sig;

	if (state.mode !== "discard") {
		clearAll();
		state.mode = "discard";
	}

	// 清掉出牌阶段残留
	safeRemoveClass(state.bestCard, CLASS_BEST_CARD);
	for (const t of state.bestTargets) safeRemoveClass(t, CLASS_BEST_TARGET);
	state.bestCard = null;
	state.bestTargets = [];
	for (const n of state.lineNodes) {
		try {
			n && n.remove && n.remove();
		} catch (e) {
			// ignore
		}
	}
	state.lineNodes = [];

	// 先移除旧标记
	for (const c of state.discardCards) safeRemoveClass(c, CLASS_DISCARD);
	for (const c of state.keepCards) safeRemoveClass(c, CLASS_KEEP);
	state.discardCards = [];
	state.keepCards = [];

	const check = typeof event?.ai === "function" ? event.ai : get?.unuseful;
	const scored = candidates.map((c) => ({
		card: c,
		score: safeScore(check, [c, candidates, player, event]),
	}));
	scored.sort((a, b) => (b.score || 0) - (a.score || 0));

	const discardSet = new Set(scored.slice(0, Math.min(discardNum, scored.length)).map((x) => x.card));
	for (const x of scored) {
		if (discardSet.has(x.card)) {
			state.discardCards.push(x.card);
			safeAddClass(x.card, CLASS_DISCARD);
		} else {
			state.keepCards.push(x.card);
			safeAddClass(x.card, CLASS_KEEP);
		}
	}
}

/**
 * 安排一次刷新（rAF 合并；同帧多次 checkEnd 只刷新一次）。
 *
 * @param {*} event
 * @param {{lib:any, game:any, ui:any, get:any, _status:any, config:any}} env
 * @returns {void}
 */
function scheduleRefresh(event, env) {
	pendingEvent = event;
	if (rafId) return;
	const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
	scheduleToken += 1;
	const token = scheduleToken;
	rafId = raf(() => {
		rafId = 0;
		const evt = pendingEvent;
		pendingEvent = null;
		refreshOnce(evt, env);

		// 额外再跑一帧：兼容部分 UI 在 setTimeout/异步布局后重建节点导致样式丢失
		const raf2 = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
		raf2(() => {
			if (!installed) return;
			if (scheduleToken !== token) return;
			// 第二帧强制刷新：避免“节点重建但签名不变”导致样式未重新挂载（典型表现：必须点选卡牌才出现高亮）。
			refreshOnce(evt, env, true);
		});
	});
}

/**
 * 执行一次刷新（不做节流；由 scheduleRefresh 调用）。
 *
 * @param {*} event
 * @param {{lib:any, game:any, ui:any, get:any, _status:any, config:any}} env
 * @param {boolean} [force=false] 强制刷新（忽略签名去重），用于兼容 UI 节点异步重建。
 * @returns {void}
 */
function refreshOnce(event, env, force = false) {
	try {
		if (!installed) return;
		const evt = event;
		if (!evt || !isLocalControllableEvent(evt)) {
			if (state.mode) clearAll();
			return;
		}
		if (!isEnabled(env.lib, env.config) || env._status?.connectMode) {
			if (state.mode) clearAll();
			return;
		}

		// 在 refresh 时兜底确保样式存在（避免 precontent 早期 document.head 尚不可用导致未注入）
		ensureStyle();

		if (isPhaseChooseToUse(evt)) {
			if (force) state.lastSignature = "";
			refreshUsePhase(evt, env);
			return;
		}
		if (isPhaseChooseToDiscard(evt)) {
			if (force) state.lastSignature = "";
			refreshDiscardPhase(evt, env);
			return;
		}
		if (state.mode) clearAll();
	} catch (e) {
		// ignore
	}
}

/**
 * 安装视觉调试模块：注册 hooks + 注入 CSS。
 *
 * @param {{lib:any, game:any, ui:any, get:any, ai:any, _status:any, config:SlqjAiExtensionConfig|any}} opts
 * @returns {void}
 */
export function installVisualDebug(opts) {
	if (installed) return;
	if (!opts || !opts.lib || !opts.game || !opts.get) return;
	if (opts._status?.connectMode) return;

	installed = true;
	ensureStyle();

	if (!opts.lib.hooks) opts.lib.hooks = /** @type {any} */ ({});
	if (!Array.isArray(opts.lib.hooks.checkEnd)) opts.lib.hooks.checkEnd = [];

	checkEndHook = function (event, _args) {
		try {
			// 未启用时也需要做清理（避免切换开关后残留）
			if (!isEnabled(opts.lib, opts.config) || opts._status?.connectMode) {
				if (state.mode) clearAll();
				return;
			}
			const useEvt = getPhaseChooseToUseEvent(event);
			if (useEvt) {
				scheduleRefresh(useEvt, opts);
				return;
			}
			const discardEvt = getPhaseChooseToDiscardEvent(event);
			if (discardEvt) {
				scheduleRefresh(discardEvt, opts);
				return;
			}
			if (state.mode) scheduleRefresh(null, opts);
		} catch (e) {
			// ignore
		}
	};

	opts.lib.hooks.checkEnd.push(checkEndHook);
}

/**
 * 卸载视觉调试模块：移除 hooks + 清理 UI。
 *
 * @param {{lib:any}} opts
 * @returns {void}
 */
export function uninstallVisualDebug(opts) {
	if (!installed) return;
	installed = false;

	if (rafId) {
		try {
			const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
			caf(rafId);
		} catch (e) {
			// ignore
		}
		rafId = 0;
	}

	try {
		const hooks = opts?.lib?.hooks?.checkEnd;
		if (Array.isArray(hooks) && checkEndHook) {
			const idx = hooks.indexOf(checkEndHook);
			if (idx >= 0) hooks.splice(idx, 1);
		}
	} catch (e) {
		// ignore
	}
	checkEndHook = null;
	pendingEvent = null;
	clearAll();
	removeStyle();
}
