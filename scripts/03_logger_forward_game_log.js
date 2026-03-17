import logManager from "../src/logger/manager.js";

/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 */

const LOG_MANAGER_REGISTER_NAME = "forward_game_log";
const GLOBAL_KEY = "__slqjAiLoggerForwardGameLog";

/**
 * scripts 插件元信息（用于“脚本插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "Logger 转发到 game.log",
	version: "1.0.1",
	description:
		"启用后将“身临其境的AI”的 logManager 日志转发为引擎 game.log(...)（仅本地/非联机/非connectMode 生效）。",
};

/**
 * scripts 插件配置（用于“脚本插件管理 -> 配置(⚙)”）。
 *
 * @type {{version:1, items:Array<any>}}
 */
export const slqjAiScriptConfig = {
	version: 1,
	items: [
		{
			key: "whitelist",
			name: "白名单关键字",
			type: "textarea",
			default: "[身临其境的AI]",
			description:
				"每行一个关键字；仅当转发文本包含任一白名单关键字才会写入 game.log。留空表示不输出任何转发日志。",
		},
		{
			key: "blacklist",
			name: "黑名单关键字",
			type: "textarea",
			default: "[runForSkillIds]\n[attitude]",
			description: "每行一个关键字；若转发文本包含任一黑名单关键字则不输出（优先于白名单）。",
		},
	],
};

/**
 * 脚本入口：注册一个 logger，将 logManager 的输出转发到 `game.log(...)`。
 *
 * 注意：
 * - 仅在“非联机/非connectMode”下启用，避免把调试信息广播给其他玩家
 * - 只做输出转发，不会改动 AI 行为
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setup(ctx) {
	const game = ctx && ctx.game;
	const _status = ctx && ctx._status;
	if (!game) return;

	// 仅本地：联机/联机大厅/联机房间等场景可能会广播 log，直接跳过。
	if (isConnectOrOnline(game, _status)) return;

	/** @type {any} */
	const g = globalThis;
	try {
		if (g && g[GLOBAL_KEY] && g[GLOBAL_KEY].installed) return;
	} catch (e) {}

	const whitelist = parseKeywordLines(ctx?.scriptConfig?.whitelist);
	const blacklist = parseKeywordLines(ctx?.scriptConfig?.blacklist);
	const state = { installed: true, whitelist, blacklist };
	try {
		if (g) g[GLOBAL_KEY] = state;
	} catch (e) {}

	const consoleLogger = safeGetConsoleLogger();
	const basePrefix =
		typeof consoleLogger?.prefix === "string" && consoleLogger.prefix.trim()
			? consoleLogger.prefix.trim()
			: "[身临其境的AI]";

	/**
	 * debug 开关：跟随 console logger（其内部已按 dev/slqj_ai_scripts_debug 等配置判断）。
	 *
	 * @returns {boolean}
	 */
	const isDebug = () => {
		try {
			const l = safeGetConsoleLogger();
			return typeof l?.isDebug === "function" ? !!l.isDebug() : false;
		} catch (e) {
			return false;
		}
	};

	/**
	 * 转发 logger：注册进 logManager，由广播触发输出。
	 *
	 * @implements {import("../src/logger/manager.js").SlqjLogger}
	 */
	class ForwardToGameLogLogger {
		/**
		 * @param {{prefix?:string, debug?:boolean|(()=>boolean)}} [opts]
		 */
		constructor(opts) {
			this.prefix = opts && opts.prefix != null ? String(opts.prefix) : "";
			this._isDebug = normalizeDebugResolver(opts ? opts.debug : undefined);
		}

		/**
		 * @param {any} feature
		 * @param {...any} args
		 * @returns {void}
		 */
		log(feature, ...args) {
			this._out("log", feature, args);
		}

		/**
		 * @param {any} feature
		 * @param {...any} args
		 * @returns {void}
		 */
		warn(feature, ...args) {
			this._out("warn", feature, args);
		}

		/**
		 * @param {any} feature
		 * @param {...any} args
		 * @returns {void}
		 */
		error(feature, ...args) {
			this._out("error", feature, args);
		}

		/**
		 * @param {any} feature
		 * @param {...any} args
		 * @returns {void}
		 */
		debug(feature, ...args) {
			try {
				if (!this.isDebug()) return;
			} catch (e) {
				return;
			}
			this._out("debug", feature, args);
		}

		/**
		 * @returns {boolean}
		 */
		isDebug() {
			try {
				return !!this._isDebug();
			} catch (e) {
				return false;
			}
		}

		/**
		 * @param {"log"|"warn"|"error"|"debug"} level
		 * @param {any} feature
		 * @param {any[]} args
		 * @returns {void}
		 */
		_out(level, feature, args) {
			if (isConnectOrOnline(game, _status)) return;
			const text = buildLogText(this.prefix, level, feature, args);
			if (!text) return;
			if (!shouldForwardGameLog(state, text)) return;
			safeGameLog(game, text);
		}
	}

	try {
		logManager.register(LOG_MANAGER_REGISTER_NAME, ForwardToGameLogLogger, {
			prefix: `${basePrefix}[game.log]`,
			debug: isDebug,
		});
	} catch (e) {}

	const hello = `${basePrefix}[game.log] Logger 转发已启用（仅本地/非联机生效）`;
	if (shouldForwardGameLog(state, hello)) safeGameLog(game, hello);
}

