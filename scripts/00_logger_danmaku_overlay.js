import logManager from "../src/logger/manager.js";

/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 */

const LOG_MANAGER_REGISTER_NAME = "danmaku_overlay";

/**
 * scripts 插件元信息（用于“脚本插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "Logger 弹幕层（AI 日志飘屏）",
	version: "1.0.2",
	description:
		"启用后在屏幕叠加弹幕层；当“身临其境的AI”输出日志时，以弹幕形式从右向左飘过（支持 1~10 行配置；支持关键字白名单/黑名单过滤）。",
};

/**
 * scripts 插件配置（用于“脚本插件管理 -> 配置(⚙)”）。
 *
 * @type {{version:1, items:Array<any>}}
 */
export const slqjAiScriptConfig = {
	version: 1,
	items: [
		{ key: "rows", name: "弹幕行数", type: "number", default: 6, min: 1, max: 10, step: 1 },
		{
			key: "whitelist",
			name: "白名单关键字",
			type: "textarea",
			default: "[身临其境的AI]",
			description: "每行一个关键字；仅当弹幕文本包含任一白名单关键字才会输出。留空表示不输出任何弹幕。",
		},
		{
			key: "blacklist",
			name: "黑名单关键字",
			type: "textarea",
			default: "[runForSkillIds]\n[attitude]",
			description: "每行一个关键字；若弹幕文本包含任一黑名单关键字则不输出（优先于白名单）。",
		},
	],
};

const GLOBAL_KEY = "__slqjAiLoggerDanmakuOverlay";

/**
 * 脚本入口：安装 logger 弹幕展示。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setup(ctx) {
	/** @type {any} */
	const g = globalThis;
	const existing = g && g[GLOBAL_KEY] ? g[GLOBAL_KEY] : null;
	if (existing && existing.installed) return;

	const rows = clampInt(ctx?.scriptConfig?.rows, 6, 1, 10);
	const whitelist = parseKeywordLines(ctx?.scriptConfig?.whitelist);
	const blacklist = parseKeywordLines(ctx?.scriptConfig?.blacklist);
	const logger = safeGetConsoleLogger();

	/** @type {{installed:boolean, rows:number, whitelist:string[], blacklist:string[], pending:Array<{text:string, level:string}>, overlay:HTMLElement|null, lane:number}} */
	const state = {
		installed: true,
		rows,
		whitelist,
		blacklist,
		pending: [],
		overlay: null,
		lane: 0,
	};
	if (g) g[GLOBAL_KEY] = state;

	// 注册为独立 logger：由 logManager 广播驱动，无需 patch console logger。
	try {
		const prefix = typeof logger?.prefix === "string" ? logger.prefix : "";
		logManager.register(LOG_MANAGER_REGISTER_NAME, DanmakuOverlayLogger, {
			prefix,
			debug: () => {
				try {
					const l = safeGetConsoleLogger();
					return typeof l?.isDebug === "function" ? !!l.isDebug() : false;
				} catch (e) {
					return false;
				}
			},
		});
	} catch (e) {}

	whenBodyReady(() => {
		state.overlay = ensureOverlay();
		try {
			state.overlay.style.setProperty("--slqj-ai-danmaku-rows", String(rows));
		} catch (e) {}
		flushPending(state);
		emitDanmaku(state, `Logger 弹幕层已启用（rows=${rows}）`, "debug");
	});
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
/**
 * 弹幕层 logger：注册进 logManager，由广播触发输出。
 *
 * @implements {import("../src/logger/manager.js").SlqjLogger}
 */
class DanmakuOverlayLogger {
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
		this._emit("log", feature, args);
	}

	/**
	 * @param {any} feature
	 * @param {...any} args
	 * @returns {void}
	 */
	warn(feature, ...args) {
		this._emit("warn", feature, args);
	}

	/**
	 * @param {any} feature
	 * @param {...any} args
	 * @returns {void}
	 */
	error(feature, ...args) {
		this._emit("error", feature, args);
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
		this._emit("debug", feature, args);
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
	_emit(level, feature, args) {
		/** @type {any} */
		const g = globalThis;
		const state = g && g[GLOBAL_KEY] ? g[GLOBAL_KEY] : null;
		if (!state || !state.installed) return;

		const text = buildLogText(this, feature, args);
		if (!text) return;
		emitDanmaku(state, text, level);
	}
}

/**
 * @param {any} logger
 * @param {any} feature
 * @param {any[]} args
 * @returns {string}
 */
function buildLogText(logger, feature, args) {
	const prefix = typeof logger?.prefix === "string" ? logger.prefix : "";
	const f = String(feature == null ? "" : feature).trim();
	const head = f ? (prefix ? `${prefix}[${f}]` : `[${f}]`) : prefix || "[logger]";

	const list = Array.isArray(args) ? args : [];
	const msg = formatConsoleMessage(list);
	const raw = normalizeText(head + (msg ? " " + msg : ""));
	return truncateText(raw, 180);
}

