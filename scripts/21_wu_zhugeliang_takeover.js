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
	name: "武诸葛亮 AI 接管（情势/智哲）",
	version: "1.0.0",
	description:
		"接管武诸葛亮（wu_zhugeliang）AI 的关键决策：情势默认优先加伤、谨慎发牌/摸牌（减少消耗牌堆7点）；智哲更偏向复制无懈/桃等关键牌并兼顾后续触发情势。",
};

/**
 * 默认策略参数（可在脚本内调整）。
 *
 * @type {{hookPriority:number, onlyLocalAi:boolean, affectManagedMe:boolean, debug:boolean}}
 */
const DEFAULT_CFG = {
	hookPriority: 1,
	onlyLocalAi: true,
	affectManagedMe: true,
	debug: false,
};

const WUZGL_KEYS = new Set(["wu_zhugeliang"]);
const WUZGL_SKILLS = new Set(["dcjincui", "dcqingshi", "dczhizhe"]);

/**
 * scripts 插件入口：安装武诸葛亮接管逻辑。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setup(ctx) {
	const { game, hooks, _status, lib } = ctx || {};
	if (!game || !hooks || !lib) return;
	if (_status?.connectMode) return;

	const runtime = getOrCreateRuntime(game);
	if (!runtime) return;
	if (runtime.installed) return;

	runtime.installed = true;
	runtime.cfg = { ...DEFAULT_CFG };
	runtime._status = _status || null;

	try {
		runtime.cfg.debug =
			runtime.cfg.debug === true ||
			!!lib?.config?.dev ||
			globalThis.__slqjAiWuZhugeliangTakeoverDebug === true;
	} catch (e) {}

	const logger = createLogger(lib, runtime);
	logger.info("installed", { onlyLocalAi: !!runtime.cfg?.onlyLocalAi, debug: logger.isDebug() });

	tryInstallQingshiPatch({ game, lib, runtime, logger });
	tryInstallZhizhePatch({ game, lib, runtime, logger });
}

/**
 * @param {*} game
 * @returns {{installed?:boolean,cfg:any,_status:any,patched?:Record<string, boolean>}|null}
 */
function getOrCreateRuntime(game) {
	if (!game) return null;
	try {
		game.__slqjAiPersona ??= Object.create(null);
	} catch (e) {
		return null;
	}
	const root = game.__slqjAiPersona;
	root.wuZhugeliangTakeover ??= Object.create(null);
	const rt = root.wuZhugeliangTakeover;
	if (!rt.patched || typeof rt.patched !== "object") rt.patched = Object.create(null);
	return rt;
}

/**
 * 创建脚本日志器（默认仅少量日志；详细日志需开启 debug）。
 *
 * @param {*} lib
 * @param {*} runtime
 * @returns {{info:(...args:any[])=>void, warn:(...args:any[])=>void, debug:(...args:any[])=>void, isDebug:()=>boolean}}
 */
function createLogger(lib, runtime) {
	const prefix = "[身临其境的AI][wu_zhugeliang_takeover]";
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
			if (globalThis.__slqjAiWuZhugeliangTakeoverDebug === true) return true;
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
 * 判断是否为武诸葛亮（wu_zhugeliang），兼容双将/别名/技能识别。
 *
 * @param {*} player
 * @returns {boolean}
 */
function isWuZhugeliangPlayer(player) {
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
		if (WUZGL_KEYS.has(n)) return true;
	}
	try {
		if (typeof player.hasSkill === "function") {
			for (const s of WUZGL_SKILLS) {
				if (player.hasSkill(s)) return true;
			}
		}
	} catch (e) {}
	return false;
}

/**
 * 是否应该对该玩家应用“接管”逻辑（默认仅本地 AI，不影响人类玩家手操）。
 *
 * @param {*} player
 * @param {*} game
 * @param {*} runtime
 * @param {*} _status
 * @returns {boolean}
 */
