import { STORAGE_KEY } from "./lib/constants.js";
import { clamp, getPid, isLocalAIPlayer } from "./lib/utils.js";

const SIGNAL_THRESHOLD = 1.2;
const SOFT_EXPOSE_THRESHOLD = 0.7;
const FAN_CANDIDATE_CONFIDENCE = 0.65;
const SOFT_ASSIGN_CONFIDENCE = 0.6;

/**
 * @typedef {import("./lib/jsdoc_types.js").IdentityId} IdentityId
 * @typedef {import("./lib/jsdoc_types.js").SlqjAiMemory} SlqjAiMemory
 * @typedef {IdentityId | string} IdentityLike
 * @typedef {{disableSoftAssign?: boolean}} GuessIdentityOptions
 */

/**
 * @param {*} observer
 * @returns {SlqjAiMemory|null}
 */
function getMemory(observer) {
  return observer && observer.storage ? observer.storage[STORAGE_KEY]?.memory : null;
}

/**
 * 归一化猜测参数。
 *
 * @param {GuessIdentityOptions|any} [opts]
 * @returns {{disableSoftAssign: boolean}}
 */
function normalizeGuessOptions(opts) {
  if (!opts || typeof opts !== "object") return { disableSoftAssign: false };
  return { disableSoftAssign: !!opts.disableSoftAssign };
}

/**
 * @param {*} player
 * @returns {number}
 */
function getAiShown(player) {
  return player && player.ai && typeof player.ai.shown === "number" ? player.ai.shown : 0;
}

/**
 * @param {*} player
 * @returns {boolean}
 */
function isAlive(player) {
  if (!player) return false;
  if (typeof player.isDead === "function") return !player.isDead();
  return true;
}

/**
 * 基于可公开信息直接确定身份（不做猜测）。
 *
 * @param {*} target
 * @param {*} game
 * @returns {{identity: IdentityLike, confidence: number}|null}
 */
function resolveBaseIdentity(target, game) {
  if (game && game.zhu && target === game.zhu) return { identity: "zhu", confidence: 1 };
  if (target && target.identityShown) return { identity: String(target.identity || "unknown"), confidence: 1 };
  return null;
}

/**
 * 获取本局“所有玩家”（含死亡），并按 pid 去重。
 *
 * 说明：
 * - 无名杀中死亡玩家通常会从 `game.players` 移到 `game.dead`；仅用 `game.players.length` 会在中后期缩小
 * - 这里合并两者，避免“预期反贼数/观察者集合”随对局推进发生漂移
 *
 * @param {*} game
 * @returns {Array<any>}
 */
function getAllPlayers(game) {
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();

  const lists = [game?.players, game?.dead];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!p) continue;
      const pid = String(getPid(p));
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(p);
    }
  }
  return out;
}

/**
 * 获取“可用观察者”（已初始化 persona/memory 的本地 AI）。
 *
 * @param {*} game
 * @returns {Array<any>}
 */
function getObservers(game) {
  const players = getAllPlayers(game);
  const st = globalThis?._status;
  return players.filter(p => {
    if (!p || !p.storage) return false;
    if (!p.storage[STORAGE_KEY]?.persona || !p.storage[STORAGE_KEY]?.memory) return false;
    return isLocalAIPlayer(p, game, st);
  });
}

/**
 * 估算“身份局反贼人数”（用于软赋予身份的保守门槛）。
 *
 * 说明：
 * - 优先读取 `game.__slqjAiPersona.cfg.identityCounts.fan`（来自房间配置的身份牌堆构成，公开信息）
 * - 身份局存在房规/变体，人数分布并非总是固定；这里仅做保守启发式，宁可不触发也不要过早触发。
 * - 经典身份局常见分布（仅作参考）：\n
 *   - 4 人：1 反\n
 *   - 5-6 人：2 反\n
 *   - 7 人：3 反\n
 *   - 8 人：4 反\n
 *
 * @param {*} game
 * @returns {number}
 */
