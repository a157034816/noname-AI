import { STORAGE_KEY } from "../src/ai_persona/lib/constants.js";
import { addEvidence } from "../src/ai_persona/memory.js";
import { isAiPersonaTrackedPlayer } from "../src/ai_persona/lib/utils.js";

/**
 * @typedef {import("../src/scripts_loader.js").SlqjAiScriptContext} SlqjAiScriptContext
 */

/**
 * scripts 插件元信息（用于“脚本插件管理”UI 友好展示）。
 *
 * @type {{name:string, version:string, description:string}}
 */
export const slqjAiScriptMeta = {
	name: "明查非反好感补丁",
	version: "1.0.0",
	description:
		"补丁 identity_mingcha：当查到的不是反贼时，为本地 AI 观察者按身份给被查目标补一层正向证据，让后续敌友判断更容易吃到“非反”信息。",
};

/**
 * scripts 插件入口：给“明查”补非反证据。
 *
 * @param {SlqjAiScriptContext} ctx
 * @returns {void}
 */
export default function setup(ctx) {
	const { game, lib, get, _status } = ctx || {};
	if (!game || !lib) return;
	if (_status?.connectMode) return;

	const skill = lib?.skill?.identity_mingcha;
	if (!skill || typeof skill.content !== "function") return;

	const runtime = getOrCreateRuntime(game);
	if (!runtime || runtime.installed) return;
	runtime.installed = true;

	if (skill.content.__slqjAiPersonaMingchaWrapped) return;

	const original = skill.content;
	skill.content = async function patchedIdentityMingcha(event, trigger, player) {
		const target = trigger?.player;
		const shouldApply = shouldApplyNonFanBoost(get, target);
		try {
			return await original.apply(this, arguments);
		} finally {
			if (shouldApply) {
				applyNonFanBoost(game, _status, target);
			}
		}
	};
	skill.content.__slqjAiPersonaMingchaWrapped = true;
	skill.content.__slqjAiPersonaMingchaOriginal = original;
	runtime.originalContent = original;
}

/**
 * 获取（或创建）运行期对象。
 *
 * @param {*} game
 * @returns {{installed?:boolean,originalContent?:Function}|null}
 */
function getOrCreateRuntime(game) {
	if (!game) return null;
	try {
		game.__slqjAiPersona ??= Object.create(null);
	} catch (e) {
		return null;
	}
	const root = game.__slqjAiPersona;
	root.mingchaNonFanFavor ??= Object.create(null);
	return root.mingchaNonFanFavor;
}

/**
 * 是否应该在这次明查后补“非反”证据。
 *
 * @param {*} get
 * @param {*} target
 * @returns {boolean}
 */
function shouldApplyNonFanBoost(get, target) {
	if (!target) return false;
	try {
		if (typeof get?.mode !== "function") return false;
		if (get.mode() !== "identity") return false;
	} catch (e) {
		return false;
	}
	return String(target.identity || "") !== "fan";
}

/**
 * 为所有已接入本地 AI 的观察者，按身份给被明查目标写入正向证据。
 *
 * @param {*} game
 * @param {*} _status
 * @param {*} target
 * @returns {void}
 */
function applyNonFanBoost(game, _status, target) {
	if (!game || !target) return;
	const amount = getObserverWeightAmount;
	for (const observer of game.players || []) {
		if (observer === target) continue;
		if (!isAiPersonaTrackedPlayer(observer, game, _status)) continue;
		if (!observer.storage?.[STORAGE_KEY]?.persona) continue;
		const value = amount(observer);
		if (!(value > 0)) continue;
		addEvidence(observer, target, value);
	}
}

/**
 * 按观察者身份折算“明查非反”的正向证据增量。
 *
 * @param {*} observer
 * @returns {number}
 */
function getObserverWeightAmount(observer) {
	const identity = String(observer?.identity || "");
	if (identity === "zhu" || identity === "zhong" || identity === "mingzhong") return 1.0;
	if (identity === "fan") return 0.75;
	if (identity === "nei") return 0.35;
	return 0.25;
}
