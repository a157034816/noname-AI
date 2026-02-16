import { isLocalAIPlayer } from "../src/ai_persona/lib/utils.js";
import { guessIdentityFor } from "../src/ai_persona/guess_identity.js";

// 此脚本有点问题
return;

/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 */

/**
 * scripts 插件元信息（用于“scripts 插件管理”UI 友好展示）。
 *
 * 约定：
 * - 插件管理 UI 只读取该对象，不会自动调用入口函数
 * - 建议脚本在模块顶层避免副作用（仅导出函数/常量），把注册逻辑放到入口函数内
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
  name: "队友配合：铁索传导",
  version: "1.1.5",
  description: "基于投花信号进行队友协作：铁索连环 + 属性伤害传导；AI vs AI 场景可自动确认以提高触发率。",
};

/**
 * 默认策略参数（可在脚本内调整）。
 * @type {{enemyHandMin:number,allyAttitudeMin:number,allyHpMin:number,allyGuessShownMin:number,allyGuessConfidenceMin:number,allyAttitudeMinIfGuessedFriendly:number,enemyGuessShownMin:number,enemyGuessConfidenceMin:number,enemyAttitudeMaxIfGuessedEnemy:number,ackWindowMs:number,cooldownMs:number,signalEmotion:string,autoAckInAIVsAI:boolean,autoAckDelayMs:number,enemyDamageEffectMin:number,allyDamageEffectMin:number}}
 */
const DEFAULT_CFG = {
	enemyHandMin: 3,
	allyAttitudeMin: 3,
	allyHpMin: 2,
	allyGuessShownMin: 0.55,
	allyGuessConfidenceMin: 0.35,
	allyAttitudeMinIfGuessedFriendly: -1.2,
	enemyGuessShownMin: 0.65,
	enemyGuessConfidenceMin: 0.35,
	enemyAttitudeMaxIfGuessedEnemy: 1.0,
	ackWindowMs: 12_000,
	cooldownMs: 15_000,
	signalEmotion: "flower",
	autoAckInAIVsAI: true,
	autoAckDelayMs: 300,
	enemyDamageEffectMin: 0.6,
	allyDamageEffectMin: -0.8,
};

/**
 * 调试：一键降低门槛的预设（仅放宽阈值/窗口，不绕过“必须有铁索或已连环”等硬门禁）。
 *
 * @type {Partial<typeof DEFAULT_CFG>}
 */
const DEBUG_PRESET_LOW_CFG = {
	enemyHandMin: 0,
	allyAttitudeMin: 0.5,
	allyHpMin: 1,
	allyGuessShownMin: 0,
	allyGuessConfidenceMin: 0,
	allyAttitudeMinIfGuessedFriendly: -10,
	enemyGuessShownMin: 0,
	enemyGuessConfidenceMin: 0,
	enemyAttitudeMaxIfGuessedEnemy: 99,
	ackWindowMs: 30_000,
	cooldownMs: 1_000,
	enemyDamageEffectMin: -999,
	allyDamageEffectMin: -999,
};

/** @type {string} */
const DEBUG_LOCK_LINK_PATCHED_FLAG_KEY = "__slqjAiChainElementalTeamplayDebugLockLinkPatched";

/** @type {string} */
const DEBUG_LOCK_LINK_ORIGINAL_FN_KEY = "__slqjAiChainElementalTeamplayDebugLockLinkOriginal";

/**
 * @param {*} game
 * @returns {void}
 */
function safeResume(game) {
	if (!game || typeof game.resume !== "function") return;
	try {
		game.resume();
	} catch (e) {}
}

/**
 * @returns {number}
 */
function nowMs() {
	return Date.now();
}

/**
 * 为缺少稳定字段的 player 提供“进程内唯一”的兜底 key（避免 stateByAi 冲突）。
 *
 * @type {WeakMap<object, string>}
 */
const PLAYER_KEY_FALLBACK = new WeakMap();

/** @type {number} */
let playerKeySeq = 1;

/**
 * 获取玩家稳定 key（用于 runtime.stateByAi 记录）。
 *
 * @param {*} player
 * @returns {string}
 */
function getPlayerKey(player) {
	if (!player) return "";
	// 注意：playerid 可能为 0（falsy），因此必须用 != null 判断
	if (player.playerid != null) return String(player.playerid);
	if (player.playerId != null) return String(player.playerId);
	if (player.id != null) return String(player.id);
	if (player.dataset && player.dataset.position != null) return `pos:${String(player.dataset.position)}`;
	if (player.name) return `name:${String(player.name)}`;
	if (typeof player === "object") {
		const existing = PLAYER_KEY_FALLBACK.get(player);
		if (existing) return existing;
		const gen = `obj:${playerKeySeq++}`;
		PLAYER_KEY_FALLBACK.set(player, gen);
		return gen;
	}
	return "";
}

/**
 * @param {*} player
 * @returns {boolean}
 */
function isAlive(player) {
	if (!player) return false;
	if (player.dead) return false;
	if (typeof player.isAlive === "function") {
		try {
			return !!player.isAlive();
		} catch (e) {}
	}
	return true;
}

/**
 * 安全获取态度（异常时回退 0）。
 *
 * @param {*} get
 * @param {*} from
 * @param {*} to
 * @returns {number}
 */
function safeAttitude(get, from, to) {
	if (!get || typeof get.attitude !== "function") return 0;
	try {
		return Number(get.attitude(from, to)) || 0;
	} catch (e) {
		return 0;
	}
}

/**
 * @param {*} get
 * @returns {boolean}
 */
function isIdentityMode(get) {
	if (!get || typeof get.mode !== "function") return false;
	try {
		return String(get.mode()) === "identity";
	} catch (e) {
		return false;
	}
}

/**
 * 安全获取“软暴露”值（target.ai.shown）。
 *
 * @param {*} target
 * @returns {number}
 */