function estimateExpectedFanCount(game) {
  const publicFan = game?.__slqjAiPersona?.cfg?.identityCounts?.fan;

  // 兜底 1：直接按“本局真实身份”统计反贼人数（仅用于数量门槛，不用于推断“谁是谁”）。
  // 这能覆盖房规/变体导致的身份牌堆构成缺失或不一致，并避免中后期存活人数变化带来的误判。
  const allPlayers = getAllPlayers(game);
  let sawIdentity = false;
  let fan = 0;
  for (const p of allPlayers) {
    const id = String(p?.identity || "");
    if (!id) continue;
    if (["zhu", "zhong", "mingzhong", "fan", "nei"].includes(id)) sawIdentity = true;
    if (id === "fan") fan++;
  }
  if (sawIdentity) return fan;

  // 兜底 1.5：读取“身份牌堆构成”（公开信息）。真实身份不可读时，使用该值尽量接近房规/规则分布。
  if (typeof publicFan === "number" && !Number.isNaN(publicFan) && publicFan >= 0) return publicFan;

  // 兜底 2：经典身份局启发式（保守）。
  const n = allPlayers.length;
  if (n <= 0) return 0;
  if (n <= 4) return 1;
  if (n <= 6) return 2;
  if (n === 7) return 3;
  // 身份局常见上限为 8；更大人数时仍按 4 保守处理（避免过早触发）
  return 4;
}

/**
 * 计算“反贼候选已全部暴露 -> 剩余未知视为友军”的触发状态（AI 视角）。
 *
 * @param {*} game
 * @returns {{enabled:boolean, exposedFan:number, hiddenFan:number, expectedFan:number}}
 */
function computeSoftAssignState(game) {
  if (!game || !game.zhu) return { enabled: false, exposedFan: 0, hiddenFan: 0, expectedFan: 0 };
  const observers = getObservers(game);
  if (!observers.length) return { enabled: false, exposedFan: 0, hiddenFan: 0, expectedFan: 0 };

  const players = getAllPlayers(game);
  let exposedFan = 0;
  let hiddenFan = 0;
  const expectedFan = estimateExpectedFanCount(game);

  for (const p of players) {
    if (!p) continue;

    const pid = String(p.identity || "");
    if (p.identityShown && pid === "fan") {
      exposedFan++;
      continue;
    }
    if (!isAlive(p)) continue;

    const raw = guessIdentityConsensus(p, game, { disableSoftAssign: true });
    const id = String(raw?.identity || "unknown");
    const conf = typeof raw?.confidence === "number" ? raw.confidence : 0;
    const isFanCandidate = id === "fan" && conf >= FAN_CANDIDATE_CONFIDENCE;
    if (!isFanCandidate) continue;

    const shown = getAiShown(p);
    if (p.identityShown || shown >= SOFT_EXPOSE_THRESHOLD) exposedFan++;
    else hiddenFan++;
  }

  // 关键：需要达到“预期反贼数”的暴露门槛，否则很容易出现“仅 1 反暴露就把所有 unknown 当忠”的误判。
  return { enabled: expectedFan > 0 && exposedFan >= expectedFan && hiddenFan === 0, exposedFan, hiddenFan, expectedFan };
}

/**
 * @param {*} target
 * @param {*} game
 * @returns {boolean}
 */
function isRawFanCandidate(target, game) {
  const raw = guessIdentityConsensus(target, game, { disableSoftAssign: true });
  const id = String(raw?.identity || "unknown");
  const conf = typeof raw?.confidence === "number" ? raw.confidence : 0;
  return id === "fan" && conf >= FAN_CANDIDATE_CONFIDENCE;
}

/**
 * 在“反贼候选都已暴露”的局面下，将剩余 unknown 软赋予为忠臣（仅扩展推断，不改真实身份）。
 *
 * @param {*} target
 * @param {*} game
 * @returns {{identity: IdentityLike, confidence: number, reason: string, detail: Object}|null}
 */
function getSoftAssignedIdentity(target, game) {
  const state = computeSoftAssignState(game);
  if (!state.enabled) return null;

  // 避免把“可能是反贼”的目标当作友军
  if (isRawFanCandidate(target, game)) return null;

  // 仅在“原始共识推断（禁用软赋予）为 unknown”时才软赋予，避免覆盖已有强线索（如内奸/偏忠/偏反）
  const raw = guessIdentityConsensus(target, game, { disableSoftAssign: true });
  if (String(raw?.identity || "unknown") !== "unknown") return null;

  return {
    identity: "zhong",
    confidence: SOFT_ASSIGN_CONFIDENCE,
    reason: "soft_assigned_remaining_allies",
    detail: {
      exposedFan: state.exposedFan,
      hiddenFan: state.hiddenFan,
      expectedFan: state.expectedFan,
      fanCandidateConfidence: FAN_CANDIDATE_CONFIDENCE,
      softExposeThreshold: SOFT_EXPOSE_THRESHOLD,
      threshold: SIGNAL_THRESHOLD,
    },
  };
}