/**
 * @param {boolean|(()=>boolean)|undefined} debug
 * @returns {()=>boolean}
 */
function normalizeDebugResolver(debug) {
	if (typeof debug === "function") return debug;
	return () => !!debug;
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
 * 判断弹幕文本是否应输出。
 *
 * 规则：
 * - 命中黑名单：不输出
 * - 未命中黑名单：仅当命中白名单关键字时输出
 *
 * @param {any} state
 * @param {string} text
 * @returns {boolean}
 */
function shouldEmitDanmaku(state, text) {
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
 * 模拟 console 的格式化行为（支持 `%s/%d/%i/%f/%o/%O/%c/%%`）。
 *
 * @param {any[]} args
 * @returns {string}
 */
function formatConsoleMessage(args) {
	const list = Array.isArray(args) ? args : [];
	if (!list.length) return "";

	// console 风格：当第一个参数为 string 时，按格式化占位符消费后续参数。
	if (typeof list[0] === "string") {
		const fmt = list[0];
		const rest = list.slice(1);
		const r = formatPercentTokens(fmt, rest);
		const tail = r.rest.map(formatValue).filter(Boolean).join(" ");
		const head = normalizeText(r.text);
		return normalizeText(head + (tail ? " " + tail : ""));
	}

	return list.map(formatValue).filter(Boolean).join(" ");
}

/**
 * 将 `%s/%d/%i/%f/%o/%O/%c/%%` 之类的格式化占位符替换为参数。
 *
 * 说明：
 * - `%c`（样式）会被忽略（但仍会消费一个参数）
 * - 参数不足时保留原占位符
 *
 * @param {string} fmt
 * @param {any[]} args
 * @returns {{text:string, rest:any[]}}
 */
function formatPercentTokens(fmt, args) {
	const text = String(fmt == null ? "" : fmt);
	const list = Array.isArray(args) ? args : [];
	let out = "";
	let i = 0;
	let ai = 0;

	while (i < text.length) {
		const ch = text[i];
		if (ch !== "%") {
			out += ch;
			i++;
			continue;
		}
		if (i + 1 >= text.length) {
			out += "%";
			i++;
			continue;
		}
		const spec = text[i + 1];
		i += 2;

		if (spec === "%") {
			out += "%";
			continue;
		}

		if (ai >= list.length) {
			out += "%" + spec;
			continue;
		}

		const v = list[ai];
		switch (spec) {
			case "s":
				out += formatStringLike(v);
				ai++;
				break;
			case "d":
				out += formatNumberLike(v, "d");
				ai++;
				break;
			case "i":
				out += formatNumberLike(v, "i");
				ai++;
				break;
			case "f":
				out += formatNumberLike(v, "f");
				ai++;
				break;
			case "o":
			case "O":
				out += formatObjectLike(v);
				ai++;
				break;
			case "c":
				// 样式字符串：弹幕不支持样式，直接忽略（但要消费参数）。
				ai++;
				break;
			default:
				// 未知占位符：不消费参数，原样输出。
				out += "%" + spec;
				break;
		}
	}

	return { text: out, rest: list.slice(ai) };
}

/**
 * @param {any} value
 * @returns {string}
 */
function formatStringLike(value) {
	try {
		if (value == null) return "";
		if (typeof value === "string") return value;
		if (value instanceof Error) return value.message || String(value);
		if (typeof value === "object") return safeJsonStringify(value, 120) || String(value);
		return String(value);
	} catch (e) {
		return "";
	}
}

/**
 * @param {any} value
 * @param {"d"|"i"|"f"} mode
 * @returns {string}
 */
function formatNumberLike(value, mode) {
	try {
		if (typeof value === "bigint") return value.toString();
		const n = Number(value);
		if (!Number.isFinite(n)) return String(n);
		if (mode === "i") return String(Math.trunc(n));
		return String(n);
	} catch (e) {
		return "NaN";
	}
}

/**
 * @param {any} value
 * @returns {string}
 */
function formatObjectLike(value) {
	try {
		if (value == null) return "";
		return safeJsonStringify(value, 160) || String(value);
	} catch (e) {
		return "";
	}
}

/**
 * @param {any} value
 * @returns {string}
 */
function formatValue(value) {
	try {
		if (value == null) return "";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
		if (typeof value === "function") return `[Function${value.name ? " " + value.name : ""}]`;
		if (typeof value === "symbol") return String(value);
		if (value instanceof Error) return value.message || String(value);
	} catch (e) {}

	// object：尽量 JSON，一旦失败回退 String
	try {
		const json = safeJsonStringify(value, 160);
		if (json) return json;
	} catch (e) {}
	try {
		return String(value);
	} catch (e) {}
	return "";
}

/**
 * @param {any} obj
 * @param {number} maxLen
 * @returns {string}
 */
function safeJsonStringify(obj, maxLen) {
	if (obj == null) return "";
	if (typeof maxLen !== "number" || !Number.isFinite(maxLen) || maxLen <= 0) maxLen = 160;
	/** @type {WeakSet<any>} */
	const seen = new WeakSet();
	try {
		const text = JSON.stringify(obj, (_k, v) => {
			try {
				if (typeof v === "bigint") return String(v);
				if (typeof v === "function") return `[Function${v.name ? " " + v.name : ""}]`;
				if (typeof v === "object" && v) {
					if (seen.has(v)) return "[Circular]";
					seen.add(v);
				}
			} catch (e) {}
			return v;
		});
		return truncateText(normalizeText(text), maxLen);
	} catch (e) {
		return "";
	}
}

/**
 * @returns {HTMLElement|null}
 */
function ensureOverlay() {
	if (typeof document === "undefined" || !document) return null;
	ensureStyles();
	try {
		const existed = document.getElementById("slqj-ai-danmaku-overlay");
		if (existed && existed instanceof HTMLElement) return existed;
	} catch (e) {}

	/** @type {HTMLElement|null} */
	let root = null;
	try {
		root = document.createElement("div");
		root.id = "slqj-ai-danmaku-overlay";
		root.className = "slqj-ai-danmaku-overlay";
	} catch (e) {
		root = null;
	}
	if (!root) return null;

	try {
		const parent = document.body || document.documentElement;
		if (!parent) return null;
		parent.appendChild(root);
		return root;
	} catch (e) {
		return null;
	}
}

/**
 * @returns {void}
 */
function ensureStyles() {
	if (typeof document === "undefined" || !document) return;
	try {
		const existed = document.getElementById("slqj-ai-danmaku-style");
		if (existed) return;
	} catch (e) {}

	/** @type {HTMLStyleElement|null} */
	let style = null;
	try {
		style = document.createElement("style");
		style.id = "slqj-ai-danmaku-style";
		style.type = "text/css";
		style.textContent = [
			".slqj-ai-danmaku-overlay{position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:999999;}",
			".slqj-ai-danmaku-item{position:absolute;left:100%;top:0;transform:translateX(0);white-space:nowrap;",
			"font-size:16px;line-height:1.2;font-weight:600;padding:2px 6px;border-radius:6px;",
			"color:var(--slqj-ai-danmaku-color,#fff);background:rgba(0,0,0,0.25);",
			"text-shadow:0 1px 2px rgba(0,0,0,0.7);",
			"animation:slqj-ai-danmaku-move var(--slqj-ai-danmaku-duration,10s) linear both;}",
			"@keyframes slqj-ai-danmaku-move{from{transform:translateX(0);}to{transform:translateX(var(--slqj-ai-danmaku-distance,-120vw));}}",
		].join("");
	} catch (e) {
		style = null;
	}
	if (!style) return;
	try {
		(document.head || document.documentElement || document.body)?.appendChild(style);
	} catch (e) {}
}

/**
 * @param {{rows:number, lane:number}} state
 * @returns {number}
 */
function nextLane(state) {
	const rows = clampInt(state?.rows, 6, 1, 10);
	const cur = typeof state?.lane === "number" && Number.isFinite(state.lane) ? state.lane : 0;
	const idx = ((cur % rows) + rows) % rows;
	const next = (idx + 1) % rows;
	if (state) state.lane = next;
	return idx;
}

/**
 * @param {any} state
 * @param {string} text
 * @param {"log"|"warn"|"error"|"debug"|string} level
 * @returns {void}
 */
function emitDanmaku(state, text, level) {
	const t = normalizeText(text || "");
	if (!t) return;
	if (!shouldEmitDanmaku(state, t)) return;

	const overlay = state?.overlay;
	if (!overlay) {
		enqueuePending(state, { text: t, level: String(level || "log") });
		return;
	}
	createDanmakuItem(overlay, {
		text: t,
		level: String(level || "log"),
		rows: clampInt(state?.rows, 6, 1, 10),
		rowIndex: nextLane(state),
	});
}

/**
 * @param {any} state
 * @param {{text:string, level:string}} item
 * @returns {void}
 */
function enqueuePending(state, item) {
	if (!state || !item || !item.text) return;
	state.pending ??= [];
	if (!Array.isArray(state.pending)) state.pending = [];
	state.pending.push({ text: item.text, level: item.level || "log" });
	// 防止极端刷屏导致 pending 无限增长
	if (state.pending.length > 80) state.pending.splice(0, state.pending.length - 80);
}

/**
 * @param {any} state
 * @returns {void}
 */
function flushPending(state) {
	const overlay = state?.overlay;
	if (!overlay) return;
	const pending = Array.isArray(state?.pending) ? state.pending.slice() : [];
	state.pending = [];
	for (const it of pending) {
		try {
			if (!it || !it.text) continue;
			emitDanmaku(state, it.text, it.level || "log");
		} catch (e) {}
	}
}

/**
 * @param {HTMLElement} overlay
 * @param {{text:string, level:string, rows:number, rowIndex:number}} args
 * @returns {void}
 */
function createDanmakuItem(overlay, args) {
	if (!overlay || typeof document === "undefined" || !document) return;
	const text = normalizeText(args?.text || "");
	if (!text) return;

	const rows = clampInt(args?.rows, 6, 1, 10);
	const rowIndex = clampInt(args?.rowIndex, 0, 0, Math.max(0, rows - 1));
	const level = String(args?.level || "log");

	const maxActive = Math.max(40, rows * 10);
	try {
		while (overlay.childElementCount > maxActive) {
			overlay.firstElementChild?.remove?.();
		}
	} catch (e) {}

	/** @type {HTMLElement|null} */
	let el = null;
	try {
		el = document.createElement("div");
		el.className = "slqj-ai-danmaku-item";
		el.textContent = text;
	} catch (e) {
		el = null;
	}
	if (!el) return;

	const rowHeight = 24;
	const topPad = 10;
	el.style.top = `${topPad + rowIndex * rowHeight}px`;
	el.style.setProperty("--slqj-ai-danmaku-color", pickLevelColor(level));

	try {
		overlay.appendChild(el);
	} catch (e) {
		return;
	}

	// 计算动画距离与时长（与文本长度相关，避免超长文本过快闪过）。
	try {
		const w = overlay.getBoundingClientRect().width || window.innerWidth || 0;
		const ew = el.getBoundingClientRect().width || 0;
		const distance = Math.max(1, w + ew + 24);
		el.style.setProperty("--slqj-ai-danmaku-distance", `-${Math.floor(distance)}px`);

		const dur = clampNumber(6 + text.length * 0.08, 6, 16);
		el.style.setProperty("--slqj-ai-danmaku-duration", `${dur.toFixed(2)}s`);
	} catch (e) {}

	try {
		el.addEventListener(
			"animationend",
			() => {
				try {
					el.remove();
				} catch (e) {}
			},
			{ once: true }
		);
	} catch (e) {}
}

/**
 * @param {string} level
 * @returns {string}
 */
function pickLevelColor(level) {
	switch (String(level || "").toLowerCase()) {
		case "warn":
			return "#ffe066";
		case "error":
			return "#ff6b6b";
		case "debug":
			return "#74c0fc";
		default:
			return "#ffffff";
	}
}

/**
 * @param {() => void} cb
 * @returns {void}
 */
function whenBodyReady(cb) {
	if (typeof cb !== "function") return;
	if (typeof document === "undefined" || !document) return;
	const tryRun = () => {
		try {
			if (!document.body) return false;
		} catch (e) {
			return false;
		}
		try {
			cb();
		} catch (e) {}
		return true;
	};

	if (tryRun()) return;
	let tries = 0;
	const id = setInterval(() => {
		tries++;
		if (tryRun() || tries >= 120) {
			try {
				clearInterval(id);
			} catch (e) {}
		}
	}, 50);
}

/**
 * @param {any} v
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(v, fallback, min, max) {
	let n = fallback;
	try {
		if (typeof v === "number" && Number.isFinite(v)) n = v;
		else if (typeof v === "string" && v.trim() !== "") n = Number(v);
	} catch (e) {}
	if (!Number.isFinite(n)) n = fallback;
	n = Math.floor(n);
	if (Number.isFinite(min)) n = Math.max(n, min);
	if (Number.isFinite(max)) n = Math.min(n, max);
	return n;
}

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(v, min, max) {
	let n = typeof v === "number" && Number.isFinite(v) ? v : 0;
	if (typeof min === "number" && Number.isFinite(min)) n = Math.max(n, min);
	if (typeof max === "number" && Number.isFinite(max)) n = Math.min(n, max);
	return n;
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
	return String(text || "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/**
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateText(text, maxLen) {
	const t = String(text || "");
	const n = typeof maxLen === "number" && Number.isFinite(maxLen) ? Math.floor(maxLen) : 180;
	if (n <= 0) return "";
	if (t.length <= n) return t;
	return t.slice(0, Math.max(0, n - 1)) + "…";
}