function getShownValue(target) {
	if (!target) return 0;
	const raw = target.ai && typeof target.ai.shown === "number" ? target.ai.shown : 0;
	const n = Number(raw);
	if (Number.isNaN(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

/**
 * 安全猜测目标身份（身份局）。
 *
 * @param {*} observer
 * @param {*} target
 * @param {*} game
 * @returns {{identity:string,confidence:number}}
 */
function safeGuessIdentityFor(observer, target, game) {
	try {
		const r = guessIdentityFor(observer, target, game);
		const identity = String(r?.identity || "unknown");
		const confRaw = typeof r?.confidence === "number" ? r.confidence : 0;
		const conf = Number(confRaw);
		return { identity, confidence: Number.isNaN(conf) ? 0 : Math.max(0, Math.min(1, conf)) };
	} catch (e) {
		return { identity: "unknown", confidence: 0 };
	}
}

/**
 * @param {string} identity
 * @returns {boolean}
 */
function isZhuSideIdentity(identity) {
	const id = String(identity || "");
	return ["zhu", "zhong", "mingzhong"].includes(id);
}

/**
 * @param {*} selfIdentity
 * @param {*} guessedIdentity
 * @returns {boolean}
 */
function isGuessedFriendlyIdentity(selfIdentity, guessedIdentity) {
	const selfId = String(selfIdentity || "");
	const gid = String(guessedIdentity || "");
	if (isZhuSideIdentity(selfId)) return isZhuSideIdentity(gid);
	if (selfId === "fan") return gid === "fan";
	return false;
}

/**
 * @param {*} selfIdentity
 * @param {*} guessedIdentity
 * @returns {boolean}
 */
function isGuessedEnemyIdentity(selfIdentity, guessedIdentity) {
	const selfId = String(selfIdentity || "");
	const gid = String(guessedIdentity || "");
	if (isZhuSideIdentity(selfId)) return gid === "fan";
	if (selfId === "fan") return isZhuSideIdentity(gid);
	// 内奸不做阵营硬判定：更保守，避免在身份未明置时贸然下延时
	if (selfId === "nei") return false;
	return false;
}

/**
 * @param {*} player
 * @returns {number}
 */
function handCount(player) {
	if (!player) return 0;
	if (typeof player.countCards === "function") {
		try {
			return Number(player.countCards("h")) || 0;
		} catch (e) {}
	}
	if (typeof player.getCards === "function") {
		try {
			const cards = player.getCards("h");
			return Array.isArray(cards) ? cards.length : 0;
		} catch (e) {}
	}
	return 0;
}

/**
 * 在手牌中查找满足条件的第一张牌。
 *
 * @param {*} player
 * @param {(card:any)=>boolean} pred
 * @returns {*|null}
 */
function findHandCard(player, pred) {
	if (!player || typeof player.getCards !== "function") return null;
	let cards = [];
	try {
		cards = player.getCards("h") || [];
	} catch (e) {
		cards = [];
	}
	for (const c of cards) {
		try {
			if (pred(c)) return c;
		} catch (e) {}
	}
	return null;
}

/**
 * 判断是否为“属性杀”（sha 且 nature 非空）。
 *
 * @param {*} card
 * @returns {boolean}
 */
function isElementalSha(card) {
	if (!card) return false;
	if (String(card.name || "") !== "sha") return false;
	const nature = card.nature;
	if (Array.isArray(nature)) return nature.length > 0;
	return String(nature || "").trim().length > 0;
}

/**
 * 轻量 sleep（用于 AI vs AI 自动确认时的短延迟）。
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleepMs(ms) {
	const n = Number(ms);
	if (!(n > 0)) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, n));
}

/**
 * 安全读取牌的属性（nature）：优先 get.nature(card)，其次 card.nature。
 *
 * @param {*} get
 * @param {*} card
 * @returns {*}
 */
function safeGetCardNature(get, card) {
	if (!card) return "";
	try {
		if (get && typeof get.nature === "function") {
			const n = get.nature(card);
			if (Array.isArray(n)) return n;
			const s = String(n || "").trim();
			if (s) return s;
		}
	} catch (e) {}

	try {
		const raw = card.nature;
		if (Array.isArray(raw)) return raw;
		return String(raw || "").trim();
	} catch (e) {}
	return "";
}

/**
 * @param {*} nature
 * @returns {boolean}
 */
function hasNature(nature) {
	if (Array.isArray(nature)) return nature.length > 0;
	return String(nature || "").trim().length > 0;
}

/**
 * @param {*} nature
 * @returns {boolean}
 */
function natureHasFire(nature) {
	if (Array.isArray(nature)) return nature.some((n) => String(n || "").includes("fire"));
	return String(nature || "").includes("fire");
}

/**
 * 判断玩家是否装备了指定名称的装备牌。
 *
 * @param {*} player
 * @param {string} equipName
 * @returns {boolean}
 */
function hasEquipByName(player, equipName) {
	if (!player || !equipName) return false;
	if (typeof player.getCards === "function") {
		try {
			const es = player.getCards("e") || [];
			return Array.isArray(es) && es.some((c) => String(c?.name || "") === equipName);
		} catch (e) {}
	}
	return false;
}

/**
 * 挑选“连招用”的杀与其属性（nature）。
 *
 * 规则：
 * - 优先：手牌中的属性杀（sha 且 nature 非空）
 * - 其次：若装备【朱雀羽扇】(zhuque)，允许普通杀视为 fire（用于提高识别与触发率）
 *
 * @param {*} player
 * @param {*} get
 * @returns {{sha:any,nature:any}|null}
 */
function pickShaPlan(player, get) {
	if (!player) return null;

	const elemental = findHandCard(player, (c) => {
		if (String(c?.name || "") !== "sha") return false;
		return hasNature(safeGetCardNature(get, c));
	});
	if (elemental) return { sha: elemental, nature: safeGetCardNature(get, elemental) };

	if (hasEquipByName(player, "zhuque")) {
		const normal = findHandCard(player, (c) => String(c?.name || "") === "sha");
		if (normal) return { sha: normal, nature: "fire" };
	}

	return null;
}

/**
 * 安全计算属性伤害收益（正=对 viewer 有利，负=不利）。
 *
 * @param {*} get
 * @param {*} target
 * @param {*} source
 * @param {*} viewer
 * @param {*} nature
 * @returns {number}
 */
function safeDamageEffect(get, target, source, viewer, nature) {
	if (!get || typeof get.damageEffect !== "function") return 0;
	try {
		return Number(get.damageEffect(target, source, viewer, nature)) || 0;
	} catch (e) {
		return 0;
	}
}

/**
 * @param {*} player
 * @returns {boolean}
 */
function isUnderHumanControl(player) {
	if (!player || typeof player.isUnderControl !== "function") return false;
	try {
		return !!player.isUnderControl(true);
	} catch (e) {
		return false;
	}
}

/**
 * 判断 from 是否能对 to 使用杀（尽量兼容不同引擎版本）。
 *
 * @param {*} from
 * @param {*} to
 * @returns {boolean}
 */
function canAttackBySha(from, to) {
	if (!from || !to) return false;
	if (typeof from.canUse === "function") {
		try {
			return !!from.canUse({ name: "sha" }, to);
		} catch (e) {}
	}
	if (typeof from.inRange === "function") {
		try {
			return !!from.inRange(to);
		} catch (e) {}
	}
	return false;
}

/**
 * @param {*} player
 * @returns {boolean}
 */
function isLinked(player) {
	if (!player) return false;
	if (typeof player.isLinked === "function") {
		try {
			return !!player.isLinked();
		} catch (e) {}
	}
	if (player.classList && typeof player.classList.contains === "function") {
		try {
			return player.classList.contains("linked");
		} catch (e) {}
	}
	return false;
}

/**
 * 获取或创建该脚本的运行时状态（挂载在 game.__slqjAiPersona 上）。
 *
 * @param {*} game
 * @returns {{cfg:any,stateByAi:Record<string,any>,api?:any}|null}
 */
function getOrCreateRuntime(game) {
	if (!game) return null;
	if (!game.__slqjAiPersona || typeof game.__slqjAiPersona !== "object") game.__slqjAiPersona = {};
	game.__slqjAiPersona.chainElementalTeamplay ??= {
		cfg: { ...DEFAULT_CFG },
		stateByAi: Object.create(null),
	};
	return game.__slqjAiPersona.chainElementalTeamplay;
}

/**
 * 获取或创建该脚本的调试对象（挂载在 runtime.debug 上）。
 *
 * @param {*} runtime
 * @returns {{lastPhaseUseBegin: Record<string, any>}|null}
 */
function ensureRuntimeDebug(runtime) {
	if (!runtime) return null;
	if (!runtime.debug || typeof runtime.debug !== "object") runtime.debug = Object.create(null);
	if (!runtime.debug.lastPhaseUseBegin || typeof runtime.debug.lastPhaseUseBegin !== "object") {
		runtime.debug.lastPhaseUseBegin = Object.create(null);
	}
	return runtime.debug;
}

/**
 * 获取当前 runtime.cfg 的快照（避免外部直接修改引用）。
 *
 * @param {*} runtime
 * @returns {Record<string, any>}
 */
function snapshotRuntimeCfg(runtime) {
	const cfg = runtime && runtime.cfg && typeof runtime.cfg === "object" ? runtime.cfg : null;
	if (!cfg) return {};
	try {
		return { ...cfg };
	} catch (e) {
		return {};
	}
}

/**
 * 将 preset 合并到 runtime.cfg（仅覆盖 DEFAULT_CFG 中存在且类型一致的字段）。
 *
 * @param {*} runtime
 * @param {Record<string, any>} preset
 * @returns {Record<string, any>} 合并后的 cfg 快照
 */
function applyCfgPresetToRuntime(runtime, preset) {
	if (!runtime) return {};

	if (!runtime.cfg || typeof runtime.cfg !== "object") runtime.cfg = { ...DEFAULT_CFG };
	const cfg = runtime.cfg;
	const patch = preset && typeof preset === "object" ? preset : null;
	if (!patch) return snapshotRuntimeCfg(runtime);

	for (const [k, v] of Object.entries(patch)) {
		if (!Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) continue;
		const expectedType = typeof DEFAULT_CFG[k];
		if (typeof v !== expectedType) continue;
		if (expectedType === "number" && !Number.isFinite(v)) continue;
		cfg[k] = v;
	}

	return snapshotRuntimeCfg(runtime);
}

/**
 * @returns {boolean}
 */
function isDebugLockAllLinkedEnabled() {
	try {
		const g = typeof game !== "undefined" ? game : globalThis.game;
		return !!g?.__slqjAiPersona?.chainElementalTeamplay?.debug?.lockAllLinkedEnabled;
	} catch (e) {
		return false;
	}
}

/**
 * @param {*} game
 * @returns {any[]}
 */
function listAllPlayers(game) {
	const res = [];
	const ps = game && game.players;
	const ds = game && game.dead;
	if (Array.isArray(ps)) res.push(...ps);
	if (Array.isArray(ds)) res.push(...ds);
	return res;
}

/**
 * @param {*} player
 * @returns {boolean}
 */
function patchPlayerLinkForDebugLock(player) {
	if (!player || typeof player !== "object") return false;
	if (player[DEBUG_LOCK_LINK_PATCHED_FLAG_KEY]) return true;
	if (typeof player.link !== "function") return false;

	const original = player.link;
	player[DEBUG_LOCK_LINK_ORIGINAL_FN_KEY] = original;
	player[DEBUG_LOCK_LINK_PATCHED_FLAG_KEY] = true;

	/**
	 * @param {boolean=} bool
	 * @returns {*}
	 */
	player.link = function (bool) {
		let nextBool = bool;
		if (isDebugLockAllLinkedEnabled()) {
			if (typeof nextBool !== "boolean" || nextBool === false) nextBool = true;
		}
		return original.call(this, nextBool);
	};

	return true;
}

/**
 * @param {*} player
 * @returns {boolean}
 */
function unpatchPlayerLinkForDebugLock(player) {
	if (!player || typeof player !== "object") return false;
	if (!player[DEBUG_LOCK_LINK_PATCHED_FLAG_KEY]) return false;
	const original = player[DEBUG_LOCK_LINK_ORIGINAL_FN_KEY];
	if (typeof original === "function") {
		try {
			player.link = original;
		} catch (e) {}
	}
	try {
		delete player[DEBUG_LOCK_LINK_ORIGINAL_FN_KEY];
	} catch (e) {}
	try {
		delete player[DEBUG_LOCK_LINK_PATCHED_FLAG_KEY];
	} catch (e) {}
	return true;
}

/**
 * @param {*} game
 * @returns {void}
 */
function patchAllPlayersLinkForDebugLock(game) {
	for (const p of listAllPlayers(game)) patchPlayerLinkForDebugLock(p);
}

/**
 * @param {*} game
 * @returns {void}
 */
function unpatchAllPlayersLinkForDebugLock(game) {
	for (const p of listAllPlayers(game)) unpatchPlayerLinkForDebugLock(p);
}

/**
 * @param {*} game
 * @returns {number} 成功设为连环的存活玩家数
 */
function forceAllAlivePlayersLinked(game) {
	const players = (game && game.players) || [];
	if (!Array.isArray(players)) return 0;
	let n = 0;
	for (const p of players) {
		if (!isAlive(p)) continue;
		try {
			if (typeof p.link === "function") {
				p.link(true);
				n++;
				continue;
			}
		} catch (e) {}

		try {
			// 兜底：仅设置样式态（多数逻辑通过 isLinked/classList 判断）
			if (p.classList && typeof p.classList.add === "function") {
				p.classList.add("linked");
				n++;
			}
		} catch (e) {}
	}
	return n;
}

/**
 * 为“技能执行环境”准备可调用的 API。
 *
 * 说明：无名杀的 `lib.skill.*.content/filter` 可能在隔离/重建的执行环境运行，
 * 无法访问本模块内的局部函数（会出现 `ReferenceError: xxx is not defined`）。
 * 因此把需要调用的函数对象挂载到 `game.__slqjAiPersona.chainElementalTeamplay.api` 上，
 * 让 skill 侧通过 `game` 全局对象间接调用，避免丢失闭包。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {object|null}
 */
function installRuntimeApi(ctx) {
	const { game, get, _status } = ctx || {};
	if (!game) return null;

	const runtime = getOrCreateRuntime(game);
	if (!runtime) return null;

	if (!runtime.api || typeof runtime.api !== "object") runtime.api = Object.create(null);

	runtime.api.filterPhaseUseBegin = (event, player) => {
		let ok = false;
		let connectMode = false;
		let isMe = false;
		let isOnlineFn = false;
		let isOnline = null;

		try {
			connectMode = !!(_status && _status.connectMode);
		} catch (e) {
			connectMode = false;
		}

		try {
			isMe = !!player && !!game && player === game.me;
		} catch (e) {
			isMe = false;
		}

		try {
			isOnlineFn = !!player && typeof player.isOnline === "function";
		} catch (e) {
			isOnlineFn = false;
		}

		try {
			isOnline = isOnlineFn ? !!player.isOnline() : null;
		} catch (e) {
			isOnline = null;
		}

		try {
			ok = isLocalAIPlayer(player, game, _status);
		} catch (e) {
			ok = false;
		}

		// 调试记录：若出现“完全不触发”，可通过 DebugGetLast() 看 filter 是否被门禁挡住
		try {
			const rt = getOrCreateRuntime(game);
			const dbg = ensureRuntimeDebug(rt);
			const key = getPlayerKey(player);
			if (dbg && key) {
				const prev =
					dbg.lastPhaseUseBegin[key] && typeof dbg.lastPhaseUseBegin[key] === "object"
						? dbg.lastPhaseUseBegin[key]
						: null;
				dbg.lastPhaseUseBegin[key] = {
					...(prev || {}),
					ts: nowMs(),
					step: "filter",
					reason: ok ? "pass" : "block",
					aiKey: key,
					isMe,
					connectMode,
					isOnlineFn,
					isOnline,
				};
			}
		} catch (e) {}

		return ok;
	};

	runtime.api.onPhaseUseBegin = async (player) => {
		const rt = getOrCreateRuntime(game);
		if (!rt || !player) return;

		const aiKey = getPlayerKey(player);
		const dbg = ensureRuntimeDebug(rt);
		const identityMode = isIdentityMode(get);
		const selfIdentity = String(player.identity || "");

		/**
		 * 记录本回合“为何未投花/投花给谁”的决策痕迹，便于排查不触发原因。
		 *
		 * @param {string} step
		 * @param {string} reason
		 * @param {Record<string, any>=} extra
		 * @returns {void}
		 */
		function writeDebug(step, reason, extra) {
			if (!dbg || !aiKey) return;
			const cfg = rt.cfg || DEFAULT_CFG;
			const prev = dbg.lastPhaseUseBegin[aiKey] && typeof dbg.lastPhaseUseBegin[aiKey] === "object" ? dbg.lastPhaseUseBegin[aiKey] : null;
			dbg.lastPhaseUseBegin[aiKey] = {
				...(prev || {}),
				ts: nowMs(),
				step: String(step || ""),
				reason: String(reason || ""),
				aiKey,
				selfIdentity,
				identityMode,
				cfg: {
					enemyHandMin: cfg.enemyHandMin,
					allyAttitudeMin: cfg.allyAttitudeMin,
					allyHpMin: cfg.allyHpMin,
					allyGuessShownMin: cfg.allyGuessShownMin,
					allyGuessConfidenceMin: cfg.allyGuessConfidenceMin,
					allyAttitudeMinIfGuessedFriendly: cfg.allyAttitudeMinIfGuessedFriendly,
					enemyGuessShownMin: cfg.enemyGuessShownMin,
					enemyGuessConfidenceMin: cfg.enemyGuessConfidenceMin,
					enemyAttitudeMaxIfGuessedEnemy: cfg.enemyAttitudeMaxIfGuessedEnemy,
					ackWindowMs: cfg.ackWindowMs,
					cooldownMs: cfg.cooldownMs,
					signalEmotion: cfg.signalEmotion,
					enemyDamageEffectMin: cfg.enemyDamageEffectMin,
					allyDamageEffectMin: cfg.allyDamageEffectMin,
				},
				...(extra || {}),
			};
		}

		// 若已有“已确认”的配合请求，优先尝试在出牌阶段执行连招
		if (tryExecuteCombo(rt, player, game, get)) {
			writeDebug("combo", "executed");
			return;
		}

		// 身份局：内奸不启用该“打队友传导”策略（风险过高）
		if (identityMode && selfIdentity === "nei") {
			writeDebug("skip", "nei");
			return;
		}

		// 若没有可用的属性伤害来源（属性杀 / 朱雀转火），直接跳过
		const shaPlan = pickShaPlan(player, get);
		if (!shaPlan) {
			writeDebug("gate", "noShaPlan");
			return;
		}

		const tiesuo = findHandCard(player, (c) => String(c?.name || "") === "tiesuo");

		const pickDebug = Object.create(null);
		const enemy = pickEnemy(player, game, get, rt.cfg, shaPlan.nature, pickDebug);
		if (!enemy) {
			writeDebug("gate", "noEnemy", { hasShaPlan: true, hasTiesuo: !!tiesuo, ...pickDebug });
			return;
		}
		const enemyEff = safeDamageEffect(get, enemy, player, player, shaPlan.nature);

		const ally = pickAlly(player, game, get, rt.cfg, enemy, shaPlan.nature, enemyEff, pickDebug);
		if (!ally) {
			writeDebug("gate", "noAlly", {
				hasShaPlan: true,
				hasTiesuo: !!tiesuo,
				pickedEnemyKey: getPlayerKey(enemy) || null,
				enemyEff,
				...pickDebug,
			});
			return;
		}

		// 无铁索且双方未处于连环：无法保证“传导”成立，跳过（避免误伤队友）
		if (!tiesuo && !(isLinked(ally) && isLinked(enemy))) {
			writeDebug("gate", "noTiesuoNoLink", {
				hasShaPlan: true,
				hasTiesuo: false,
				pickedEnemyKey: getPlayerKey(enemy) || null,
				pickedAllyKey: getPlayerKey(ally) || null,
				...pickDebug,
			});
			return;
		}

		const sendDebug = Object.create(null);
		const sent = trySendSignal(rt, player, ally, enemy, sendDebug);
		if (!sent) {
			writeDebug("send", "failed", {
				hasShaPlan: true,
				hasTiesuo: !!tiesuo,
				pickedEnemyKey: getPlayerKey(enemy) || null,
				pickedAllyKey: getPlayerKey(ally) || null,
				enemyEff,
				...pickDebug,
				...sendDebug,
			});
			return;
		}

		writeDebug("send", "ok", {
			hasShaPlan: true,
			hasTiesuo: !!tiesuo,
			pickedEnemyKey: getPlayerKey(enemy) || null,
			pickedAllyKey: getPlayerKey(ally) || null,
			enemyEff,
			...pickDebug,
			...sendDebug,
		});

		// AI vs AI：自动确认（避免无人回投 flower 导致“永远不执行”）
		const st0 = rt.stateByAi[aiKey];
		const shouldAutoAck =
			!!rt.cfg.autoAckInAIVsAI &&
			st0 &&
			st0.phase === "signaled" &&
			!st0.canceled &&
			isLocalAIPlayer(ally, game, _status) &&
			!isUnderHumanControl(ally);

		if (shouldAutoAck) {
			writeDebug("autoAck", "aivsaI");
			st0.noWait = true;
			await sleepMs(rt.cfg.autoAckDelayMs);

			// 尝试“模拟回投鲜花”以可视化确认（同时触发 acceptSignalIfMatch 的常规链路）。
			// 若模拟失败/未能推进状态，则回退为直接 accepted（确保 AI vs AI 不会卡死在无人回投）。
			try {
				const st = rt.stateByAi[aiKey];
				if (st && st.phase === "signaled") {
					if (!st.canceled && !(st.expiresAtMs && nowMs() > st.expiresAtMs)) {
						if (typeof ally.throwEmotion === "function") {
							ally.throwEmotion(player, rt.cfg.signalEmotion);
						}
					}
				}
			} catch (e) {}

			const st2 = rt.stateByAi[aiKey];
			if (st2 && st2.phase === "signaled") {
				if (!st2.canceled && !(st2.expiresAtMs && nowMs() > st2.expiresAtMs)) {
					st2.phase = "accepted";
					st2.ackAtMs = nowMs();
				}
			}

			tryExecuteCombo(rt, player, game, get);
			return;
		}

		// “完全等待”：暂停出牌阶段，直到队友回投确认或超时（允许通过 hook ctx 指定本次不等待）
		if (aiKey) {
			const st = rt.stateByAi[aiKey];
			if (st && st.phase === "signaled" && !st.noWait && !st.canceled) {
				writeDebug("wait", "pause");
				await waitForAckOrTimeout(rt, aiKey, game);
			}
		}

		// 等待结束后若已确认，则立即执行连招（仍需处于出牌阶段）
		tryExecuteCombo(rt, player, game, get);
	};

	return runtime.api;
}

/**
 * 清理某个 AI 的状态。
 *
 * @param {*} runtime
 * @param {string} aiKey
 * @returns {void}
 */
function clearState(runtime, aiKey) {
	if (!runtime || !aiKey) return;
	delete runtime.stateByAi[aiKey];
}

/**
 * 结束一次“队友配合”状态，并尽量保留冷却信息避免刷屏。
 *
 * @param {*} runtime
 * @param {string} aiKey
 * @param {*} [st]
 * @returns {void}
 */
function finalizeToCooldown(runtime, aiKey, st) {
	if (!runtime || !aiKey) return;
	const now = nowMs();
	const until = Math.max(now, Number(st?.cooldownUntilMs) || 0);
	if (until > now) {
		runtime.stateByAi[aiKey] = {
			phase: "cooldown",
			aiKey,
			cooldownUntilMs: until,
		};
	} else {
		clearState(runtime, aiKey);
	}
}

/**
 * 选择敌方目标（手牌多且态度敌对）。
 *
 * @param {*} aiPlayer
 * @param {*} game
 * @param {*} get
 * @param {*} cfg
 * @param {*} nature
 * @param {Record<string, any>=} debugOut
 * @returns {*|null}
 */
function pickEnemy(aiPlayer, game, get, cfg, nature, debugOut) {
	const players = (game && game.players) || [];
	let best = null;
	let bestScore = -Infinity;
	let bestKind = "";
	let candidates = 0;

	const canEval = !!get && typeof get.damageEffect === "function";
	const identityMode = isIdentityMode(get);
	const selfId = String(aiPlayer?.identity || "");
	const allowGuess = identityMode && selfId !== "nei";

	for (const p of players) {
		if (!isAlive(p)) continue;
		if (p === aiPlayer) continue;
		const att = safeAttitude(get, aiPlayer, p);
		/** @type {"attitude"|"guess"|"soft"|""} */
		let kind = "";
		const hc0 = handCount(p);

		// 1) 明确敌对：直接作为敌方候选
		if (att < -1) {
			kind = "attitude";
		}
		// 2) 身份局未明置：允许“猜测敌方/软候选”兜底（提高投花触发率）
		else if (allowGuess && !p.identityShown) {
			const shown = getShownValue(p);
			const g = safeGuessIdentityFor(aiPlayer, p, game);

			const isFriendlyHigh = isGuessedFriendlyIdentity(selfId, g.identity) && g.confidence >= 0.45;
			const canGuessEnemy =
				shown >= cfg.enemyGuessShownMin &&
				isGuessedEnemyIdentity(selfId, g.identity) &&
				g.confidence >= cfg.enemyGuessConfidenceMin &&
				att <= cfg.enemyAttitudeMaxIfGuessedEnemy;

			if (canGuessEnemy) {
				kind = "guess";
			} else {
				// 软候选：手牌更厚 + shown 不低 + 态度非明显友方，且不能“高置信友方”
				if (hc0 < cfg.enemyHandMin + 1) continue;
				if (shown < 0.5) continue;
				if (att > 0.8) continue;
				if (isFriendlyHigh) continue;
				kind = "soft";
			}
		} else {
			continue;
		}

		const hc = handCount(p);
		if (hc < cfg.enemyHandMin) continue;

		const eff = canEval ? safeDamageEffect(get, p, aiPlayer, aiPlayer, nature) : 0;
		if (canEval && eff < cfg.enemyDamageEffectMin) continue;

		let score = hc + (-att) * 0.25 + eff * 0.5;
		if (kind === "guess") score *= 0.9;
		if (kind === "soft") score *= 0.85;
		candidates++;
		if (score > bestScore) {
			bestScore = score;
			best = p;
			bestKind = kind;
		}
	}

	if (debugOut) {
		debugOut.enemyCandidates = candidates;
		debugOut.enemyPickKind = bestKind || null;
		debugOut.pickedEnemyKey = best ? getPlayerKey(best) : null;
	}
	return best;
}

/**
 * 选择配合队友（在杀范围内、态度高、血量不低）。
 *
 * @param {*} aiPlayer
 * @param {*} game
 * @param {*} get
 * @param {*} cfg
 * @param {*} enemy
 * @param {*} nature
 * @param {number} enemyEff
 * @param {Record<string, any>=} debugOut
 * @returns {*|null}
 */
function pickAlly(aiPlayer, game, get, cfg, enemy, nature, enemyEff, debugOut) {
	const players = (game && game.players) || [];
	let best = null;
	let bestScore = -Infinity;
	let bestKind = "";
	let candidates = 0;

	const canEval = !!get && typeof get.damageEffect === "function";
	const identityMode = isIdentityMode(get);
	const selfId = String(aiPlayer?.identity || "");
	const allowGuess = identityMode && selfId !== "nei";

	for (const p of players) {
		if (!isAlive(p)) continue;
		if (p === aiPlayer) continue;
		if (p === enemy) continue;
		if (!canAttackBySha(aiPlayer, p)) continue;
		if ((p.hp || 0) < cfg.allyHpMin) continue;

		const att = safeAttitude(get, aiPlayer, p);
		/** @type {"attitude"|"guess"|"soft"|""} */
		let kind = "";

		// 1) 明确友方：直接作为队友候选
		if (att >= cfg.allyAttitudeMin) {
			kind = "attitude";
		}
		// 2) 身份局未明置：允许“猜测友方/软候选”兜底（提高投花触发率）
		else if (allowGuess && !p.identityShown) {
			const shown = getShownValue(p);
			const g = safeGuessIdentityFor(aiPlayer, p, game);

			const isEnemyHigh = isGuessedEnemyIdentity(selfId, g.identity) && g.confidence >= 0.45;
			const canGuessFriendly =
				shown >= cfg.allyGuessShownMin &&
				isGuessedFriendlyIdentity(selfId, g.identity) &&
				g.confidence >= cfg.allyGuessConfidenceMin &&
				att >= cfg.allyAttitudeMinIfGuessedFriendly;

			if (canGuessFriendly) {
				kind = "guess";
			} else {
				// 软候选：shown 不低 + 态度略正，且不能“高置信敌方”
				if (shown < 0.5) continue;
				if (att < 0.5) continue;
				if (isEnemyHigh) continue;
				kind = "soft";
			}
		} else {
			continue;
		}

		// 火属性伤害避免打藤甲队友（常见“误伤扩大”场景）
		if (natureHasFire(nature) && hasEquipByName(p, "tengjia")) continue;

		const allyEff = canEval ? safeDamageEffect(get, p, aiPlayer, aiPlayer, nature) : 0;
		if (canEval && Number(enemyEff) + allyEff < cfg.allyDamageEffectMin) continue;

		let score = att + (p.hp || 0) * 0.25 + allyEff * 0.05;
		if (kind === "guess") score -= 0.75;
		if (kind === "soft") score -= 1.0;
		candidates++;
		if (score > bestScore) {
			bestScore = score;
			best = p;
			bestKind = kind;
		}
	}

	if (debugOut) {
		debugOut.allyCandidates = candidates;
		debugOut.allyPickKind = bestKind || null;
		debugOut.pickedAllyKey = best ? getPlayerKey(best) : null;
	}
	return best;
}

/**
 * 给队友发送“确认请求”信号（默认：投掷 flower）。
 *
 * @param {*} runtime
 * @param {*} aiPlayer
 * @param {*} ally
 * @param {*} enemy
 * @param {Record<string, any>=} debugOut
 * @returns {boolean}
 */
function trySendSignal(runtime, aiPlayer, ally, enemy, debugOut) {
	if (!runtime || !aiPlayer || !ally || !enemy) {
		if (debugOut) debugOut.sendReason = "bad_args";
		return false;
	}
	const aiKey = getPlayerKey(aiPlayer);
	if (!aiKey) {
		if (debugOut) debugOut.sendReason = "no_ai_key";
		return false;
	}

	const existing = runtime.stateByAi[aiKey];
	const now = nowMs();
	if (existing) {
		if (existing.cooldownUntilMs && now < existing.cooldownUntilMs) {
			if (debugOut) debugOut.sendReason = "cooldown";
			return false;
		}
		if (existing.phase === "signaled" && existing.expiresAtMs && now < existing.expiresAtMs) {
			if (debugOut) debugOut.sendReason = "already_signaled";
			return false;
		}
		if (existing.phase === "accepted" && existing.expiresAtMs && now < existing.expiresAtMs) {
			if (debugOut) debugOut.sendReason = "already_accepted";
			return false;
		}
	}

	// 先写入状态，再发起投掷：这样 hooks 侧可以在 `slqj_ai_emotion_throw` 的 ctx 上设置约定字段影响本次行为
	const st = {
		phase: "signaled",
		aiKey,
		allyKey: getPlayerKey(ally),
		enemyKey: getPlayerKey(enemy),
		sentAtMs: now,
		expiresAtMs: now + runtime.cfg.ackWindowMs,
		cooldownUntilMs: now + runtime.cfg.cooldownMs,
		waiting: false,
		waitResumeTimerId: null,
		pendingSignal: true,
		noWait: false,
		canceled: false,
	};
	runtime.stateByAi[aiKey] = st;

	if (typeof aiPlayer.throwEmotion === "function") {
		try {
			aiPlayer.throwEmotion(ally, runtime.cfg.signalEmotion);
		} catch (e) {
			if (debugOut) {
				debugOut.sendReason = "throw_emotion_failed";
				debugOut.sendError = String(e?.message || e || "unknown");
			}
			finalizeToCooldown(runtime, aiKey, st);
			return false;
		}
	} else {
		if (debugOut) debugOut.sendReason = "no_throw_emotion";
		finalizeToCooldown(runtime, aiKey, st);
		return false;
	}

	st.pendingSignal = false;
	if (st.canceled) {
		if (debugOut) debugOut.sendReason = "canceled";
		finalizeToCooldown(runtime, aiKey, st);
		return false;
	}
	if (debugOut) debugOut.sendReason = "ok";
	return true;
}

/**
 * 在 AI 的出牌阶段内“完全等待”队友回投确认信号：
 * - 等待期间暂停 game.loop（允许队友操作 UI 回投鲜花）
 * - 若队友回投（state 变为 accepted）则立即恢复
 * - 若超时则自动恢复并进入冷却
 *
 * @param {*} runtime
 * @param {string} aiKey
 * @param {*} game
 * @returns {Promise<void>}
 */
async function waitForAckOrTimeout(runtime, aiKey, game) {
	if (!runtime || !aiKey || !game) return;
	const st = runtime.stateByAi[aiKey];
	if (!st || st.phase !== "signaled") return;
	if (st.noWait || st.canceled) return;

	const now = nowMs();
	const remaining = Number(st.expiresAtMs) - now;
	if (!(remaining > 0)) {
		finalizeToCooldown(runtime, aiKey, st);
		return;
	}

	// 仅允许同一轮请求触发一次等待，避免重复 pause
	if (st.waiting) return;
	st.waiting = true;

	/** @type {any} */
	let timerId = null;
	try {
		timerId = setTimeout(() => {
			try {
				st.waitResumeTimerId = null;
			} catch (e) {}
			safeResume(game);
		}, remaining);
		st.waitResumeTimerId = timerId;
	} catch (e) {
		timerId = null;
	}

	try {
		if (typeof game.pause === "function") {
			await game.pause();
		} else {
			// 兜底：即便没有 pause，也尽量用 async 延迟给队友操作窗口
			await new Promise((r) => setTimeout(r, Math.max(0, remaining)));
		}
	} catch (e) {
		// ignore
	} finally {
		st.waiting = false;
		try {
			if (timerId != null) clearTimeout(timerId);
		} catch (e) {}
		try {
			st.waitResumeTimerId = null;
		} catch (e) {}
	}

	// 等待结束后若仍未确认，则进入冷却（避免反复请求导致“卡住/刷屏”）
	const st2 = runtime.stateByAi[aiKey];
	if (st2 && st2.phase === "signaled") {
		if (st2.expiresAtMs && nowMs() > st2.expiresAtMs) finalizeToCooldown(runtime, aiKey, st2);
	}
}

/**
 * 如果 ctx 符合“队友回投确认信号”的条件，则将对应 AI 状态推进为 accepted。
 *
 * @param {*} runtime
 * @param {*} ctx
 * @returns {string|null} 返回 aiKey（用于后续执行连招）
 */
function acceptSignalIfMatch(runtime, ctx) {
	if (!runtime || !ctx) return null;
	if (String(ctx.emotion || "") !== runtime.cfg.signalEmotion) return null;
	if (!ctx.from || !ctx.target) return null;

	for (const [aiKey, st] of Object.entries(runtime.stateByAi)) {
		if (!st || st.phase !== "signaled") continue;
		if (st.expiresAtMs && nowMs() > st.expiresAtMs) {
			finalizeToCooldown(runtime, aiKey, st);
			continue;
		}
		if (getPlayerKey(ctx.target) !== aiKey) continue;
		if (getPlayerKey(ctx.from) !== st.allyKey) continue;

		st.phase = "accepted";
		st.ackAtMs = nowMs();
		return aiKey;
	}

	return null;
}

/**
 * @param {*} game
 * @param {string} key
 * @returns {*|null}
 */
function resolvePlayerByKey(game, key) {
	const players = (game && game.players) || [];
	for (const p of players) {
		if (!isAlive(p)) continue;
		if (getPlayerKey(p) === key) return p;
	}
	return null;
}

/**
 * 若当前 AI 已收到确认，则尝试在出牌阶段执行“铁索 + 属性杀”连招。
 *
 * @param {*} runtime
 * @param {*} aiPlayer
 * @param {*} game
 * @param {*=} get
 * @returns {boolean}
 */
function tryExecuteCombo(runtime, aiPlayer, game, get) {
	if (!runtime || !aiPlayer || !game) return false;
	const aiKey = getPlayerKey(aiPlayer);
	if (!aiKey) return false;

	const st = runtime.stateByAi[aiKey];
	if (!st || st.phase !== "accepted") return false;
	if (st.expiresAtMs && nowMs() > st.expiresAtMs) {
		finalizeToCooldown(runtime, aiKey, st);
		return false;
	}

	if (typeof aiPlayer.isPhaseUsing === "function") {
		try {
			if (!aiPlayer.isPhaseUsing()) return false;
		} catch (e) {
			return false;
		}
	}

	const ally = resolvePlayerByKey(game, st.allyKey);
	const enemy = resolvePlayerByKey(game, st.enemyKey);
	if (!ally || !enemy) {
		finalizeToCooldown(runtime, aiKey, st);
		return false;
	}

	const gGet = get || globalThis.get;
	const shaPlan = pickShaPlan(aiPlayer, gGet);
	if (!shaPlan) {
		finalizeToCooldown(runtime, aiKey, st);
		return false;
	}

	// 执行前再做一次安全检查：血量不足/火伤藤甲 等情况直接放弃（避免“误伤”）
	if ((ally.hp || 0) < runtime.cfg.allyHpMin) {
		finalizeToCooldown(runtime, aiKey, st);
		return false;
	}
	if (natureHasFire(shaPlan.nature) && hasEquipByName(ally, "tengjia")) {
		finalizeToCooldown(runtime, aiKey, st);
		return false;
	}

	// 若能评估收益：要求敌方收益足够，且“敌方收益 + 队友代价”不至于过低（避免乱打队友）
	if (gGet && typeof gGet.damageEffect === "function") {
		const enemyEff = safeDamageEffect(gGet, enemy, aiPlayer, aiPlayer, shaPlan.nature);
		const allyEff = safeDamageEffect(gGet, ally, aiPlayer, aiPlayer, shaPlan.nature);
		if (enemyEff < runtime.cfg.enemyDamageEffectMin || enemyEff + allyEff < runtime.cfg.allyDamageEffectMin) {
			finalizeToCooldown(runtime, aiKey, st);
			return false;
		}
	}

	const needChain = !(isLinked(ally) && isLinked(enemy));
	const tiesuo = findHandCard(aiPlayer, (c) => String(c?.name || "") === "tiesuo");
	if (needChain && !tiesuo) {
		finalizeToCooldown(runtime, aiKey, st);
		return false;
	}

	// 让“连铁索”只作用在需要被连的目标上，避免把已连状态误翻转为未连
	const toChain = [];
	if (!isLinked(ally)) toChain.push(ally);
	if (!isLinked(enemy)) toChain.push(enemy);

	let ok = false;
	try {
		if (tiesuo && toChain.length) {
			aiPlayer.useCard(tiesuo, toChain);
		}

		// 若连环未成立则不出杀（避免白打队友）
		if (!(isLinked(ally) && isLinked(enemy))) {
			return false;
		}

		aiPlayer.useCard(shaPlan.sha, ally);
		ok = true;
	} catch (e) {
		// 若执行失败，仍进入冷却，避免反复尝试卡死
	} finally {
		finalizeToCooldown(runtime, aiKey, st);
	}

	return ok;
}

/**
 * 注册一个全局技能，用于在 phaseUseBegin 时触发运行时逻辑。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
function installGlobalSkill(ctx) {
	const { lib, game, get, _status } = ctx || {};
	if (!lib || !game || !get || !_status) return;
	if (_status.connectMode) return;

	const runtime = getOrCreateRuntime(game);
	if (!runtime) return;

	if (!lib.skill.slqj_ai_chain_elemental_teamplay) {
		lib.skill.slqj_ai_chain_elemental_teamplay = {
			trigger: { player: "phaseUseBegin" },
			forced: true,
			silent: true,
			popup: false,
			filter(event, player) {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.chainElementalTeamplay?.api;
				if (!api || typeof api.filterPhaseUseBegin !== "function") return false;
				try {
					return !!api.filterPhaseUseBegin(event, player);
				} catch (e) {
					return false;
				}
			},
			async content() {
				const g = typeof game !== "undefined" ? game : globalThis.game;
				const api = g?.__slqjAiPersona?.chainElementalTeamplay?.api;
				if (!api || typeof api.onPhaseUseBegin !== "function") return;
				try {
					await api.onPhaseUseBegin(typeof player !== "undefined" ? player : null);
				} catch (e) {}
			},
		};
		game.addGlobalSkill("slqj_ai_chain_elemental_teamplay");
	}
}

/**
 * scripts 插件入口：铁索连环 + 属性杀 的“队友配合”策略。
 *
 * 机制（默认）：
 * 1) AI 在出牌阶段开始时，若满足条件（有可用的属性伤害来源，且可保证连环成立），
 *    会向“高可信队友（attitude 较高且在杀的范围内、血量不低）”投掷鲜花作为确认请求。
 * 2) 若队友向 AI 回投鲜花（对 AI 投掷 flower），视为同意挨一刀；
 *    在 AI vs AI 场景下，若启用 autoAckInAIVsAI，则会在短延迟后自动确认，避免无人回投导致“永远不执行”。
 * 3) 确认后：AI 将（必要时）用铁索让队友与敌方同处连环状态，再用属性伤害（属性杀 / 朱雀转火）攻击队友，
 *    利用连环传导把伤害打到敌方。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setup(ctx) {
	const { game, hooks, _status, get } = ctx || {};
	if (!game || !hooks || !_status) return;
	if (_status.connectMode) return;

	const runtime = getOrCreateRuntime(game);
	if (!runtime) return;

	if (game.__slqjAiPersona.chainElementalTeamplayInstalled) return;
	installRuntimeApi(ctx);
	installGlobalSkill(ctx);

	game.__slqjAiPersona.chainElementalTeamplayInstalled = true;

	hooks.on(
		"slqj_ai_emotion_throw",
		(c) => {
			if (!c) return;

			// 1) 队友回投确认：接受信号并恢复 game.loop
			const acceptedAiKey = acceptSignalIfMatch(runtime, c);
			if (acceptedAiKey) {
				safeResume(game);
				const st = runtime.stateByAi[acceptedAiKey];
				// 若当前没有处于“等待暂停”，则尝试立即执行连招（用于“本次不等待”场景）
				if (st && !st.waiting) {
					const aiPlayer = resolvePlayerByKey(game, acceptedAiKey);
					if (aiPlayer) tryExecuteCombo(runtime, aiPlayer, game, get);
				}
				return;
			}

			// 2) 发起方可在 ctx 上设置约定字段，控制“本次等待”行为（用于需要信号但不想暂停的场景）
			if (!c.from || !c.target) return;
			const fromKey = getPlayerKey(c.from);
			if (!fromKey) return;
			const st = runtime.stateByAi[fromKey];
			if (!st || st.phase !== "signaled" || !st.pendingSignal) return;
			if (getPlayerKey(c.target) !== st.allyKey) return;

			// 约定字段：支持多种写法，方便其他脚本按需注入
			// - c.noWait / c.skipWait: boolean
			// - c.wait: false
			// - c.waitPolicy: "none"
			const noWait =
				!!c.noWait ||
				!!c.skipWait ||
				c.wait === false ||
				String(c.waitPolicy || "").toLowerCase() === "none";
			if (noWait) st.noWait = true;

			if (c.cancel === true) st.canceled = true;
		},
		// priority 越小越晚执行：确保能看到其他 handler 对 ctx 的最终修改
		{ priority: -1000 }
	);

	// 便于在控制台手动调用调试入口（不会自动启用）
	try {
		if (!game.__slqjAiPersona.chainElementalTeamplayDebugExtraDraw) {
			game.__slqjAiPersona.chainElementalTeamplayDebugExtraDraw = () => initDebugExtraDrawCards(ctx);
		}
	} catch (e) {}

	// 便于在控制台查看“本回合为何不投花/投花给谁”的决策记录（不会自动启用任何行为）
	try {
		if (!game.__slqjAiPersona.chainElementalTeamplayDebugGetLast) {
			/**
			 * @param {*=} aiKeyOrPlayer
			 * @returns {*}
			 */
			game.__slqjAiPersona.chainElementalTeamplayDebugGetLast = (aiKeyOrPlayer) => {
				const rt = getOrCreateRuntime(game);
				const dbg = ensureRuntimeDebug(rt);
				if (!dbg) return null;
				if (!aiKeyOrPlayer) return dbg.lastPhaseUseBegin || null;

				let key = "";
				if (typeof aiKeyOrPlayer === "string") key = aiKeyOrPlayer;
				else key = getPlayerKey(aiKeyOrPlayer);
				if (!key) return null;
				return dbg.lastPhaseUseBegin ? dbg.lastPhaseUseBegin[key] : null;
			};
		}
	} catch (e) {}

	// 便于在控制台一键降低门槛/恢复默认（不会自动启用任何行为）
	try {
		if (!game.__slqjAiPersona.chainElementalTeamplayDebugPresetLow) {
			/**
			 * 调试：将“投花发起条件”门槛降到很低（仅影响本局运行时 cfg）。
			 *
			 * @returns {Record<string, any>}
			 */
			game.__slqjAiPersona.chainElementalTeamplayDebugPresetLow = () =>
				applyCfgPresetToRuntime(runtime, DEBUG_PRESET_LOW_CFG);
		}
		if (!game.__slqjAiPersona.chainElementalTeamplayDebugPresetReset) {
			/**
			 * 调试：恢复该脚本的默认门槛（仅影响本局运行时 cfg）。
			 *
			 * @returns {Record<string, any>}
			 */
			game.__slqjAiPersona.chainElementalTeamplayDebugPresetReset = () =>
				applyCfgPresetToRuntime(runtime, DEFAULT_CFG);
		}
		if (!game.__slqjAiPersona.chainElementalTeamplayDebugGetCfg) {
			/**
			 * 调试：查看该脚本当前运行时 cfg 快照（只读）。
			 *
			 * @returns {Record<string, any>}
			 */
			game.__slqjAiPersona.chainElementalTeamplayDebugGetCfg = () => snapshotRuntimeCfg(runtime);
		}
		if (!game.__slqjAiPersona.chainElementalTeamplayDebugLockAllLinked) {
			/**
			 * 调试：将本局所有角色锁定为“连环”状态（并阻止后续解除连环）。
			 *
			 * 用法：
			 * - 开启（默认）：`chainElementalTeamplayDebugLockAllLinked()`
			 * - 关闭：`chainElementalTeamplayDebugLockAllLinked(false)`
			 *
			 * @param {boolean=} enable
			 * @returns {{enabled:boolean, linkedAlive:number, cfg: Record<string, any>}}
			 */
			game.__slqjAiPersona.chainElementalTeamplayDebugLockAllLinked = (enable = true) => {
				const rt = getOrCreateRuntime(game);
				const dbg = ensureRuntimeDebug(rt);
				if (!rt || !dbg) return { enabled: false, linkedAlive: 0, cfg: {} };

				const enabled = enable !== false;
				dbg.lockAllLinkedEnabled = enabled;

				if (enabled) {
					patchAllPlayersLinkForDebugLock(game);
					const linkedAlive = forceAllAlivePlayersLinked(game);
					return { enabled: true, linkedAlive, cfg: snapshotRuntimeCfg(rt) };
				}

				unpatchAllPlayersLinkForDebugLock(game);
				return { enabled: false, linkedAlive: 0, cfg: snapshotRuntimeCfg(rt) };
			};
		}
	} catch (e) {}
}