function shouldAffectPlayer(player, game, runtime, _status) {
	if (!player) return false;
	if (!isWuZhugeliangPlayer(player)) return false;

	// 玩家本人（game.me）：默认不影响手操；仅在“托管”时允许接管（可通过 affectManagedMe 关闭）。
	if (player === game?.me) {
		if (!runtime?.cfg?.affectManagedMe) return false;
		const st = _status || runtime?._status || globalThis._status;
		if (!isLocalAIPlayer(player, game, st)) return false;
		return true;
	}

	if (runtime?.cfg?.onlyLocalAi) {
		const st = _status || runtime?._status || globalThis._status;
		if (!isLocalAIPlayer(player, game, st)) return false;
	}
	return true;
}

/**
 * 尝试安装“情势”接管：仅改 AI 选项逻辑，不改技能效果。
 *
 * @param {{game:any, lib:any, runtime:any, logger:any}} opts
 * @returns {void}
 */
function tryInstallQingshiPatch({ game, lib, runtime, logger }) {
	if (!lib?.skill?.dcqingshi) return;
	if (runtime?.patched?.qingshi) return;

	const original = lib.skill.dcqingshi.content;
	if (typeof original !== "function") return;

	/**
	 * 武诸葛亮“情势”默认决策：
	 * - 优先加伤（不消耗牌堆资源）
	 * - 谨慎选发牌/摸牌（会加速消耗牌堆 7 点，从而压低后续尽瘁体力值）
	 *
	 * @returns {void}
	 */
	function patchedQingshiContent() {
		"step 0";
		/** @type {any[]} */
		var choices = [];
		var choiceList = [
			"令" + get.translation(trigger.card) + "对其中一个目标角色造成的伤害+1",
			"令任意名其他角色各摸一张牌",
			"摸三张牌，然后〖情势〗于本回合失效",
		];
		if (trigger.targets && trigger.targets.length) {
			choices.push("选项一");
		} else {
			choiceList[0] = '<span style="opacity:0.5">' + choiceList[0] + "(无目标角色)</span>";
		}
		if (game.countPlayer(i => i != player)) {
			choices.push("选项二");
		} else {
			choiceList[1] = '<span style="opacity:0.5">' + choiceList[1] + "</span>";
		}
		choices.push("选项三");

		const takeOver = shouldAffectPlayer(player, game, runtime, _status);
		const choice = takeOver
			? decideQingshiChoiceTakeover({ game, player, trigger, choices })
			: decideQingshiChoiceOriginal({ game, player, trigger, choices });

		try {
			if (takeOver && logger?.isDebug?.()) {
				const cardName = String(get.name(trigger?.card, player) || trigger?.card?.name || "");
				const cardTrans = String(get.translation?.(trigger?.card) || "");
				const hand = typeof player?.countCards === "function" ? player.countCards("h") : null;
				const futureNames = countFutureQingshiNames(player);
				let friendCount = null;
				try {
					friendCount = game.countPlayer(function (current) {
						return current !== player && get.attitude(player, current) > 0;
					});
				} catch (e) {}
				let enemyTargets = null;
				try {
					const targets = Array.isArray(trigger?.targets) ? trigger.targets : [];
					enemyTargets = targets.filter(t => get.attitude(player, t) < 0).length;
				} catch (e) {}
				logger.debug("dcqingshi.decide", {
					player: String(get.translation?.(player) || player?.name || ""),
					card: cardTrans || cardName,
					cardName,
					choices: Array.isArray(choices) ? choices.slice() : [],
					choice,
					hand,
					friendCount,
					enemyTargets,
					futureNames,
				});
			}
		} catch (e) {}

		player
			.chooseControl(choices, "cancel2")
			.set("choiceList", choiceList)
			.set("prompt", get.prompt("dcqingshi"))
			.set("ai", () => {
				return _status.event.choice;
			})
			.set("choice", choice);
		"step 1";
		if (result.control != "cancel2") {
			player.logSkill("dcqingshi");
			game.log(player, "选择了", "#y" + result.control);
			var index = ["选项一", "选项二", "选项三"].indexOf(result.control) + 1;
			player.addTempSkill("dcqingshi_clear");
			player.markAuto("dcqingshi_clear", [trigger.card.name]);
			var next = game.createEvent("dcqingshi_after");
			next.player = player;
			next.card = trigger.card;
			next.setContent(lib.skill.dcqingshi["content" + index]);
		}
	}

	lib.skill.dcqingshi.content = patchedQingshiContent;
	runtime.patched.qingshi = true;
	try {
		logger?.info?.("patched", "dcqingshi.content");
	} catch (e) {}
}