/**
 * @returns {any|null}
 */
function safeGetConsoleLogger() {
	try {
		const l = logManager.get("console");
		return l && typeof l === "object" ? l : null;
	} catch (e) {
		return null;
	}
}

/**
 * 判断是否处于联机/联机大厅/联机房间等“可能广播 log”的环境。
 *
 * @param {*} game
 * @param {*} _status
 * @returns {boolean}
 */
function isConnectOrOnline(game, _status) {
	try {
		if (_status && _status.connectMode) return true;
	} catch (e) {}
	try {
		if (game && game.online) return true;
	} catch (e) {}
	try {
		if (game && game.onlineroom) return true;
	} catch (e) {}
	try {
		if (game && game.connectMode) return true;
	} catch (e) {}
	return false;
}

/**
 * 从多行文本中解析关键字列表（按换行拆分）。
 *
 * @param {any} raw
 * @returns {string[]}
 */
function parseKeywordLines(raw) {
	const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
	const lines = text.split(/\r?\n/);
	/** @type {string[]} */
	const out = [];
	const seen = new Set();
	for (const line of lines) {
		const kw = String(line || "").trim();
		if (!kw) continue;
		if (seen.has(kw)) continue;
		seen.add(kw);
		out.push(kw);
		if (out.length >= 200) break;
	}
	return out;
}

/**
 * 判断转发文本是否应输出到 `game.log(...)`。
 *
 * 规则：
 * - 命中黑名单：不输出
 * - 未命中黑名单：仅当命中白名单关键字时输出
 *
 * @param {any} state
 * @param {string} text
 * @returns {boolean}
 */
function shouldForwardGameLog(state, text) {
	const t = String(text || "");
	const blacklist = Array.isArray(state?.blacklist) ? state.blacklist : [];
	for (const kw of blacklist) {
		if (kw && typeof kw === "string" && t.includes(kw)) return false;
	}
	const whitelist = Array.isArray(state?.whitelist) ? state.whitelist : [];
	if (!whitelist.length) return false;
	for (const kw of whitelist) {
		if (kw && typeof kw === "string" && t.includes(kw)) return true;
	}
	return false;
}

/**
 * 将 logManager 广播的参数拼接为更适合 game.log 的单行文本。
 *
 * @param {string} prefix
 * @param {"log"|"warn"|"error"|"debug"} level
 * @param {any} feature
 * @param {any[]} args
 * @returns {string}
 */
function buildLogText(prefix, level, feature, args) {
	const p = String(prefix || "").trim() || "[logger]";
	const f = String(feature == null ? "" : feature).trim();
	const lv = String(level || "").trim();

	let head = p;
	if (f) head += `[${f}]`;
	if (lv && lv !== "log") head += `[${lv}]`;

	const rest = Array.isArray(args) ? args : [];
	if (!rest.length) return head;

	const parts = [];
	for (const a of rest) {
		const s = stringifyArg(a);
		if (s) parts.push(s);
	}
	if (!parts.length) return head;
	return head + " " + parts.join(" ");
}

/**
 * @param {any} v
 * @returns {string}
 */
function stringifyArg(v) {
	try {
		if (typeof v === "string") return v.trim();
		if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
		if (v == null) return String(v);
		if (v instanceof Error) {
			const msg = String(v && (v.stack || v.message || v.name || "Error"));
			return msg.trim();
		}
		if (typeof v === "object") {
			return safeJsonStringify(v);
		}
		return String(v).trim();
	} catch (e) {
		return "";
	}
}

/**
 * @param {any} obj
 * @returns {string}
 */
function safeJsonStringify(obj) {
	const seen = new Set();
	try {
		const s = JSON.stringify(
			obj,
			(k, v) => {
				try {
					if (typeof v === "bigint") return String(v);
					if (typeof v === "function") return "[Function]";
					if (!v || typeof v !== "object") return v;
					if (seen.has(v)) return "[Circular]";
					seen.add(v);
					return v;
				} catch (e) {
					return "[Unserializable]";
				}
			},
			0
		);
		const t = String(s || "").trim();
		if (!t) return "";
		// 避免过长刷屏
		return t.length > 800 ? t.slice(0, 800) + "…" : t;
	} catch (e) {
		try {
			const t = String(obj).trim();
			return t.length > 800 ? t.slice(0, 800) + "…" : t;
		} catch (e2) {
			return "";
		}
	}
}

/**
 * 安全调用 `game.log(...)`：在方法缺失或抛错时静默跳过。
 *
 * @param {*} game
 * @param {...any} args
 * @returns {void}
 */
function safeGameLog(game, ...args) {
	try {
		if (!game || typeof game.log !== "function") return;
		game.log.apply(game, args);
	} catch (e) {}
}

/**
 * @param {boolean|(()=>boolean)|undefined} debug
 * @returns {()=>boolean}
 */
function normalizeDebugResolver(debug) {
	if (typeof debug === "function") return debug;
	return () => !!debug;
}
