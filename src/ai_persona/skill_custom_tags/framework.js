/**
 * 技能自定义 tag 处理器框架：
 * - 支持注册多个“处理器”（processor）
 * - 处理器基于技能文本说明（`<skillId>_info`）用正则匹配推导 tag
 * - 汇总写入 `SkillCustomTagStore`，由安装入口统一 apply 到 `lib.skill[skillId].ai`
 */

/**
 * @typedef {Record<string, boolean|number|string>} SkillCustomTags
 */

/**
 * @typedef {Object} SkillCustomTagContext
 * @property {*} lib
 * @property {*} game
 * @property {*} ui
 * @property {*} get
 * @property {*} ai
 * @property {*} _status
 * @property {import("../lib/jsdoc_types.js").SlqjAiExtensionConfig|any} config
 */

/**
 * @typedef {{
 *  skillId: string,
 *  infoKey: string,
 *  rawText: string,
 *  text: string,
 *  lib: any,
 *  game: any,
 *  ui: any,
 *  get: any,
 *  ai: any,
 *  _status: any,
 *  config: any,
 * }} SkillTextProcessInput
 */

/**
 * @typedef {{
 *  id: string,
 *  description?: string,
 *  process: (input: SkillTextProcessInput) => (SkillCustomTags|null|undefined)
 * }} SkillTagTextProcessor
 */

export class SkillTagProcessorFramework {
	/**
	 * @param {{logger?: {info?:(...args:any[])=>void, warn?:(...args:any[])=>void, debug?:(...args:any[])=>void}}} [opts]
	 */
	constructor(opts) {
		/** @type {SkillTagTextProcessor[]} */
		this.processors = [];
		this.logger = opts && opts.logger ? opts.logger : null;
	}

	/**
	 * 注册一个处理器。
	 *
	 * @param {SkillTagTextProcessor} processor
	 * @returns {void}
	 */
	register(processor) {
		if (!processor || typeof processor !== "object") return;
		const id = String(processor.id || "");
		if (!id) return;
		if (typeof processor.process !== "function") return;
		this.processors.push(processor);
	}

	/**
	 * 扫描技能说明文本，运行所有处理器，并把结果写入 store。
	 *
	 * @param {SkillCustomTagContext} ctx
	 * @param {import("./store.js").SkillCustomTagStore} store
	 * @returns {{
	 *  scanned: number,
	 *  tagged: number,
	 *  matchedByProcessor: Record<string, number>,
	 *  skippedNoInfo: number,
	 * }}
	 */
	run(ctx, store) {
		const lib = ctx && ctx.lib;
		const game = ctx && ctx.game;
		const ui = ctx && ctx.ui;
		const get = ctx && ctx.get;
		const ai = ctx && ctx.ai;
		const _status = ctx && ctx._status;
		const config = ctx && ctx.config;

		const report = {
			scanned: 0,
			tagged: 0,
			matchedByProcessor: Object.create(null),
			skippedNoInfo: 0,
		};

		if (!lib || !store) return report;
		const entries = listSkillInfoEntries(lib, get);
		if (!entries.length) return report;

		return runOnEntries({ entries, processors: this.processors, store, report, ctx, logger: this.logger });
	}

	/**
	 * 扫描指定的技能集合（skillId 列表），运行所有处理器，并把结果写入 store。
	 *
	 * 说明：
	 * - 用于“仅对本局实际出现的技能/新增技能”做增量补全，避免全量扫描 `lib.translate`
	 *
	 * @param {SkillCustomTagContext} ctx
	 * @param {import("./store.js").SkillCustomTagStore} store
	 * @param {string[]} skillIds
	 * @returns {{
	 *  scanned: number,
	 *  tagged: number,
	 *  matchedByProcessor: Record<string, number>,
	 *  skippedNoInfo: number,
	 * }}
	 */
	runForSkillIds(ctx, store, skillIds) {
		const lib = ctx && ctx.lib;
		const get = ctx && ctx.get;

		const report = {
			scanned: 0,
			tagged: 0,
			matchedByProcessor: Object.create(null),
			skippedNoInfo: 0,
		};

		if (!lib || !store) return report;
		const entries = listSkillInfoEntriesForSkillIds(lib, get, Array.isArray(skillIds) ? skillIds : []);
		if (!entries.length) return report;
		return runOnEntries({ entries, processors: this.processors, store, report, ctx, logger: this.logger });
	}
}

/**
 * @param {{
 *  entries: Array<{skillId:string, infoKey:string, rawText:string, text:string}>,
 *  processors: SkillTagTextProcessor[],
 *  store: import("./store.js").SkillCustomTagStore,
 *  report: {scanned:number, tagged:number, matchedByProcessor:Record<string, number>, skippedNoInfo:number},
 *  ctx: SkillCustomTagContext,
 *  logger?: any,
 * }} args
 * @returns {{
 *  scanned: number,
 *  tagged: number,
 *  matchedByProcessor: Record<string, number>,
 *  skippedNoInfo: number,
 * }}
 */
