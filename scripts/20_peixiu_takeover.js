import { isLocalAIPlayer } from "../src/ai_persona/lib/utils.js";

/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 */

/**
 * scripts 插件元信息（用于“脚本插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "裴秀 AI 接管（行图/爵制）",
	version: "1.0.3",
	description: "接管裴秀（peixiu）AI 的关键选牌：优先行图约数摸牌与倍数无次数限制，并优化爵制合成点数的选牌。",
};

/**
 * 全局开关：是否启用“贪心 + 少量前瞻（1 步）”。
 *
 * - 关闭：仅使用当前牌的局部收益（约数/倍数/断链等）做贪心影响
 * - 开启：额外估计“打出该牌后，下一步是否更容易继续约数/倍数链”，并叠加到评分
 *
 * 注意：这是启发式近似，不会真实模拟出牌合法性/牌堆/摸牌结果。
 *
 * @type {boolean}
 */
const ENABLE_GREEDY_LOOKAHEAD = true;

/**
 * 前瞻策略模式：
 * - `"A"`：偏“不断链摸牌”（约数链）优先
 * - `"B"`：偏“倍数爆发”（无次数限制）优先
 * - `"random"`：每一局开始时随机为 A 或 B，并固定整局
 *
 * @type {"A"|"B"|"random"}
 */
const GREEDY_LOOKAHEAD_MODE = "A";

/**
 * 默认策略参数（可在脚本内调整）。
 *
 * @type {{
 *  hookPriority:number,
 *  onlyLocalAi:boolean,
 *  debug:boolean,
 *  disableBuiltinNoise:boolean,
 *  enableJuezhiPick:boolean,
 *  divisorBonus:number,
 *  multipleBonus:number,
 *  breakPenalty:number,
 *  smallMarkMultipleExtra:number
 * }}
 */
const DEFAULT_CFG = {
	hookPriority: 1,
	onlyLocalAi: true,
	debug: false,
	disableBuiltinNoise: true,
	enableJuezhiPick: true,
	divisorBonus: 1.0,
	multipleBonus: 0.45,
	breakPenalty: 0.6,
	smallMarkMultipleExtra: 0.35,
};

const PEIXIU_KEYS = new Set(["peixiu"]);
const KEY_KEEP_CARDS = new Set(["tao", "wuxie", "wuzhong", "shunshou", "guohe", "tiesuo", "jiu"]);

/**
 * scripts 插件入口：安装裴秀接管逻辑。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setup(ctx) {
	const { game, hooks, _status, lib, get, ai } = ctx || {};
	if (!game || !hooks || !lib) return;
	if (_status?.connectMode) return;

	const runtime = getOrCreateRuntime(game);
	if (!runtime) return;
	if (runtime.installed) return;

	runtime.installed = true;
	runtime.cfg = { ...DEFAULT_CFG };
	runtime._status = _status || null;
	runtime.get = get || null;

	// 允许通过 dev 或控制台开关打开更详细日志
	try {
		runtime.cfg.debug =
			runtime.cfg.debug === true ||
			!!lib?.config?.dev ||
			globalThis.__slqjAiPeixiuTakeoverDebug === true;
	} catch (e) {}
	const logger = createLogger(lib, runtime);
	logger.info("installed", { onlyLocalAi: !!runtime.cfg?.onlyLocalAi, debug: logger.isDebug() });
	runtime.lookaheadStrategy = resolveLookaheadStrategy(game, runtime);
	logger.info("greedy-lookahead", {
		enabled: ENABLE_GREEDY_LOOKAHEAD,
		mode: GREEDY_LOOKAHEAD_MODE,
		strategy: runtime.lookaheadStrategy || null,
	});

	installRuntimeApi({ game, lib, runtime });
	installGlobalTrackerSkill({ game, lib });
	installScoreHook({ game, hooks, runtime });
}

/**
 * @param {*} game
 * @returns {{installed?:boolean,cfg:any,_status:any,get:any,stateByKey:Record<string, any>,api?:any}|null}
 */
function getOrCreateRuntime(game) {
	if (!game) return null;
	try {
		game.__slqjAiPersona ??= Object.create(null);
	} catch (e) {
		return null;
	}
	const root = game.__slqjAiPersona;
	root.peixiuTakeover ??= Object.create(null);
	const rt = root.peixiuTakeover;
	if (!rt.stateByKey || typeof rt.stateByKey !== "object") rt.stateByKey = Object.create(null);
	return rt;
}