/**
 * 调试：初始化“摸牌阶段额外生成铁索 + 雷杀”。
 *
 * 一旦执行，会在之后每个回合的摸牌阶段开始时，额外创造：
 * - 【铁索连环】x1
 * - 【雷杀】x1
 *
 * 并交给当前摸牌的角色（随机花色与点数）。
 *
 * @param {SlqjAiScriptContext} [ctx]
 * @returns {void}
 */
export function initDebugExtraDrawCards(ctx) {
	const lib = (ctx && ctx.lib) || globalThis.lib;
	const game = (ctx && ctx.game) || globalThis.game;
	const _status = (ctx && ctx._status) || globalThis._status;
	if (!lib || !game || !_status) return;
	if (_status.connectMode) return;

	const runtime = getOrCreateRuntime(game);
	if (!runtime) return;

	runtime.debug ??= Object.create(null);
	runtime.debug.extraDrawCardsEnabled = true;

	if (!runtime.api || typeof runtime.api !== "object") runtime.api = Object.create(null);

	runtime.api.filterPhaseDrawBeginDebugExtraDrawCards = (event, player) => {
		try {
			const rt = getOrCreateRuntime(game);
			if (!rt?.debug?.extraDrawCardsEnabled) return false;
			return !!player && !player.dead;
		} catch (e) {
			return false;
		}
	};

	runtime.api.onPhaseDrawBeginDebugExtraDrawCards = (player) => {
		if (!player) return;
		const rt = getOrCreateRuntime(game);
		if (!rt?.debug?.extraDrawCardsEnabled) return;

		const suits = ["spade", "heart", "club", "diamond"];
		const randSuit = () => suits[Math.floor(Math.random() * suits.length)];
		const randNum = () => Math.floor(Math.random() * 13) + 1;

		let tiesuo;
		let leisha;
		try {
			tiesuo = game.createCard2("tiesuo", randSuit(), randNum());
			leisha = game.createCard2("sha", randSuit(), randNum(), "thunder");
		} catch (e) {
			return;
		}

		try {
			if (typeof player.gain === "function") {
				player.gain([tiesuo, leisha], "draw");
			}
		} catch (e) {}
	};

	if (!game.__slqjAiPersona.chainElementalTeamplayDebugExtraDrawInstalled) {
		game.__slqjAiPersona.chainElementalTeamplayDebugExtraDrawInstalled = true;

		if (!lib.skill.slqj_ai_chain_elemental_teamplay_debug_extra_draw_cards) {
			lib.skill.slqj_ai_chain_elemental_teamplay_debug_extra_draw_cards = {
				trigger: { player: "phaseDrawBegin" },
				forced: true,
				silent: true,
				popup: false,
				filter(event, player) {
					const g = typeof game !== "undefined" ? game : globalThis.game;
					const api = g?.__slqjAiPersona?.chainElementalTeamplay?.api;
					if (!api || typeof api.filterPhaseDrawBeginDebugExtraDrawCards !== "function") return false;
					try {
						return !!api.filterPhaseDrawBeginDebugExtraDrawCards(event, player);
					} catch (e) {
						return false;
					}
				},
				content() {
					const g = typeof game !== "undefined" ? game : globalThis.game;
					const api = g?.__slqjAiPersona?.chainElementalTeamplay?.api;
					if (!api || typeof api.onPhaseDrawBeginDebugExtraDrawCards !== "function") return;
					try {
						api.onPhaseDrawBeginDebugExtraDrawCards(typeof player !== "undefined" ? player : null);
					} catch (e) {}
				},
			};
		}

		try {
			game.addGlobalSkill("slqj_ai_chain_elemental_teamplay_debug_extra_draw_cards");
		} catch (e) {}
	}
}