/**
 * “情势”原始 AI 选项逻辑（从引擎实现复刻，用于非接管场景保持行为一致）。
 *
 * @param {{game:any, player:any, trigger:any, choices:string[]}} env
 * @returns {string}
 */
function decideQingshiChoiceOriginal(env) {
	const { game, player, trigger } = env || {};
	const choices = Array.isArray(env?.choices) ? env.choices.slice() : [];

	var choicesx = choices.slice();
	var cards = player.getCards("hs");
	var bool1 =
		get.tag(trigger.card, "damage") &&
		choicesx.includes("选项一") &&
		trigger.targets.some(current => {
			return get.attitude(player, current) < 0;
		});
	var bool2 = choicesx.includes("选项二");
	if (bool2) {
		bool2 = game.countPlayer(function (current) {
			return player != current && get.attitude(player, current) > 0;
		});
	} else {
		bool2 = 0;
	}
	if (bool1 || bool2) {
		for (var i = 0; i < cards.length; i++) {
			var name = get.name(cards[i]);
			if (player.getStorage("dcqingshi_clear").includes(name)) {
				continue;
			}
			for (var j = i + 1; j < cards.length; j++) {
				if (
					name === get.name(cards[j]) &&
					get.position(cards[i]) + get.position(cards[j]) !== "ss" &&
					player.hasValueTarget(cards[i])
				) {
					choicesx.remove("选项三");
					break;
				}
			}
		}
	}
	if (bool2 > 2) {
		return "选项二";
	}
	if (choicesx.includes("选项三")) {
		return "选项三";
	}
	if (bool2 === 2) {
		return "选项二";
	}
	if (bool1) {
		return "选项一";
	}
	if (bool2) {
		return "选项二";
	}
	return "cancel2";
}

/**
 * “情势”接管 AI 选项逻辑（更贴近武诸葛亮的资源观：优先加伤、谨慎消耗牌堆 7 点）。
 *
 * 决策原则（启发式）：
 * 1) 若当前牌为伤害牌且存在敌对目标：优先“选项一”（加伤，不额外摸牌）。
 * 2) “选项二/三”会导致牌堆被过牌（包括他人摸牌），从而更快消耗点数 7，通常不划算。
 * 3) 仅在手牌紧缺/局势需要时才考虑“选项三”（自摸三），并且避免在仍有多个可触发情势的牌名时关闭情势。
 *
 * @param {{game:any, player:any, trigger:any, choices:string[]}} env
 * @returns {string}
 */
function decideQingshiChoiceTakeover(env) {
	const { game, player, trigger } = env || {};
	const choices = Array.isArray(env?.choices) ? env.choices.slice() : [];
	const card = trigger?.card;

	const has1 = choices.includes("选项一");
	const has2 = choices.includes("选项二");
	const has3 = choices.includes("选项三");

	if (has1 && card && get.tag(card, "damage")) {
		try {
			const targets = Array.isArray(trigger?.targets) ? trigger.targets : [];
			if (targets.some(t => get.attitude(player, t) < 0)) return "选项一";
		} catch (e) {}
	}

	// 发牌仅在“明确有多名友方且你自己资源充足”时考虑（默认更保守，避免把 7 点从牌堆里刷掉）。
	if (has2) {
		try {
			const friendCount = game.countPlayer(function (current) {
				return current !== player && get.attitude(player, current) > 0;
			});
			const hand = typeof player?.countCards === "function" ? player.countCards("h") : 0;
			if (friendCount >= 3 && hand >= 6) return "选项二";
		} catch (e) {}
	}

	if (has3) {
		try {
			const hand = typeof player?.countCards === "function" ? player.countCards("h") : 0;
			// 牌少且本回合后续可触发的“情势牌名”不多时，才考虑自摸三。
			if (hand <= 2 && countFutureQingshiNames(player) <= 1) return "选项三";
		} catch (e) {}
	}

	return "cancel2";
}