/**
 * 决定本局使用的“前瞻策略”（A/B）。
 *
 * - 若已存在（例如脚本重复加载），直接复用
 * - `GREEDY_LOOKAHEAD_MODE === "random"` 时，本局随机选 A 或 B，并固定整局
 *
 * @param {*} game
 * @param {*} runtime
 * @returns {"A"|"B"|null}
 */
function resolveLookaheadStrategy(game, runtime) {
	try {
		const existing = runtime?.lookaheadStrategy;
		if (existing === "A" || existing === "B") return existing;
	} catch (e) {}

	if (!ENABLE_GREEDY_LOOKAHEAD) return null;

	if (GREEDY_LOOKAHEAD_MODE === "A") return "A";
	if (GREEDY_LOOKAHEAD_MODE === "B") return "B";

	// random：按“每局”固定。这里用 runtime 存储即可满足“同局固定”的需求。
	try {
		return Math.random() < 0.5 ? "A" : "B";
	} catch (e) {
		return "A";
	}
}

/**
 * 创建脚本日志器（用于排查“是否接管生效/行图点数跟踪是否正确/当前处于何种决策事件”等）。
 *
 * 说明：
 * - 默认仅输出少量关键日志（安装/全局 skill 安装）；避免刷屏
 * - 详细调试日志需开启 debug：
 *   - `lib.config.dev === true` 或
 *   - 控制台设置 `globalThis.__slqjAiPeixiuTakeoverDebug = true`
 *
 * @param {*} lib
 * @param {*} runtime
 * @returns {{info:(...args:any[])=>void, warn:(...args:any[])=>void, debug:(...args:any[])=>void, isDebug:()=>boolean}}
 */
function createLogger(lib, runtime) {
	const prefix = "[身临其境的AI][peixiu_takeover]";
	/**
	 * @returns {boolean}
	 */
	function isDebug() {
		try {
			if (runtime?.cfg?.debug === true) return true;
		} catch (e) {}
		try {
			if (lib?.config?.dev) return true;
		} catch (e) {}
		try {
			if (globalThis.__slqjAiPeixiuTakeoverDebug === true) return true;
		} catch (e) {}
		return false;
	}

	/**
	 * @param {any} fn
	 * @param {any[]} args
	 * @returns {void}
	 */
	function safeCall(fn, args) {
		try {
			if (typeof console === "undefined") return;
			if (!console) return;
			if (typeof fn !== "function") return;
			fn(prefix, ...args);
		} catch (e) {}
	}

	return {
		info: (...args) => safeCall(console?.info, args),
		warn: (...args) => safeCall(console?.warn, args),
		debug: (...args) => {
			if (!isDebug()) return;
			safeCall(console?.info, args);
		},
		isDebug,
	};
}

/**
 * 获取玩家稳定 key（用于 runtime.stateByKey 记录）。
 *
 * @param {*} player
 * @returns {string}
 */
function getPlayerKey(player) {
	if (!player) return "";
	if (player.playerid) return String(player.playerid);
	if (player.dataset && player.dataset.position != null) return `pos:${String(player.dataset.position)}`;
	if (player.name) return `name:${String(player.name)}`;
	return "";
}

/**
 * 判断是否为裴秀（peixiu），兼容双将/别名。
 *
 * @param {*} player
 * @returns {boolean}
 */
function isPeixiuPlayer(player) {
	if (!player) return false;
	const names = [];
	if (player.name) names.push(String(player.name));
	if (player.name1) names.push(String(player.name1));
	if (player.name2) names.push(String(player.name2));
	try {
		if (typeof player.getNames === "function") {
			const arr = player.getNames();
			if (Array.isArray(arr)) for (const n of arr) names.push(String(n));
		}
	} catch (e) {}
	for (const n of names) {
		if (PEIXIU_KEYS.has(n)) return true;
	}
	try {
		if (typeof player.hasSkill === "function") {
			if (player.hasSkill("xingtu") || player.hasSkill("juezhi")) return true;
		}
	} catch (e) {}
	return false;
}

/**
 * @param {*} get
 * @param {*} card
 * @param {*} player
 * @returns {number|null}
 */
