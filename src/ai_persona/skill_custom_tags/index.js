/**
 * 核心：技能自定义 tag 补全（非 scripts 插件）。
 *
 * 目标：
 * - 注册多个处理器（processor），基于技能说明文本（正则匹配）推导自定义 tag
 * - 仅在“首轮开始前”对本局实际出现的技能做补全（避免全量扫描）
 * - 当武将变动/技能增减（addSkill）发生时，对新增技能做增量补全
 * - 集中维护 `skillId -> tags` 并写入 `lib.skill[skillId].ai`，供 `player.hasSkillTag(tag)` 读取
 *
 * @param {{lib:any, game:any, ui?:any, get:any, ai?:any, _status:any, config:any}} ctx
 * @returns {void}
 */

import { SkillCustomTagStore } from "./store.js";
import { SkillTagProcessorFramework } from "./framework.js";
import { createBuiltinSkillTagTextProcessors } from "./processors/index.js";
import { get as getLogger } from "../../logger/manager.js";

export function installSkillCustomTags(ctx) {
	const game = ctx && ctx.game;
	const lib = ctx && ctx.lib;
	if (!game || !lib) return;
	if (ctx?._status?.connectMode) return;

	const root = ensurePersonaRoot(game);
	if (root._skillCustomTagsInstalled) return;
	root._skillCustomTagsInstalled = true;

	const logger = createLogger(lib);
	const fw = new SkillTagProcessorFramework({ logger });
	for (const p of createBuiltinSkillTagTextProcessors()) fw.register(p);

	ensureRuntimeState(root);

	// runner：挂到 game.__slqjAiPersona 供 skill.content 与 hooks 调用
	root._runSkillCustomTagsForSkillIds = function (skillIds, reason) {
		try {
			runForSkillIds({ ctx, lib, root, fw, logger, skillIds, reason: String(reason || "") });
		} catch (e) {}
	};
	root._runSkillCustomTagsBootstrap = function () {
		try {
			const skillIds = collectCurrentGameSkillIds(ctx && ctx.game ? ctx.game : null);
			runForSkillIds({ ctx, lib, root, fw, logger, skillIds, reason: "bootstrap" });
		} catch (e) {}
	};

	installAddSkillHook({ lib, root });
	installBootstrapGlobalSkill({ lib, game });
}

/**
 * @param {*} game
 * @returns {Record<string, any>}
 */
function ensurePersonaRoot(game) {
	if (!game) return /** @type {any} */ ({});
	const root = game.__slqjAiPersona && typeof game.__slqjAiPersona === "object" ? game.__slqjAiPersona : {};
	game.__slqjAiPersona = root;
	return root;
}

/**
 * 确保 root 上的运行期状态容器存在。
 *
 * @param {Record<string, any>} root
 * @returns {void}
 */
function ensureRuntimeState(root) {
	if (!root || typeof root !== "object") return;
	if (!root.skillCustomTags || typeof root.skillCustomTags !== "object") root.skillCustomTags = Object.create(null);
	if (!root._skillCustomTagsProcessed || typeof root._skillCustomTagsProcessed !== "object") {
		root._skillCustomTagsProcessed = Object.create(null);
	}
}

/**
 * 增量补全：对指定 skillId 列表运行处理器并写回 `lib.skill[skillId].ai`。
 *
 * @param {{
 *  ctx:any,
 *  lib:any,
 *  root:Record<string, any>,
 *  fw:SkillTagProcessorFramework,
 *  logger: ReturnType<typeof createLogger>,
 *  skillIds:any[],
 *  reason:string,
 * }} args
 * @returns {void}
 */
function runForSkillIds(args) {
	const ctx = args && args.ctx;
	const lib = args && args.lib;
	const root = args && args.root;
	const fw = args && args.fw;
	const logger = args && args.logger;
	const reason = args && typeof args.reason === "string" ? args.reason : "";
	const skillIds = args && Array.isArray(args.skillIds) ? args.skillIds : [];

	if (!ctx || !lib || !root || !fw) return;
	ensureRuntimeState(root);

	const processed = root._skillCustomTagsProcessed;
	const skills = lib && lib.skill && typeof lib.skill === "object" ? lib.skill : null;
	if (!skills) return;
	const todo = [];
	for (const sid0 of skillIds) {
		const sid = String(sid0 || "");
		if (!sid) continue;
		if (processed[sid]) continue;
		if (!skills[sid]) continue;
		processed[sid] = 1; // 标记为已处理：即使没 info/没命中，也避免重复扫
		todo.push(sid);
	}
	if (!todo.length) return;

	const store = new SkillCustomTagStore();
	const scanReport = fw.runForSkillIds(ctx, store, todo);
	const report = store.applyToLib(lib, { overwrite: false });

	// 运行期可观测：记录到扩展根对象，便于调试/二次开发
	try {
		const delta = store.toJSON();
		for (const [sid, tags] of Object.entries(delta)) {
			root.skillCustomTags[sid] = tags;
		}
		root.skillCustomTagsScanReport = Object.assign({ reason }, scanReport);
		root.skillCustomTagsReport = Object.assign({ reason }, report);
	} catch (e) {}

	if (logger && logger.isVerbose) {
		logger.log(
			"runForSkillIds",
			"%s; scanned=%d tagged=%d applied=%d missing=%d skippedExisting=%d",
			reason || "run",
			scanReport.scanned,
			scanReport.tagged,
			report.applied.length,
			report.missingSkills.length,
			report.skippedExisting.length
		);
		if (report.missingSkills.length) {
			logger.warn("runForSkillIds", "missing skills:", report.missingSkills);
		}
	}
}