/**
 * 将 evidence 转换为“主公阵营轴”（+更像忠，-更像反）。
 *
 * 注意：evidence 是“对观察者有利/不利”的主观证据：
 * - 对忠方（含主公）而言：正更像友军，负更像敌军
 * - 对反方而言：正更像友军（反方），负更像敌军（忠方）
 *
 * 因此在“主公阵营轴”上，反方需要翻转符号。
 *
 * @param {string} observerIdentity
 * @param {number} evidence
 * @returns {number}
 */
function toZhuAxisByEvidence(observerIdentity, evidence) {
  if (typeof evidence !== "number" || Number.isNaN(evidence) || !evidence) return 0;
  if (observerIdentity === "fan") return -evidence;
  return evidence;
}

/**
 * 在 zhuSignal 与 evidenceAxis 中选择更强的“主公阵营倾向轴”（避免同一事件双计数）。
 *
 * @param {number} zhuSignal
 * @param {number} evidenceAxis
 * @returns {{axis:number, source:"zhuSignal"|"evidence"}}
 */
function pickStrongerZhuAxis(zhuSignal, evidenceAxis) {
  const s = typeof zhuSignal === "number" && !Number.isNaN(zhuSignal) ? zhuSignal : 0;
  const e = typeof evidenceAxis === "number" && !Number.isNaN(evidenceAxis) ? evidenceAxis : 0;
  if (Math.abs(e) > Math.abs(s)) return { axis: e, source: "evidence" };
  return { axis: s, source: "zhuSignal" };
}

/**
 * 将“记仇(grudge)”转为“确信度增强”（只增强幅度，不提供方向）。
 *
 * @param {number} grudge
 * @returns {number}
 */
function getGrudgeBoost(grudge) {
  if (typeof grudge !== "number" || Number.isNaN(grudge) || grudge <= 0) return 0;
  return clamp(grudge * 0.25, 0, 0.8);
}

/**
 * 根据观察者的心智模型，对目标做“独立身份猜测”（不读取真实身份）。
 *
 * @param {*} observer
 * @param {*} target
 * @param {*} game
 * @param {GuessIdentityOptions} [opts]
 * @returns {{identity: IdentityLike, confidence: number, reason?: string, detail?: Object|null}}
 */