function safeGetNumber(get, card, player) {
	if (!card) return null;
	try {
		if (get && typeof get.number === "function") {
			const n = get.number(card, player);
			if (typeof n === "number" && !Number.isNaN(n)) return n;
		}
	} catch (e) {}
	const n2 = card.number;
	if (typeof n2 === "number" && !Number.isNaN(n2)) return n2;
	// vcard 兜底：单卡转化（如 viewAs）时，点数通常来自底层实体牌
	try {
		const subs = card.cards;
		if (Array.isArray(subs) && subs.length === 1) {
			const n3 = safeGetNumber(get, subs[0], player);
			if (typeof n3 === "number" && !Number.isNaN(n3)) return n3;
		}
	} catch (e) {}
	return null;
}

/**
 * 将 sum 映射到 1..13（取模 13，0 视为 13）。
 *
 * @param {number} sum
 * @returns {number}
 */
function mod13(sum) {
	let n = sum % 13;
	if (n === 0) n = 13;
	return n;
}

/**
 * @param {*} card
 * @param {string} tag
 * @returns {boolean}
 */
function hasGainTag(card, tag) {
	if (!card) return false;
	try {
		if (typeof card.hasGaintag === "function" && card.hasGaintag(tag)) return true;
	} catch (e) {}
	// vcard：gaintag 通常挂在底层实体牌上（card.cards）
	try {
		const subs = card.cards;
		if (Array.isArray(subs)) {
			for (const c of subs) {
				try {
					if (c && typeof c.hasGaintag === "function" && c.hasGaintag(tag)) return true;
				} catch (e2) {}
			}
		}
	} catch (e) {}
	return false;
}

/**
 * @param {*} get
 * @param {*} card
 * @returns {string}
 */
function safeGetCardName(get, card) {
	if (!card) return "";
	const n = card.name;
	if (typeof n === "string") return n;
	try {
		if (get && typeof get.name === "function") return String(get.name(card));
	} catch (e) {}
	return "";
}

/**
 * @param {*} get
 * @param {*} card
 * @param {*} player
 * @returns {number}
 */
function safeGetValue(get, card, player) {
	try {
		if (get && typeof get.value === "function") {
			const v = get.value(card, player);
			if (typeof v === "number" && !Number.isNaN(v)) return v;
		}
	} catch (e) {}
	return 0;
}

/**
 * @param {*} get
 * @param {*} card
 * @param {*} player
 * @returns {boolean}
 */
function isEquipCard(get, card, player) {
	try {
		if (get && typeof get.type === "function") return get.type(card, player) === "equip";
	} catch (e) {}
	return false;
}

/**
 * 取得当前“行图点数”标记（优先读取引擎维护的 `player.storage.xingtu_mark`）。
 *
 * @param {*} player
 * @param {*} runtime
 * @returns {number|null}
 */
function getXingtuMark(player, runtime) {
	const n = player?.storage?.xingtu_mark;
	if (typeof n === "number" && !Number.isNaN(n) && n > 0) return n;
	const n2 = player?.storage?.xingtu;
	if (typeof n2 === "number" && !Number.isNaN(n2) && n2 > 0) return n2;
	const key = getPlayerKey(player);
	const st = key ? runtime?.stateByKey?.[key] : null;
	const n3 = st?.lastMark;
	if (typeof n3 === "number" && !Number.isNaN(n3) && n3 > 0) return n3;
	return null;
}

/**
 * @param {number} mark
 * @param {number} num
 * @returns {boolean}
 */
function isDivisor(mark, num) {
	return !!(mark && num && mark % num === 0);
}

/**
 * @param {number} mark
 * @param {number} num
 * @returns {boolean}
 */
function isMultiple(mark, num) {
	return !!(mark && num && num % mark === 0);
}

/**
 * @param {*} ev
 * @returns {string}
 */
function pickEventSkill(ev) {
	if (!ev) return "";
	if (typeof ev.skill === "string") return ev.skill;
	try {
		if (typeof ev.getParent === "function") {
			const p = ev.getParent();
			if (typeof p?.skill === "string") return p.skill;
		}
	} catch (e) {}
	return "";
}

/**
 * @param {*} ev
 * @returns {boolean}
 */
function isJuezhiEvent(ev) {
	const s = pickEventSkill(ev);
	if (s && s.includes("juezhi")) return true;
	const n = String(ev?.name || "");
	return n.includes("juezhi");
}

/**
 * @param {*} ev
 * @returns {boolean}
 */
function isDiscardLikeEvent(ev) {
	const n = String(ev?.name || "");
	return n.includes("discard") || n.includes("chooseToDiscard");
}

/**
 * @param {*} ev
 * @returns {boolean}
 */
function isUseLikeEvent(ev) {
	const n = String(ev?.name || "");
	return n.includes("use") || n.includes("chooseToUse") || n.includes("useCard");
}

