let originalThrowEmotion = null;

/**
 * 从 game 上取得 Hook Bus（若未启用对应事件则返回 null）。
 *
 * @param {*} game
 * @returns {import("./lib/jsdoc_types.js").SlqjAiHookBus|null}
 */
function getHooks(game) {
	const hooks = game?.__slqjAiPersona?.hooks || game?.slqjAiHooks;
	if (!hooks || typeof hooks.emit !== "function") return null;
	if (typeof hooks.has === "function" && !hooks.has("slqj_ai_emotion_throw")) return null;
	return hooks;
}

/**
 * 安装“投掷表情”事件：当任意玩家调用 `player.throwEmotion(target, emotion, rotate)` 时，
 * 通过 Hook Bus 发出 `slqj_ai_emotion_throw` 事件，供 scripts 插件/外部逻辑监听或拦截。
 *
 * 事件 ctx 字段（核心）：
 * - `from`: 发起者（Player）
 * - `target`: 目标（Player）
 * - `emotion`: 表情类型（如 "egg"/"flower"/"shoe"/"wine"）
 * - `rotate`: 是否旋转（引擎可选参数）
 * - `online`: 是否联机（game.online）
 * - `connectMode`: 是否联机连接模式（_status.connectMode）
 * - `cancel`: 设为 true 可阻止本次投掷（不调用原方法）
 *
 * 可通过 handler 修改 `target/emotion/rotate` 以影响最终投掷效果。
 *
 * @param {Object} opts
 * @param {*} opts.lib
 * @param {*} opts.game
 * @param {*} opts._status
 * @returns {void}
 */
export function installEmotionThrowEvent(opts) {
	const lib = opts ? opts.lib : null;
	const game = opts ? opts.game : null;
	const _status = opts ? opts._status : null;
	if (!lib || !game) return;
	if (_status && _status.connectMode) return;

	const root =
		game.__slqjAiPersona && typeof game.__slqjAiPersona === "object"
			? game.__slqjAiPersona
			: {};
	game.__slqjAiPersona = root;
	if (root.emotionThrowEventInstalled) return;

	const proto = lib?.element?.Player?.prototype;
	if (!proto || typeof proto.throwEmotion !== "function") return;
	if (originalThrowEmotion) return;

	originalThrowEmotion = proto.throwEmotion;
	proto.throwEmotion = function (target, emotion, rotate) {
		const hooks = getHooks(game);
		if (!hooks) return originalThrowEmotion.call(this, target, emotion, rotate);

		let ctx = {
			from: this,
			target,
			emotion,
			rotate,
			online: !!game?.online,
			connectMode: !!(_status && _status.connectMode),
			cancel: false,
		};

		try {
			const res = hooks.emit("slqj_ai_emotion_throw", ctx);
			if (res !== undefined) ctx = res;
		} catch (e) {}

		if (ctx && ctx.cancel === true) return;
		return originalThrowEmotion.call(this, ctx ? ctx.target : target, ctx ? ctx.emotion : emotion, ctx ? ctx.rotate : rotate);
	};

	root.emotionThrowEventInstalled = true;
}