function guessIdentityForDetailed(observer, target, game, opts) {
  const options = normalizeGuessOptions(opts);
  const fixed = resolveBaseIdentity(target, game);
  if (fixed) {
    const reason = target === game?.zhu ? "fixed_zhu" : "fixed_shown";
    return { identity: fixed.identity, confidence: fixed.confidence, reason, detail: null };
  }

  const mem = getMemory(observer);
  if (!mem) return { identity: "unknown", confidence: 0, reason: "no_memory", detail: null };

  const pid = getPid(target);
  const s = (mem.zhuSignal && mem.zhuSignal[pid]) || 0;
  const help = (mem.zhuHelp && mem.zhuHelp[pid]) || 0;
  const harm = (mem.zhuHarm && mem.zhuHarm[pid]) || 0;
  const evidence = (mem.evidence && mem.evidence[pid]) || 0;
  const grudge = (mem.grudge && mem.grudge[pid]) || 0;

  // 软暴露：加权提升“确信度”（但不直接泄露真实身份）
  const shown = getAiShown(target);
  const weight = shown >= 0.85 ? 1.25 : shown >= 0.7 ? 1.1 : 1;

  // “主公阵营轴”信号：优先采用更强的来源（避免同一事件双计数）
  const observerId = String(observer?.identity || "");
  const evidenceAxis = toZhuAxisByEvidence(observerId, evidence);
  const picked = pickStrongerZhuAxis(s, evidenceAxis);
  const axis = picked.axis;
  const axisSource = picked.source;
  const absAxis = Math.abs(axis) * weight;

  // 记仇增强：当方向已存在但略低于阈值时，用 grudge 轻推一把，减少“全体弃权→unknown”
  const grudgeBoost = axis !== 0 && absAxis < SIGNAL_THRESHOLD ? getGrudgeBoost(grudge) : 0;
  const absEffective = absAxis + grudgeBoost;

  // 内奸：同时明显“帮过主公”也“打过主公”，更像两边摇摆/自利
  if (help >= 1.8 && harm >= 1.8) {
    return {
      identity: "nei",
      confidence: clamp(Math.min(help, harm) / 4, 0, 1),
      reason: "nei_both_help_harm",
      detail: {
        s,
        evidence,
        evidenceAxis,
        axis,
        axisSource,
        absAxis,
        absEffective,
        grudge,
        grudgeBoost,
        help,
        harm,
        threshold: SIGNAL_THRESHOLD,
        shown,
        weight,
      },
    };
  }

  // 不足以判断
  if (absEffective < SIGNAL_THRESHOLD) {
    if (!options.disableSoftAssign) {
      const soft = getSoftAssignedIdentity(target, game);
      if (soft) {
        return {
          identity: soft.identity,
          confidence: soft.confidence,
          reason: soft.reason,
          detail: {
            s,
            evidence,
            evidenceAxis,
            axis,
            axisSource,
            absAxis,
            absEffective,
            grudge,
            grudgeBoost,
            help,
            harm,
            threshold: SIGNAL_THRESHOLD,
            shown,
            weight,
            softAssign: soft.detail,
          },
        };
      }
    }
    return {
      identity: "unknown",
      confidence: clamp(absEffective / SIGNAL_THRESHOLD, 0, 1) * 0.4,
      reason: "insufficient_signal",
      detail: {
        s,
        evidence,
        evidenceAxis,
        axis,
        axisSource,
        absAxis,
        absEffective,
        grudge,
        grudgeBoost,
        help,
        harm,
        threshold: SIGNAL_THRESHOLD,
        shown,
        weight,
      },
    };
  }

  if (axis > 0) {
    return {
      identity: "zhong",
      confidence: clamp(absEffective / 6, 0, 1),
      reason: "signal_positive",
      detail: {
        s,
        evidence,
        evidenceAxis,
        axis,
        axisSource,
        absAxis,
        absEffective,
        grudge,
        grudgeBoost,
        help,
        harm,
        threshold: SIGNAL_THRESHOLD,
        shown,
        weight,
      },
    };
  }
  return {
    identity: "fan",
    confidence: clamp(absEffective / 6, 0, 1),
    reason: "signal_negative",
    detail: {
      s,
      evidence,
      evidenceAxis,
      axis,
      axisSource,
      absAxis,
      absEffective,
      grudge,
      grudgeBoost,
      help,
      harm,
      threshold: SIGNAL_THRESHOLD,
      shown,
      weight,
    },
  };
}

/**
 * 根据观察者的心智模型，对目标做“独立身份猜测”（不读取真实身份）。
 *
 * @param {*} observer
 * @param {*} target
 * @param {*} game
 * @param {GuessIdentityOptions} [opts]
 * @returns {{identity: IdentityLike, confidence: number}}
 */
export function guessIdentityFor(observer, target, game, opts) {
  const r = guessIdentityForDetailed(observer, target, game, opts);
  return { identity: r.identity, confidence: r.confidence };
}

/**
 * `guessIdentityFor` 的可解释版本：附带 `reason` 与 `detail`，用于 UI 说明/调试。
 *
 * @param {*} observer
 * @param {*} target
 * @param {*} game
 * @param {GuessIdentityOptions} [opts]
 * @returns {{identity: IdentityLike, confidence: number, reason?: string, detail?: Object|null}}
 */
export function explainGuessIdentityFor(observer, target, game, opts) {
  return guessIdentityForDetailed(observer, target, game, opts);
}