/**
 * @param {*} card
 * @param {*} get
 * @returns {boolean}
 */
function isKeyKeepCard(card, get) {
	const name = safeGetCardName(get, card);
	return KEY_KEEP_CARDS.has(name);
}

/**
 * 把“需要在 skill.content/filter 中调用”的函数挂到 game.__slqjAiPersona.peixiuTakeover.api 上。
 *
 * @param {{game:any,lib:any,runtime:any}} opts
 * @returns {void}
 */
function installRuntimeApi({ game, lib, runtime }) {
	if (!runtime.api || typeof runtime.api !== "object") runtime.api = Object.create(null);
	const logger = createLogger(lib, runtime);

	/**
	 * @param {*} event
	 * @param {*} player
	 * @returns {boolean}
	 */
	runtime.api.filterUseCard1 = (event, player) => {
		try {
			if (!player) return false;
			// 自机：默认不影响手操；仅在托管（isAuto===true）时启用（避免影响手操）
			if (player === game.me) {
				const st = runtime._status || globalThis._status;
				if (!isLocalAIPlayer(player, game, st)) return false;
			}
			if (!isPeixiuPlayer(player)) return false;
			if (runtime.cfg?.onlyLocalAi) {
				const st = runtime._status || globalThis._status;
				if (!isLocalAIPlayer(player, game, st)) return false;
			}
			return !!event?.card;
		} catch (e) {
			return false;
		}
	};

	/**
	 * @param {*} player
	 * @param {*} card
	 * @returns {void}
	 */
	runtime.api.onUseCard1 = (player, card) => {
		const key = getPlayerKey(player);
		if (!key) return;
		const st = (runtime.stateByKey[key] ??= Object.create(null));
		const n = safeGetNumber(runtime.get || globalThis.get, card, player);
		if (typeof n === "number" && n > 0) {
			st.lastMark = n;
			logger.debug("track mark", { player: key, card: safeGetCardName(runtime.get || globalThis.get, card), number: n });
		}
	};
}

/**
 * 安装全局跟踪 skill：记录裴秀上一张“使用牌”的点数（用于 `xingtu_mark` 缺失时兜底）。
 *
 * @param {{game:any,lib:any}} opts
 * @returns {void}
 */
function installGlobalTrackerSkill({ game, lib }) {
	if (!game || !lib) return;
	if (game.__slqjAiPersona?.peixiuTakeoverTrackerInstalled) return;
	game.__slqjAiPersona.peixiuTakeoverTrackerInstalled = true;
	const runtime = game.__slqjAiPersona?.peixiuTakeover || null;
	const logger = createLogger(lib, runtime);

	if (!lib.skill.slqj_ai_peixiu_takeover_track_mark) {
		lib.skill.slqj_ai_peixiu_takeover_track_mark = {
			trigger: { player: "useCard1" },
			forced: true,
			silent: true,
			popup: false,
			filter(event, player) {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.peixiuTakeover?.api;
				if (!api || typeof api.filterUseCard1 !== "function") return false;
				try {
					return !!api.filterUseCard1(event, player);
				} catch (e) {
					return false;
				}
			},
			content() {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.peixiuTakeover?.api;
				if (!api || typeof api.onUseCard1 !== "function") return;
				try {
					api.onUseCard1(typeof player !== "undefined" ? player : null, trigger?.card || null);
				} catch (e) {}
			},
		};
	}

	try {
		game.addGlobalSkill("slqj_ai_peixiu_takeover_track_mark");
		logger.info("global skill installed", "slqj_ai_peixiu_takeover_track_mark");
	} catch (e) {}
}

/**
 * 安装 score hook：在选择器评分阶段注入裴秀专属影响。
 *
 * @param {{game:any,hooks:any,runtime:any}} opts
 * @returns {void}
 */