function runOnEntries(args) {
	const entries = args && Array.isArray(args.entries) ? args.entries : [];
	const processors = args && Array.isArray(args.processors) ? args.processors : [];
	const store = args && args.store;
	const report = args && args.report ? args.report : null;
	const ctx = args && args.ctx ? args.ctx : null;
	const logger = args && args.logger ? args.logger : null;

	const lib = ctx && ctx.lib;
	const game = ctx && ctx.game;
	const ui = ctx && ctx.ui;
	const get = ctx && ctx.get;
	const ai = ctx && ctx.ai;
	const _status = ctx && ctx._status;
	const config = ctx && ctx.config;

	if (!report) {
		return {
			scanned: 0,
			tagged: 0,
			matchedByProcessor: Object.create(null),
			skippedNoInfo: 0,
		};
	}

	for (const entry of entries) {
		report.scanned++;
		let anyTag = false;

		/** @type {SkillTextProcessInput} */
		const input = {
			skillId: entry.skillId,
			infoKey: entry.infoKey,
			rawText: entry.rawText,
			text: entry.text,
			lib,
			game,
			ui,
			get,
			ai,
			_status,
			config,
		};

		if (!input.text) {
			report.skippedNoInfo++;
			continue;
		}

		for (const p of processors) {
			const pid = String(p && p.id ? p.id : "");
			if (!pid || !p || typeof p.process !== "function") continue;
			let tags = null;
			try {
				tags = p.process(input) || null;
			} catch (e) {
				try {
					logger && logger.warn && logger.warn("processor failed:", pid, entry.skillId, e);
				} catch (e2) {}
				continue;
			}
			if (!tags || typeof tags !== "object") continue;
			store.add(entry.skillId, tags);
			anyTag = true;
			report.matchedByProcessor[pid] = (report.matchedByProcessor[pid] || 0) + 1;
		}

		if (anyTag) report.tagged++;
	}

	return report;
}

/**
 * 枚举所有可用技能说明文本条目（来自 `lib.translate` 的 `<skillId>_info`）。
 *
 * @param {*} lib
 * @param {*} get
 * @returns {Array<{skillId:string, infoKey:string, rawText:string, text:string}>}
 */
export function listSkillInfoEntries(lib, get) {
	const out = [];
	const translate = lib && lib.translate;
	if (!translate || typeof translate !== "object") return out;

	const keys = Object.keys(translate);
	for (const k of keys) {
		if (!k || typeof k !== "string") continue;
		if (!k.endsWith("_info")) continue;
		const skillId = k.slice(0, -5);
		if (!skillId) continue;
		if (!lib.skill || !lib.skill[skillId]) continue;

		const rawText = resolveInfoTextByKey(translate, k, get);
		if (!rawText) {
			out.push({ skillId, infoKey: k, rawText: "", text: "" });
			continue;
		}
		out.push({ skillId, infoKey: k, rawText, text: normalizeInfoText(rawText) });
	}

	return out;
}

/**
 * 枚举指定技能集合的说明文本条目（来自 `lib.translate` 的 `<skillId>_info`）。
 *
 * @param {*} lib
 * @param {*} get
 * @param {string[]} skillIds
 * @returns {Array<{skillId:string, infoKey:string, rawText:string, text:string}>}
 */
export function listSkillInfoEntriesForSkillIds(lib, get, skillIds) {
	const out = [];
	const translate = lib && lib.translate;
	if (!translate || typeof translate !== "object") return out;

	const skills = lib && lib.skill;
	if (!skills || typeof skills !== "object") return out;

	/** @type {Record<string, 1>} */
	const seen = Object.create(null);
	const ids = Array.isArray(skillIds) ? skillIds : [];
	for (const rawId of ids) {
		const skillId = String(rawId || "");
		if (!skillId) continue;
		if (seen[skillId]) continue;
		seen[skillId] = 1;
		if (!skills[skillId]) continue;

		const infoKey = `${skillId}_info`;
		const rawText = resolveInfoTextByKey(translate, infoKey, get);
		if (!rawText) {
			out.push({ skillId, infoKey, rawText: "", text: "" });
			continue;
		}
		out.push({ skillId, infoKey, rawText, text: normalizeInfoText(rawText) });
	}

	return out;
}

/**
 * @param {*} translate
 * @param {string} key
 * @param {*} get
 * @returns {string}
 */
function resolveInfoTextByKey(translate, key, get) {
	const v = translate[key];
	if (typeof v === "string") return v;
	if (typeof v === "function") {
		try {
			const r = v();
			if (typeof r === "string") return r;
		} catch (e) {}
	}

	// 兜底：通过 get.translation 取（可能会返回 key 本身）
	if (get && typeof get.translation === "function") {
		try {
			const r = get.translation(key);
			if (typeof r === "string" && r && r !== key) return r;
		} catch (e) {}
	}
	return "";
}

/**
 * 归一化技能说明文本，便于正则匹配。
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeInfoText(raw) {
	let t = String(raw || "");
	if (!t) return "";
	t = t.replace(/\r\n/g, "\n");
	t = t.replace(/<br\s*\/?\s*>/gi, "\n");
	t = t.replace(/<[^>]+>/g, "");
	t = t.replace(/&nbsp;/gi, " ");
	t = t.replace(/\s+/g, " ").trim();
	return t;
}