/**
 * 统计“本回合还可能触发情势的牌名数量”（启发式：手牌中出现>=2且本回合未触发过）。
 *
 * @param {*} player
 * @returns {number}
 */
function countFutureQingshiNames(player) {
	if (!player || typeof player.getCards !== "function") return 0;
	const used = player.getStorage ? player.getStorage("dcqingshi_clear") : [];
	const usedSet = new Set(Array.isArray(used) ? used.map(String) : []);
	const cards = player.getCards("h") || [];
	/** @type {Record<string, number>} */
	const cnt = Object.create(null);
	for (const c of cards) {
		const name = String(get.name(c) || "");
		if (!name) continue;
		if (usedSet.has(name)) continue;
		cnt[name] = (cnt[name] || 0) + 1;
	}
	let n = 0;
	for (const k in cnt) if (cnt[k] >= 2) n++;
	return n;
}

/**
 * 尝试安装“智哲”接管：仅改 AI 选牌 check（更偏向复制关键牌），不改技能效果。
 *
 * @param {{game:any, lib:any, runtime:any, logger:any}} opts
 * @returns {void}
 */
function tryInstallZhizhePatch({ game, lib, runtime, logger }) {
	if (!lib?.skill?.dczhizhe) return;
	if (runtime?.patched?.zhizhe) return;

	const original = lib.skill.dczhizhe.check;
	if (typeof original !== "function") return;

	/**
	 * @param {*} card
	 * @returns {number}
	 */
	function patchedZhizheCheck(card) {
		let base = 0;
		try {
			base = original(card);
		} catch (e) {
			base = 0;
		}

		const st = globalThis._status;
		const p = st?.event?.player;
		if (!shouldAffectPlayer(p, game, runtime, st)) return base;

		const name = String(get.name(card, p) || "");
		if (!name) return base;
		const before = base;

		// 关键牌：优先复制（不消耗牌堆资源，且能作为后续情势的“同名牌”支点）。
		if (name === "wuxie") base += 6;
		else if (name === "tao") base += p?.hp != null && p.hp <= 3 ? 5 : 3;
		else if (name === "shan") base += p?.hp != null && p.hp <= 2 ? 2.5 : 1.2;
		else if (name === "jiu") base += p?.hp != null && p.hp <= 3 ? 1.8 : 0.8;

		// 常见高价值进攻/控制：适度加权（更贴近“加伤为主”的打法）。
		if (["sha", "juedou", "huogong", "shunshou", "guohe"].includes(name)) base += 1.4;

		// 若该牌名当前手里没有“同名备份”，复制后可作为情势触发的“同名牌”支点，略微加成。
		try {
			if (typeof p?.countCards === "function") {
				const count = p.countCards("h", c => get.name(c, p) === name);
				const used = p.getStorage ? p.getStorage("dcqingshi_clear") : [];
				const usedSet = new Set(Array.isArray(used) ? used.map(String) : []);
				if (count === 1 && !usedSet.has(name) && p.hasSkill?.("dcqingshi")) base += 0.9;
			}
		} catch (e) {}

		try {
			const delta = base - before;
			if (delta && logger?.isDebug?.()) {
				// check 可能被频繁调用：仅在评分发生明显变化时记录。
				if (delta >= 2 || ["wuxie", "tao"].includes(name)) {
					logger.debug("dczhizhe.weight", {
						player: String(get.translation?.(p) || p?.name || ""),
						card: name,
						before,
						after: base,
						delta,
					});
				}
			}
		} catch (e) {}

		return base;
	}

	lib.skill.dczhizhe.check = patchedZhizheCheck;
	runtime.patched.zhizhe = true;
	try {
		logger?.info?.("patched", "dczhizhe.check");
	} catch (e) {}
}