function installScoreHook({ game, hooks, runtime }) {
	if (!hooks || typeof hooks.on !== "function") return;
	const logger = createLogger(globalThis.lib || null, runtime);

	hooks.on(
		"slqj_ai_score",
		(ctx) => {
			if (!ctx || ctx.kind !== "chooseCard" || ctx.stage !== "final") return;
			const player = ctx.player;
			if (!isPeixiuPlayer(player)) return;

			if (runtime.cfg?.onlyLocalAi) {
				const st = runtime._status || globalThis._status;
				if (!isLocalAIPlayer(player, ctx.game || game, st)) return;
			}

			if (runtime.cfg?.disableBuiltinNoise) {
				ctx.skipBuiltin = true;
			}

			const card = ctx.candidate;
			const get = ctx.get || runtime.get || globalThis.get;
			const num = safeGetNumber(get, card, player);
			if (!num) return;

			const ev = ctx.event;
			const mark = getXingtuMark(player, runtime);
			logDecisionHeaderOnce(logger, runtime, ctx, player, get, ev, mark);

			if (runtime.cfg?.enableJuezhiPick && isJuezhiEvent(ev)) {
				applyJuezhiPickBias(ctx, runtime, player, get, num, mark);
				return;
			}

			// 非“用牌”场景（如弃牌、支付代价等）不强行套入行图逻辑，避免误导。
			if (!isUseLikeEvent(ev) || isDiscardLikeEvent(ev)) return;
			if (typeof ctx.base === "number" && ctx.base <= 0) return;

			applyXingtuUseBias(ctx, runtime, player, get, card, num, mark);
		},
		{ priority: runtime.cfg?.hookPriority ?? DEFAULT_CFG.hookPriority }
	);
}

/**
 * 仅对同一个事件对象（或同一批次 all[0]）打印一次“决策摘要”头，避免刷屏。
 *
 * @param {{debug:Function,isDebug:Function}|any} logger
 * @param {*} runtime
 * @param {*} ctx
 * @param {*} player
 * @param {*} get
 * @param {*} ev
 * @param {number|null} mark
 * @returns {void}
 */
function logDecisionHeaderOnce(logger, runtime, ctx, player, get, ev, mark) {
	if (!logger || typeof logger.debug !== "function") return;
	if (typeof logger.isDebug === "function" && !logger.isDebug()) return;

	const key = getPlayerKey(player) || "unknown";
	/** @type {Record<string, any>|null} */
	let stateByKey = runtime && typeof runtime === "object" ? runtime.stateByKey : null;
	if (!stateByKey || typeof stateByKey !== "object") {
		if (runtime && typeof runtime === "object") runtime.stateByKey = stateByKey = Object.create(null);
	}
	const st = stateByKey ? (stateByKey[key] ?? (stateByKey[key] = Object.create(null))) : Object.create(null);

	// 优先用 WeakSet 基于“事件对象引用”去重
	try {
		if (!st._seenEvents && typeof WeakSet !== "undefined") st._seenEvents = new WeakSet();
	} catch (e) {}
	try {
		if (ev && st._seenEvents && typeof st._seenEvents.has === "function") {
			if (st._seenEvents.has(ev)) return;
			st._seenEvents.add(ev);
			logger.debug("decision", {
				player: key,
				event: String(ev?.name || ""),
				skill: pickEventSkill(ev),
				mark,
				selected: safeSelectedNums(get, player),
			});
			return;
		}
	} catch (e) {}

	// 兜底：若 candidate 恰好是 all[0]，把它当作“该次评分批次”的第一次调用
	try {
		if (Array.isArray(ctx?.all) && ctx.all.length && ctx.candidate === ctx.all[0]) {
			const sig = String(ctx.kind || "") + ":" + String(ev?.name || "") + ":" + String(pickEventSkill(ev) || "");
			if (st._lastBatchSig === sig) return;
			st._lastBatchSig = sig;
			logger.debug("decision", {
				player: key,
				event: String(ev?.name || ""),
				skill: pickEventSkill(ev),
				mark,
				selected: safeSelectedNums(get, player),
			});
		}
	} catch (e) {}
}

/**
 * @param {*} get
 * @param {*} player
 * @returns {number[]}
 */
function safeSelectedNums(get, player) {
	const selected = pickSelectedCards();
	const nums = [];
	for (const c of selected) {
		const n = safeGetNumber(get, c, player);
		if (typeof n === "number") nums.push(n);
	}
	return nums;
}

/**
 * 统计“打出本牌后（mark 变为 newMark）”，手牌还能继续形成的约数/倍数关系数量。
 *
 * @param {*} player
 * @param {*} get
 * @param {*} cardUsed
 * @param {number} newMark
 * @returns {{divisorCount:number, multipleCount:number, anyNumber:boolean}}
 */