/**
 * 收集“本局实际存在”的技能集合（聚合所有玩家的 skills/hiddenSkills/invisibleSkills/...）。
 *
 * @param {*} game
 * @returns {string[]}
 */
function collectCurrentGameSkillIds(game) {
	const g = game && typeof game === "object" ? game : null;
	if (!g) return [];

	/** @type {Record<string, 1>} */
	const seen = Object.create(null);
	/** @type {string[]} */
	const out = [];

	/** @type {any[]} */
	const players = [];
	if (Array.isArray(g.players)) players.push.apply(players, g.players);
	if (Array.isArray(g.dead)) players.push.apply(players, g.dead);

	for (const p of players) {
		if (!p || typeof p.getSkills !== "function") continue;
		let skills = [];
		try {
			// arg2="invisible"：包含 hiddenSkills；arg3=false：不含装备；arg4=false：不过滤
			skills = p.getSkills("invisible", false, false) || [];
		} catch (e) {
			skills = [];
		}
		if (!Array.isArray(skills)) continue;
		for (const sid0 of skills) {
			const sid = String(sid0 || "");
			if (!sid) continue;
			if (seen[sid]) continue;
			seen[sid] = 1;
			out.push(sid);
		}
	}

	return out;
}

/**
 * 当技能增减发生时，对新增 skillId 增量补全。
 *
 * 依赖引擎钩子：`game.callHook(\"addSkillCheck\", [skill, player])`。
 *
 * @param {{lib:any, root:Record<string, any>}} args
 * @returns {void}
 */
function installAddSkillHook(args) {
	const lib = args && args.lib;
	const root = args && args.root;
	if (!lib || !root) return;
	if (!lib.hooks || !Array.isArray(lib.hooks.addSkillCheck)) return;
	if (root._skillCustomTagsAddSkillHookInstalled) return;
	root._skillCustomTagsAddSkillHookInstalled = true;

	/** @param {string} skill @param {*} player */
	const hook = function (skill, player) {
		try {
			const st = typeof _status !== "undefined" ? _status : globalThis?._status;
			if (st?.connectMode) return;
		} catch (e) {}
		try {
			if (root && typeof root._runSkillCustomTagsForSkillIds === "function") {
				root._runSkillCustomTagsForSkillIds([skill], "addSkill");
			}
		} catch (e) {}
	};

	lib.hooks.addSkillCheck.push(hook);
	root._skillCustomTagsAddSkillHook = hook;
}

/**
 * 首轮开始前补全：通过全局技能挂钩到 `gameStart`。
 *
 * 注意：skill.content 执行环境可能丢失模块闭包变量，因此 content 内仅通过
 * `game.__slqjAiPersona` 调用在安装时挂载的 runner。
 *
 * @param {{lib:any, game:any}} args
 * @returns {void}
 */
function installBootstrapGlobalSkill(args) {
	const lib = args && args.lib;
	const game = args && args.game;
	if (!lib || !game) return;

	const SKILL = "slqj_ai_skill_custom_tags_bootstrap";
	ensureSkill(lib, SKILL, {
		trigger: { global: "gameStart" },
		forced: true,
		silent: true,
		popup: false,
		priority: Infinity,
		filter(event, player) {
			const st = typeof _status !== "undefined" ? _status : globalThis?._status;
			if (st?.connectMode) return false;
			const g = typeof game !== "undefined" ? game : globalThis?.game;
			return !!(g && player === g.me && typeof g.__slqjAiPersona?._runSkillCustomTagsBootstrap === "function");
		},
		content() {
			try {
				const g = typeof game !== "undefined" ? game : globalThis?.game;
				const r = g?.__slqjAiPersona;
				if (r && typeof r._runSkillCustomTagsBootstrap === "function") r._runSkillCustomTagsBootstrap();
			} catch (e) {}
		},
	});

	try {
		if (typeof game.addGlobalSkill === "function") game.addGlobalSkill(SKILL);
	} catch (e) {}
}

/**
 * 确保 lib.skill[name] 存在（缺失则写入默认定义）。
 *
 * @param {*} lib
 * @param {string} name
 * @param {*} def
 * @returns {void}
 */
function ensureSkill(lib, name, def) {
	if (!lib || !lib.skill) return;
	if (!lib.skill[name]) lib.skill[name] = def;
}

/**
 * @param {*} lib
 * @returns {{isVerbose:boolean, log:(feature:any, ...args:any[])=>void, warn:(feature:any, ...args:any[])=>void, debug:(feature:any, ...args:any[])=>void}}
 */
function createLogger(lib) {
	const isVerbose = !!(lib && lib.config && lib.config.dev);
	const base = getLogger("console");

	const normalizeSubFeature = (f) => String(f == null ? "" : f).trim();

	const mergeArgs = (subFeature, args) => {
		const sf = normalizeSubFeature(subFeature);
		const rest = Array.isArray(args) ? args : [];
		if (!sf) return rest;
		if (!rest.length) return [`[${sf}]`];
		if (typeof rest[0] === "string") return [`[${sf}] ${rest[0]}`].concat(rest.slice(1));
		return [`[${sf}]`].concat(rest);
	};

	return {
		isVerbose,
		log: (feature, ...args) => base.log("skill_custom_tags", ...mergeArgs(feature, args)),
		warn: (feature, ...args) => base.warn("skill_custom_tags", ...mergeArgs(feature, args)),
		debug: (feature, ...args) => {
			if (!isVerbose) return;
			base.debug("skill_custom_tags", ...mergeArgs(feature, args));
		},
	};
}