/**
 * 用“已初始化的本地 AI 集合”做共识推断，用于展示“被AI系统猜测为xx”。
 *
 * 约定：
 * - `unknown` 表示“线索不足/弃权”，不作为候选身份参与投票
 * - 若无任何有效投票，则返回 `unknown`
 *
 * @param {*} target
 * @param {*} game
 * @param {GuessIdentityOptions} [opts]
 * @returns {{identity: IdentityLike, confidence: number}}
 */
export function guessIdentityConsensus(target, game, opts) {
  const options = normalizeGuessOptions(opts);
  const fixed = resolveBaseIdentity(target, game);
  if (fixed) return fixed;

  if (!options.disableSoftAssign) {
    const soft = getSoftAssignedIdentity(target, game);
    if (soft) return { identity: soft.identity, confidence: soft.confidence };
  }

  const observers = getObservers(game);
  if (!observers.length) return { identity: "unknown", confidence: 0 };

  const score = Object.create(null);
  let total = 0;
  let votes = 0;

  for (const ob of observers) {
    if (ob === target) continue;
    const g = guessIdentityFor(ob, target, game, options);
    const id = String(g?.identity || "unknown");
    const w = typeof g.confidence === "number" ? clamp(g.confidence, 0, 1) : 0.2;
    if (id === "unknown" || w <= 0) continue;
    score[id] = (score[id] || 0) + w;
    total += w;
    votes++;
  }

  if (!votes) return { identity: "unknown", confidence: 0 };

  let best = "unknown";
  let bestScore = -1;
  for (const k of Object.keys(score)) {
    if (score[k] > bestScore) {
      bestScore = score[k];
      best = k;
    }
  }

  const conf = total > 0 ? clamp(bestScore / total, 0, 1) : 0;
  return { identity: best, confidence: conf };
}

/**
 * `guessIdentityConsensus` 的可解释版本：附带投票统计与弃权原因汇总，用于 UI 说明/调试。
 *
 * @param {*} target
 * @param {*} game
 * @param {GuessIdentityOptions} [opts]
 * @returns {{identity: IdentityLike, confidence: number, reason?: string, meta?: Object}}
 */
export function explainGuessIdentityConsensus(target, game, opts) {
  const options = normalizeGuessOptions(opts);
  const fixed = resolveBaseIdentity(target, game);
  if (fixed) {
    const reason = target === game?.zhu ? "fixed_zhu" : "fixed_shown";
    return { identity: fixed.identity, confidence: fixed.confidence, reason, meta: { observers: 0, votes: 0, abstain: {} } };
  }

  if (!options.disableSoftAssign) {
    const soft = getSoftAssignedIdentity(target, game);
    if (soft) {
      const observers = getObservers(game);
      return {
        identity: soft.identity,
        confidence: soft.confidence,
        reason: soft.reason,
        meta: { observers: Math.max(0, observers.length - 1), votes: 0, abstain: {} },
        detail: soft.detail,
      };
    }
  }

  const observers = getObservers(game);
  if (!observers.length) {
    return { identity: "unknown", confidence: 0, reason: "no_observers", meta: { observers: 0, votes: 0, abstain: {} } };
  }

  const score = Object.create(null);
  let total = 0;
  let votes = 0;
  const abstain = Object.create(null);

  for (const ob of observers) {
    if (ob === target) continue;
    const g = guessIdentityForDetailed(ob, target, game, options);
    const id = String(g?.identity || "unknown");
    const w = typeof g?.confidence === "number" ? clamp(g.confidence, 0, 1) : 0.2;
    if (id === "unknown" || w <= 0) {
      const r = String(g?.reason || "unknown");
      abstain[r] = (abstain[r] || 0) + 1;
      continue;
    }
    score[id] = (score[id] || 0) + w;
    total += w;
    votes++;
  }

  if (!votes) {
    return {
      identity: "unknown",
      confidence: 0,
      reason: "no_votes",
      meta: { observers: Math.max(0, observers.length - 1), votes: 0, abstain },
    };
  }

  let best = "unknown";
  let bestScore = -1;
  for (const k of Object.keys(score)) {
    if (score[k] > bestScore) {
      bestScore = score[k];
      best = k;
    }
  }

  const conf = total > 0 ? clamp(bestScore / total, 0, 1) : 0;
  return {
    identity: best,
    confidence: conf,
    reason: "ok",
    meta: { observers: Math.max(0, observers.length - 1), votes, abstain },
  };
}