function getLookaheadCounts(player, get, cardUsed, newMark) {
	if (!player || typeof newMark !== "number" || Number.isNaN(newMark) || newMark <= 0) {
		return { divisorCount: 0, multipleCount: 0, anyNumber: false };
	}
	if (typeof player.getCards !== "function") return { divisorCount: 0, multipleCount: 0, anyNumber: false };

	let hand = [];
	try {
		hand = player.getCards("h") || [];
	} catch (e) {
		hand = [];
	}
	if (!Array.isArray(hand) || !hand.length) return { divisorCount: 0, multipleCount: 0, anyNumber: false };

	let divisorCount = 0;
	let multipleCount = 0;
	let anyNumber = false;

	for (const c of hand) {
		if (!c || c === cardUsed) continue;
		const n = safeGetNumber(get, c, player);
		if (typeof n !== "number" || Number.isNaN(n) || n <= 0) continue;
		anyNumber = true;
		if (newMark % n === 0) divisorCount++;
		if (n % newMark === 0) multipleCount++;
	}

	return { divisorCount, multipleCount, anyNumber };
}

/**
 * 前瞻：估计“打出本牌后（mark 变为 newMark），下一步继续行图链的潜力”。
 *
 * 说明：
 * - 只看手牌点数关系（约数/倍数），不做真实合法性模拟
 * - 只做 1 步（少量前瞻），用于在“贪心”评分上做轻量修正
 *
 * @param {*} player
 * @param {*} get
 * @param {*} cardUsed
 * @param {number} newMark
 * @returns {number}
 */
function estimateLookaheadBonus(player, get, cardUsed, newMark, runtime) {
  if (!ENABLE_GREEDY_LOOKAHEAD) return 0;
  const { divisorCount, multipleCount, anyNumber } = getLookaheadCounts(player, get, cardUsed, newMark);
  if (!anyNumber) return -0.08;

  const strategy = runtime?.lookaheadStrategy === "A" || runtime?.lookaheadStrategy === "B"
    ? runtime.lookaheadStrategy
    : "A";

  // 策略权重：
  // - A：更偏向“约数链”（摸牌不断）
  // - B：更偏向“倍数链”（无次数限制爆发）
  const wDiv = strategy === "A" ? 1.0 : 0.65;
  const wMul = strategy === "B" ? 1.0 : 0.65;

  let score = 0;
  if (divisorCount) score += (0.22 + Math.min(0.18, divisorCount * 0.05)) * wDiv;
  if (multipleCount) score += (0.12 + Math.min(0.12, multipleCount * 0.03)) * wMul;
  if (!divisorCount && !multipleCount) score -= 0.18;

  // 新 mark（1/2）通常更容易产生倍数链；B 策略略更吃这个加成
  if (newMark === 1) score += strategy === "B" ? 0.08 : 0.05;
  if (newMark === 2) score += strategy === "B" ? 0.06 : 0.03;

  return score;
}

/**
 * 爵制“选获得的牌”阶段：更偏好能继续行图链的点数。
 *
 * @param {number} num
 * @param {number|null} mark
 * @returns {number}
 */
function scoreJuezhiGainNum(num, mark) {
	if (typeof num !== "number" || Number.isNaN(num)) return 0;
	let delta = 0;
	if (typeof mark === "number" && mark > 0) {
		if (isDivisor(mark, num)) delta += 0.75;
		else if (isMultiple(mark, num)) delta += 0.45;
		else delta -= 0.15;
	} else {
		if ([1, 2, 4, 6, 8, 10].includes(num)) delta += 0.25;
	}
	return delta;
}

/**
 * 行图（xingtu）用牌影响：
 * - 优先约数牌：满足 `上一张点数 % 本张点数 == 0`（摸牌）
 * - 次优倍数牌：满足 `本张点数 % 上一张点数 == 0`（无次数限制）
 *
 * @param {*} ctx
 * @param {*} runtime
 * @param {*} player
 * @param {*} get
 * @param {*} card
 * @param {number} num
 * @param {number|null} mark
 * @returns {void}
 */
