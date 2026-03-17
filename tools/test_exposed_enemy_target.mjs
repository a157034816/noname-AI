import { isExposedEnemyTarget } from "../src/ai_persona/lib/identity_utils.js";
import { STORAGE_KEY } from "../src/ai_persona/lib/constants.js";

function assertEq(actual, expected, label) {
	if (actual !== expected) {
		throw new Error(`[FAIL] ${label}: expected ${expected}, got ${actual}`);
	}
}

function makeObserver(identity) {
	return {
		playerid: "observer",
		identity,
		storage: {
			[STORAGE_KEY]: {
				memory: {
					zhuSignal: Object.create(null),
					zhuHelp: Object.create(null),
					zhuHarm: Object.create(null),
					evidence: Object.create(null),
					grudge: Object.create(null),
				},
			},
		},
	};
}

function makeTarget(pid, { identityShown = false, shown = 0, attitude = 0 } = {}) {
	return {
		playerid: pid,
		identityShown,
		// NOTE: guessIdentityFor 不读取暗身份；但 identityShown 场景下会读取并直接返回 target.identity
		identity: "fan",
		__att: attitude,
		ai: { shown },
	};
}

const get = {
	mode() {
		return "identity";
	},
	attitude(from, to) {
		return typeof to?.__att === "number" ? to.__att : 0;
	},
	itemtype(v) {
		return v && typeof v === "object" ? "player" : "";
	},
};

const game = { zhu: { playerid: "zhu" }, players: [] };

// 1) identityShown：仅依赖 attitude
{
	const player = makeObserver("zhu");
	const enemyShown = makeTarget("t1", { identityShown: true, shown: 0, attitude: -1 });
	const allyShown = makeTarget("t2", { identityShown: true, shown: 0, attitude: 1 });
	assertEq(isExposedEnemyTarget(player, enemyShown, game, get), true, "identityShown enemy");
	assertEq(isExposedEnemyTarget(player, allyShown, game, get), false, "identityShown ally");
}

// 2) 软暴露：shown>=0.7 且猜测明确（非 unknown）+ 置信度足够
{
	const player = makeObserver("zhu");
	const target = makeTarget("t3", { identityShown: false, shown: 0.75, attitude: 0 });
	player.storage[STORAGE_KEY].memory.zhuSignal[target.playerid] = -4;
	assertEq(isExposedEnemyTarget(player, target, game, get), true, "soft exposed with clear fan guess");
}

// 3) 软暴露但猜测 unknown：不算暴露
{
	const player = makeObserver("zhu");
	const target = makeTarget("t4", { identityShown: false, shown: 0.75, attitude: 0 });
	player.storage[STORAGE_KEY].memory.zhuSignal[target.playerid] = -0.1;
	assertEq(isExposedEnemyTarget(player, target, game, get), false, "soft exposed but guess unknown");
}

// 4) 猜测明确但未到软暴露阈值：不算暴露
{
	const player = makeObserver("zhu");
	const target = makeTarget("t5", { identityShown: false, shown: 0.65, attitude: 0 });
	player.storage[STORAGE_KEY].memory.zhuSignal[target.playerid] = -4;
	assertEq(isExposedEnemyTarget(player, target, game, get), false, "clear guess but shown<0.7");
}

// 5) 内奸：不做“暴露敌方”硬判定
{
	const player = makeObserver("nei");
	const target = makeTarget("t6", { identityShown: false, shown: 0.8, attitude: 0 });
	player.storage[STORAGE_KEY].memory.zhuSignal[target.playerid] = -4;
	assertEq(isExposedEnemyTarget(player, target, game, get), false, "nei always false");
}

console.log("[OK] isExposedEnemyTarget basic cases passed");