function applyXingtuUseBias(ctx, runtime, player, get, card, num, mark) {
	const taggedDivisor = hasGainTag(card, "xingtu2");
	const taggedMultiple = hasGainTag(card, "xingtu1");
	const divisor = taggedDivisor || (typeof mark === "number" ? isDivisor(mark, num) : false);
	const multiple = taggedMultiple || (typeof mark === "number" ? isMultiple(mark, num) : false);

	// 若本次候选中存在“非关键牌”的约数/倍数选择，则对不触发行图的牌加重“断链”惩罚。
	// 目的：减少“明明能用触发行图的牌，却偏去打其他牌（尤其过牌/拆迁）”的情况。
	let hasAltDivisor = false;
	let hasAltMultiple = false;
	try {
		if (typeof mark === "number" && mark > 0 && Array.isArray(ctx?.all)) {
			for (const it of ctx.all) {
				const c = it?.link || it;
				if (!c) continue;
				// 关键保命/功能牌不作为“强制不断链”的依据，避免为了行图去浪费关键牌
				if (isKeyKeepCard(c, get)) continue;
				const n = safeGetNumber(get, c, player);
				if (!n) continue;
				if (hasGainTag(c, "xingtu2") || isDivisor(mark, n)) hasAltDivisor = true;
				else if (hasGainTag(c, "xingtu1") || isMultiple(mark, n)) hasAltMultiple = true;
				if (hasAltDivisor && hasAltMultiple) break;
			}
		}
	} catch (e) {}

	let delta = 0;

	if (divisor) {
		// 若“候选里存在可触发行图的非关键牌”，则更强烈偏好约数不断链（避免拿功能牌硬断链）
		const divisorBonus = runtime.cfg?.divisorBonus ?? DEFAULT_CFG.divisorBonus;
		delta += divisorBonus + (hasAltDivisor ? 0.6 : 0);
	} else if (multiple) {
		// 仅在“有足够把握起爆”时才明显偏向倍数爆发：
		// - 打出后（newMark=num）手牌里至少还有 1 张可继续倍数链，或 newMark 本身足够小（1/2）
		const { multipleCount } = getLookaheadCounts(player, get, card, num);
		const canBurst = num <= 2 || multipleCount >= 1;
		if (canBurst) {
			delta += runtime.cfg?.multipleBonus ?? DEFAULT_CFG.multipleBonus;
			if (num <= 2) {
				delta += runtime.cfg?.smallMarkMultipleExtra ?? DEFAULT_CFG.smallMarkMultipleExtra;
			}
		} else {
			// 不足以起爆：避免过早把行图点数拉到“不好继续”的区间
			delta += 0.08;
		}
	} else if (typeof mark === "number") {
		// 有 mark 但不满足倍数/约数关系时，通常会“断行图收益链”
		const name = safeGetCardName(get, card);
		const isUtility = name === "wuzhong" || name === "shunshou" || name === "guohe";
		const breakPenalty = runtime.cfg?.breakPenalty ?? DEFAULT_CFG.breakPenalty;
		const isCriticalUse = name === "tao" || name === "wuxie";
		if (hasAltDivisor) {
			// 有“可摸牌不断链”的约数牌可用时：强烈惩罚断链（包括过牌/拆迁等）
			if (!isCriticalUse) delta -= breakPenalty + (isUtility ? 1.6 : 1.2);
			else delta -= isUtility ? 0.2 : breakPenalty;
		} else if (hasAltMultiple) {
			// 仅有倍数牌可用：也尽量别用功能牌把点数拉进“难续”的区间
			if (!isCriticalUse) delta -= breakPenalty + (isUtility ? 0.8 : 0.5);
			else delta -= isUtility ? 0.2 : breakPenalty;
		} else {
			// 无替代：仍允许在必要时优先过牌/拆迁等功能牌
			delta -= isUtility ? 0.5 : breakPenalty;
		}
	} else {
		// 无 mark：偏好从大点数/过牌开局（更容易滚动到合适点数）
		if (num >= 10) delta += 0.45;
		if (num === 1 || num === 2) delta += 0.15;
	}

	// 小点装备对裴秀价值很高：更容易过渡并扩容“蓄爆空间”
	if (isEquipCard(get, card, player) && num <= 2) {
		delta += 0.35;
	}

	// A 点作为“中转”通常很强，略微加权
	if (num === 1) delta += 0.18;

	// 保守：避免把“关键保命/关键功能牌”因为点数关系被明显压低
	if (isKeyKeepCard(card, get)) {
		delta -= 0.15;
	}

	// 贪心 + 少量前瞻：偏好“打出该牌后更容易继续行图链”的点数
	delta += estimateLookaheadBonus(player, get, card, num, runtime);
	ctx.score += delta;
}

/**
 * 爵制（juezhi）选牌影响：倾向合成与当前行图点数（mark）有倍数/约数关系的结果点数，
 * 同时尽量不牺牲关键牌、低点装备等“裴秀高价值牌”。
 *
 * 说明：爵制的点数合成规则为 “所选牌点数之和 mod 13（0 视为 13）”。本逻辑主要优化：
 * - 第 1 张牌：是否存在可配对的 2 张组合，使结果点数与 mark 相关
 * - 第 2 张牌：直接判断组合结果点数是否与 mark 相关
 *
 * @param {*} ctx
 * @param {*} runtime
 * @param {*} player
 * @param {*} get
 * @param {number} num
 * @param {number|null} mark
 * @returns {void}
 */
function applyJuezhiPickBias(ctx, runtime, player, get, num, mark) {
	const selected = pickSelectedCards();
	const selectedNums = selected.map((c) => safeGetNumber(get, c, player)).filter((n) => typeof n === "number");
	const selectedSum = selectedNums.reduce((a, b) => a + b, 0);

	// 基于“弃牌价值”的通用影响：越不值钱越更愿意拿去爵制
	const v = safeGetValue(get, ctx.candidate, player);
	let delta = clamp((5 - v) / 10, -0.4, 0.4);

	// 低点装备对裴秀极其关键：强烈避免拿去爵制
	if (isEquipCard(get, ctx.candidate, player) && num <= 2) {
		delta -= 0.75;
	}
	// 关键保命/关键功能牌也尽量避免
	if (isKeyKeepCard(ctx.candidate, get)) {
		delta -= 0.6;
	}

	// 若已选两张以上，尽量别继续加选（除非 base/score 已强烈要求）
	if (selected.length >= 2) {
		delta -= 0.5;
		ctx.score += delta;
		return;
	}

	if (selected.length >= 1) {
		const resultNum = mod13(selectedSum + num);
		delta += scoreJuezhiResultNum(resultNum, mark);
		ctx.score += delta;
		return;
	}

	// 第 1 张牌：看是否存在“可配对”使结果点数与 mark 相关
	const all = pickPlayerHeCards(player);
	let ok = false;
	for (const c of all) {
		if (!c || c === ctx.candidate) continue;
		const n2 = safeGetNumber(get, c, player);
		if (typeof n2 !== "number") continue;
		const resultNum = mod13(num + n2);
		if (isGoodXingtuRelatedNum(resultNum, mark)) {
			ok = true;
			break;
		}
	}
	delta += ok ? 0.6 : -0.25;
	ctx.score += delta;
}

/**
 * @returns {any[]}
 */
function pickSelectedCards() {
	try {
		const ui = globalThis.ui;
		const selected = ui && ui.selected && Array.isArray(ui.selected.cards) ? ui.selected.cards : [];
		return Array.isArray(selected) ? selected : [];
	} catch (e) {
		return [];
	}
}

/**
 * @param {*} player
 * @returns {any[]}
 */
function pickPlayerHeCards(player) {
	try {
		if (player && typeof player.getCards === "function") {
			const cards = player.getCards("he");
			return Array.isArray(cards) ? cards : [];
		}
	} catch (e) {}
	return [];
}

/**
 * 结果点数与行图点数（mark）存在倍数/约数关系即视为“链路友好”。
 *
 * @param {number} resultNum
 * @param {number|null} mark
 * @returns {boolean}
 */
function isGoodXingtuRelatedNum(resultNum, mark) {
	if (typeof resultNum !== "number" || resultNum <= 0) return false;
	if (typeof mark !== "number" || mark <= 0) {
		// 无 mark 时：更偏向裴秀通用高优先级点数（A/2/4/6/8/10）
		return [1, 2, 4, 6, 8, 10].includes(resultNum);
	}
	return isDivisor(mark, resultNum) || isMultiple(mark, resultNum);
}

/**
 * 根据“合成结果点数”对评分做增减。
 *
 * @param {number} resultNum
 * @param {number|null} mark
 * @returns {number}
 */
function scoreJuezhiResultNum(resultNum, mark) {
	let delta = 0;
	if (!isGoodXingtuRelatedNum(resultNum, mark)) return -0.35;
	if (typeof mark === "number" && isDivisor(mark, resultNum)) delta += 0.9; // 约数：摸牌链
	else if (typeof mark === "number" && isMultiple(mark, resultNum)) delta += 0.55; // 倍数：无次数限制
	else delta += 0.35;

	// 通用“好用点数”加权（参考裴秀经验：A/2/4/6/8/10 更常用）
	if ([1, 2].includes(resultNum)) delta += 0.25;
	if ([4, 6, 8, 10].includes(resultNum)) delta += 0.12;
	return delta;
}

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
	if (v < min) return min;
	if (v > max) return max;
	return v;
}
