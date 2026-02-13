import { STORAGE_KEY } from "../lib/constants.js";
import { getPid } from "../lib/utils.js";
import { explainGuessIdentityConsensus, explainGuessIdentityFor } from "../guess_identity.js";
import { getStats, getOutputCoreScore, getCampOutputCorePlayer, getPlayerCamp } from "../stats.js";

const VB = {
  noData: { zh: "未启用/无人格数据", en: "Not enabled / no persona data" },
  personaType: { zh: "人格类型", en: "Persona" },
  identity: { zh: "身份", en: "Identity" },
  identityShown: { zh: "身份明置", en: "Identity Shown" },
  revealDegree: { zh: "暴露度", en: "Reveal" },
  revealLevel: { zh: "暴露状态", en: "Exposure" },
  guessWhy: { zh: "猜测原因", en: "Guess Why" },
  traits: { zh: "特质", en: "Traits" },
  aggressiveness: { zh: "激进", en: "Aggressiveness" },
  randomness: { zh: "随机", en: "Randomness" },
  revengeWeight: { zh: "记仇权重", en: "Revenge Weight" },
  insight: { zh: "洞察", en: "Insight" },
  camouflageRounds: { zh: "伪装回合", en: "Camo Rounds" },
  runtime: { zh: "模型(运行期)", en: "Model (Runtime)" },
  turnsTaken: { zh: "已行动回合", en: "Turns Taken" },
  installedAtRound: { zh: "安装回合", en: "Installed Round" },
  turnMemory: { zh: "本回合记忆", en: "Turn Memory" },
  turnActive: { zh: "当前回合行动者", en: "Active Turn Player" },
  turnEvents: { zh: "回合事件数", en: "Turn Events" },
  drawCount: { zh: "过牌", en: "Draw" },
  damageDealt: { zh: "造成伤害", en: "Damage Dealt" },
  coreScore: { zh: "核心指数", en: "Core Score" },
  outputCore: { zh: "输出核心", en: "Damage Core" },
  sectionAttitude: { zh: "对其他角色的态度", en: "Attitudes" },
  attitude: { zh: "态度", en: "Attitude" },
  impression: { zh: "初印象", en: "Impression" },
  evidence: { zh: "证据", en: "Evidence" },
  grudge: { zh: "仇恨", en: "Grudge" },
  rage: { zh: "怒气", en: "Rage" },
  rageTo: { zh: "对其怒气", en: "Rage To" },
  basicInference: { zh: "基本牌推断", en: "Basic Inference" },
  shaTempo: { zh: "杀密度倾向", en: "Sha Density Bias" },
};

const EXPOSE_LEVEL = {
  shown: { zh: "已明置", en: "Shown" },
  hidden: { zh: "未暴露", en: "Hidden" },
  soft: { zh: "软暴露", en: "Soft Exposed" },
  high: { zh: "高软暴露", en: "Hard Exposed" },
};

const TAG_SHORT = {
  shown: { zh: "明", en: "Shown" },
  hidden: { zh: "暗", en: "Hidden" },
  soft: { zh: "软", en: "Soft" },
  high: { zh: "高软", en: "Hard" },
};

const YES_NO = {
  yes: { zh: "是", en: "Yes" },
  no: { zh: "否", en: "No" },
};

const GUESS_REASON = {
  fixed_zhu: { zh: "目标为主公", en: "Target is Lord" },
  fixed_shown: { zh: "身份已明置", en: "Identity is shown" },
  soft_assigned_remaining_allies: { zh: "反贼已全部暴露，剩余视为友军", en: "All rebels exposed; remaining treated as allies" },
  no_observers: { zh: "无可用观察者", en: "No observers" },
  no_votes: { zh: "所有观察者弃权", en: "All observers abstained" },
  no_memory: { zh: "观察者无记忆数据", en: "Observer has no memory" },
  insufficient_signal: { zh: "线索不足", en: "Not enough signals" },
  nei_both_help_harm: { zh: "同时明显帮/打主公", en: "Both helped & harmed Lord" },
  signal_positive: { zh: "偏向主公阵营", en: "Leaning to Lord side" },
  signal_negative: { zh: "偏向反贼阵营", en: "Leaning to Rebel side" },
  ok: { zh: "已形成共识", en: "Consensus formed" },
};

/**
 * 将身份 id 映射为可读文案（中/英）。
 *
 * @param {"zh"|"en"} lang
 * @param {import("../lib/jsdoc_types.js").IdentityId|string} identity
 * @returns {string}
 */
function formatIdentityLabel(lang, identity) {
  lang = normalizeLang(lang);
  const id = String(identity || "");
  if (!id) return "?";
  if (lang === "zh") {
    switch (id) {
      case "zhu":
        return "主公";
      case "zhong":
      case "mingzhong":
        return "忠臣";
      case "fan":
        return "反贼";
      case "nei":
        return "内奸";
      case "unknown":
        return "未知";
      default:
        return id;
    }
  }
  switch (id) {
    case "zhu":
      return "Lord";
    case "zhong":
    case "mingzhong":
      return "Loyalist";
    case "fan":
      return "Rebel";
    case "nei":
      return "Spy";
    case "unknown":
      return "Unknown";
    default:
      return id;
  }
}

/**
 * 语言归一化：仅允许 zh/en。
 *
 * @param {*} lang
 * @returns {"zh"|"en"}
 */
function normalizeLang(lang) {
  return lang === "zh" ? "zh" : "en";
}

/**
 * 根据 pid 在 game.players/game.dead 中查找对应玩家对象。
 *
 * @param {*} game
 * @param {string} pid
 * @returns {*|null}
 */
function findPlayerByPid(game, pid) {
  if (!game || !pid) return null;
  const all = ((game.players || []).concat(game.dead || [])).filter(Boolean);
  for (const p of all) {
    if (getPid(p) === pid) return p;
  }
  return null;
}

/**
 * 获取 valuebox 文案。
 *
 * @param {"zh"|"en"} lang
 * @param {string} key
 * @returns {string}
 */
function vbText(lang, key) {
  lang = normalizeLang(lang);
  return (VB[key] && (VB[key][lang] || VB[key].zh)) || String(key);
}

/**
 * 获取暴露状态文案。
 *
 * @param {"zh"|"en"} lang
 * @param {string} key
 * @returns {string}
 */
function exposeText(lang, key) {
  lang = normalizeLang(lang);
  return (EXPOSE_LEVEL[key] && (EXPOSE_LEVEL[key][lang] || EXPOSE_LEVEL[key].zh)) || String(key);
}

/**
 * 获取势力/阵营的“名字高亮色”。
 *
 * 说明：
 * - 颜色仅用于 AI 标记面板展示，不影响引擎 UI
 * - 未识别的 group 使用默认高亮色
 *
 * @param {string} group
 * @returns {string}
 */
function getGroupHighlightColor(group) {
  const g = String(group || "").toLowerCase();
  switch (g) {
    case "wei":
      return "#5b8cff";
    case "shu":
      return "#3ad18d";
    case "wu":
      return "#ff5b5b";
    case "qun":
      return "#f3c23c";
    case "shen":
      return "#b07cff";
    case "jin":
      return "#c6b37a";
    default:
      return "#ffd866";
  }
}

/**
 * 获取玩家武将名并包装为“高亮展示”HTML。
 *
 * @param {*} player
 * @param {*} get
 * @returns {string}
 */
function formatColoredPlayerName(player, get) {
  const rawName =
    typeof get === "object" && typeof get.translation === "function"
      ? get.translation(player)
      : player?.name || "unknown";
  const color = getGroupHighlightColor(player?.group);
  return `<span style="color:${color};font-weight:600;text-shadow:0 0 1px rgba(0,0,0,.35)">${rawName}</span>`;
}

/**
 * 获取标签短文案（明/暗/软/高软）。
 *
 * @param {"zh"|"en"} lang
 * @param {string} key
 * @returns {string}
 */
function tagText(lang, key) {
  lang = normalizeLang(lang);
  return (TAG_SHORT[key] && (TAG_SHORT[key][lang] || TAG_SHORT[key].zh)) || String(key);
}

/**
 * @param {"zh"|"en"} lang
 * @param {boolean} bool
 * @returns {string}
 */
function yesNoText(lang, bool) {
  lang = normalizeLang(lang);
  return bool ? YES_NO.yes[lang] : YES_NO.no[lang];
}

/**
 * 简单数值格式化（保留两位小数的四舍五入表现）。
 *
 * @param {number} num
 * @returns {string}
 */
function fmt2(num) {
  if (typeof num !== "number" || Number.isNaN(num)) return "0";
  return String(Math.round(num * 100) / 100);
}

/**
 * 将 persona id 映射为可读文案（中/英）。
 *
 * @param {*} id
 * @param {"zh"|"en"} lang
 * @returns {string}
 */
function formatPersonaId(id, lang) {
  lang = normalizeLang(lang);
  switch (id) {
    case "balanced":
      return lang === "zh" ? "均衡" : "Balanced";
    case "impulsive":
      return lang === "zh" ? "冲动" : "Impulsive";
    case "petty":
      return lang === "zh" ? "记仇" : "Petty";
    case "camouflage":
      return lang === "zh" ? "伪装" : "Camouflage";
    default:
      return String(id || "unknown");
  }
}

/**
 * 拼接一行 key/value（HTML <br> 行）。
 *
 * @param {"zh"|"en"} lang
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function vbLine(lang, key, value) {
  return `${vbText(lang, key)}: ${value}<br>`;
}

/**
 * 将回合记忆事件格式化为可读的一行文本（含来源→目标）。
 *
 * @param {"zh"|"en"} lang
 * @param {import("../lib/jsdoc_types.js").SlqjAiTurnEvent} evt
 * @param {*} game
 * @param {*} get
 * @returns {string}
 */
function formatTurnEventLine(lang, evt, game, get) {
  lang = normalizeLang(lang);
  if (!evt || typeof evt !== "object") return "";

  const spid = String(evt.sourcePid || "");
  const tpid = String(evt.targetPid || "");
  const sPlayer = spid ? findPlayerByPid(game, spid) : null;
  const tPlayer = tpid ? findPlayerByPid(game, tpid) : null;
  const sName = sPlayer ? formatColoredPlayerName(sPlayer, get) : spid || "?";
  const tName = tPlayer ? formatColoredPlayerName(tPlayer, get) : tpid || "?";
  const n = typeof evt.num === "number" && !Number.isNaN(evt.num) ? evt.num : 0;
  const via = String(evt.via || "");
  const cardName = String(evt.cardName || "");

  let action = "";
  switch (String(evt.kind || "")) {
    case "damage":
      action = lang === "zh" ? "扣血" : "Damage";
      break;
    case "loseHp":
      action = lang === "zh" ? "流失体力" : "Lose HP";
      break;
    case "recover":
      action = lang === "zh" ? "加血" : "Recover";
      break;
    case "discard":
      action = lang === "zh" ? "弃牌" : "Discard";
      break;
    case "draw":
      action = lang === "zh" ? "摸牌" : "Draw";
      break;
    default:
      action = String(evt.kind || "");
  }

  const numText = n ? (lang === "zh" ? `${action}${n}` : `${action} ${n}`) : action;
  const viaText = via && via !== "discard" ? ` (${via})` : "";
  const cardText = cardName ? ` [${cardName}]` : "";

  if (spid && spid !== tpid) return `${sName} → ${tName} ${numText}${viaText}${cardText}`;
  return `${tName} ${numText}${viaText}${cardText}`;
}

/**
 * 将 identityShown + ai.shown 映射为暴露等级（用于 UI 标签/策略）。
 *
 * @param {boolean} identityShown
 * @param {number} shown
 * @returns {"shown"|"hidden"|"soft"|"high"}
 */
function resolveExposeLevel(identityShown, shown) {
  if (identityShown) return "shown";
  if (shown >= 0.85) return "high";
  if (shown >= 0.7) return "soft";
  return "hidden";
}

/**
 * @param {"zh"|"en"} lang
 * @param {"shown"|"hidden"|"soft"|"high"} exposeKey
 * @param {string|{identity?:string, reason?:string, detail?:Object, meta?:Object}|null|undefined} guess
 * @returns {string}
 */
function formatExposeLabel(lang, exposeKey, guess) {
  lang = normalizeLang(lang);
  const base = exposeText(lang, exposeKey);
  if (exposeKey === "soft" || exposeKey === "high") {
    const identity = guess && typeof guess === "object" ? guess.identity : guess;
    const label = formatIdentityLabel(lang, identity);
    const reasonKey = guess && typeof guess === "object" ? String(guess.reason || "") : "";
    const isUnknown = String(identity || "unknown") === "unknown";
    const showReason = !!(reasonKey && (isUnknown || reasonKey === "soft_assigned_remaining_allies"));
    const reasonText = showReason ? (GUESS_REASON[reasonKey]?.[lang] || GUESS_REASON[reasonKey]?.zh || reasonKey) : "";
    if (lang === "zh") return `${base}(被AI系统\`猜测\`为${label}${reasonText ? `; 原因:${reasonText}` : ""})`;
    return `${base}(identity \`guessed\` as ${label}${reasonText ? `; why: ${reasonText}` : ""})`;
  }
  return base;
}

/**
 * @param {"zh"|"en"} lang
 * @param {{observers?:number, votes?:number, abstain?:Object}|null|undefined} meta
 * @returns {string}
 */
function formatConsensusMeta(lang, meta) {
  lang = normalizeLang(lang);
  if (!meta || typeof meta !== "object") return "";
  const observers = typeof meta.observers === "number" ? meta.observers : 0;
  const votes = typeof meta.votes === "number" ? meta.votes : 0;
  const abstain = meta.abstain && typeof meta.abstain === "object" ? meta.abstain : null;
  const parts = [];
  if (lang === "zh") {
    parts.push(`观察者=${observers}`);
    parts.push(`有效票=${votes}`);
  } else {
    parts.push(`observers=${observers}`);
    parts.push(`votes=${votes}`);
  }
  if (abstain) {
    const seg = [];
    for (const k of Object.keys(abstain)) {
      const n = abstain[k];
      if (typeof n !== "number" || n <= 0) continue;
      const label = (GUESS_REASON[k]?.[lang] || GUESS_REASON[k]?.zh || k).replace(/[()]/g, "");
      seg.push(`${label}=${n}`);
    }
    if (seg.length) parts.push(lang === "zh" ? `弃权:${seg.join(",")}` : `abstain:${seg.join(",")}`);
  }
  return parts.join(" ");
}

/**
 * @param {"zh"|"en"} lang
 * @param {Object|null|undefined} detail
 * @returns {string}
 */
function formatSignalDetail(lang, detail) {
  lang = normalizeLang(lang);
  if (!detail || typeof detail !== "object") return "";
  const abs = typeof detail.abs === "number" ? detail.abs : null;
  const threshold = typeof detail.threshold === "number" ? detail.threshold : null;
  const help = typeof detail.help === "number" ? detail.help : null;
  const harm = typeof detail.harm === "number" ? detail.harm : null;
  if (abs === null || threshold === null) return "";
  const base = `abs=${fmt2(abs)}<${fmt2(threshold)}`;
  const extra = help !== null && harm !== null ? ` help=${fmt2(help)} harm=${fmt2(harm)}` : "";
  return base + extra;
}

/**
 * 获取“未启用/无人格数据”的占位文本。
 *
 * @param {"zh"|"en"} [lang="zh"]
 * @returns {string}
 */
export function getInspectNoDataText(lang = "zh") {
  lang = normalizeLang(lang);
  return VB.noData[lang] || VB.noData.zh;
}

/**
 * 构建“人格标记”展示文本（HTML 字符串）。
 *
 * @param {*} target
 * @param {*} game
 * @param {*} get
 * @param {"zh"|"en"} [lang="zh"]
 * @returns {string}
 */
export function buildInspectText(target, game, get, lang = "zh") {
  lang = normalizeLang(lang);
  const st = target && target.storage ? target.storage[STORAGE_KEY] : null;
  if (!st) return getInspectNoDataText(lang);

  const persona = st.persona;
  const traits = persona && persona.traits ? persona.traits : null;
  const mem = st.memory || null;
  const rt = st.runtime || null;

  const myShown = target && target.ai && typeof target.ai.shown === "number" ? target.ai.shown : 0;
  let myExposeKey = resolveExposeLevel(!!(target && target.identityShown), myShown);
  const myGuess = explainGuessIdentityConsensus(target, game);
  if (myExposeKey === "hidden" && String(myGuess?.reason || "") === "soft_assigned_remaining_allies") {
    myExposeKey = "soft";
  }
  const myStats = getStats(target);
  const myCoreScore = getOutputCoreScore(myStats);
  const zhuCore = getCampOutputCorePlayer(game, "zhu");
  const fanCore = getCampOutputCorePlayer(game, "fan");
  const myCamp = getPlayerCamp(target && target.identity);
  const myCore = myCamp === "zhu" ? zhuCore : myCamp === "fan" ? fanCore : null;
  const isCore = !!(myCore && target && myCore === target && myCamp !== "other");

  let out = "";
  out += vbLine(lang, "personaType", formatPersonaId(persona ? persona.id : null, lang));
  out += vbLine(lang, "identity", formatIdentityLabel(lang, target && target.identity));
  out += vbLine(lang, "identityShown", yesNoText(lang, !!(target && target.identityShown)));
  out += vbLine(lang, "revealDegree", fmt2(myShown));
  out += vbLine(lang, "revealLevel", formatExposeLabel(lang, myExposeKey, myGuess));
  if ((myExposeKey === "soft" || myExposeKey === "high") && String(myGuess?.identity || "unknown") === "unknown") {
    const whyKey = String(myGuess?.reason || "");
    const whyText = whyKey ? (GUESS_REASON[whyKey]?.[lang] || GUESS_REASON[whyKey]?.zh || whyKey) : "";
    const metaText = formatConsensusMeta(lang, myGuess?.meta);
    const detailText = whyKey === "insufficient_signal" ? formatSignalDetail(lang, myGuess?.detail) : "";
    const joined = [whyText, detailText, metaText].filter(Boolean).join(" | ");
    if (joined) out += vbLine(lang, "guessWhy", joined);
  }
  out += vbLine(lang, "drawCount", fmt2(myStats.draw));
  out += vbLine(lang, "damageDealt", fmt2(myStats.damageDealt));
  out += vbLine(lang, "coreScore", fmt2(myCoreScore));
  out += vbLine(lang, "outputCore", yesNoText(lang, isCore));

  if (traits) {
    out += "<br>";
    out += vbLine(lang, "traits", "");
    out += vbLine(lang, "aggressiveness", fmt2(traits.aggressiveness));
    out += vbLine(lang, "randomness", fmt2(traits.randomness));
    out += vbLine(lang, "revengeWeight", fmt2(traits.revengeWeight));
    out += vbLine(lang, "insight", fmt2(traits.insight));
    out += vbLine(lang, "camouflageRounds", fmt2(traits.camouflageRounds));
  }

  if (rt) {
    out += "<br>";
    out += vbLine(lang, "runtime", "");
    out += vbLine(lang, "turnsTaken", fmt2(rt.turnsTaken));
    out += vbLine(lang, "installedAtRound", fmt2(rt.installedAtRound));

    const tm = rt.turnMemory && typeof rt.turnMemory === "object" ? rt.turnMemory : null;
    if (tm && Array.isArray(tm.events)) {
      const activePid = String(tm.activePid || "");
      const activePlayer = activePid ? findPlayerByPid(game, activePid) : null;
      const activeName = activePlayer ? formatColoredPlayerName(activePlayer, get) : activePid || "?";
      out += vbLine(lang, "turnActive", activeName);
      out += vbLine(lang, "turnEvents", fmt2(tm.events.length));
      if (tm.events.length) {
        out += `${vbText(lang, "turnMemory")}:<br>`;
        const list = tm.events.slice(-10);
        for (const e of list) {
          const line = formatTurnEventLine(lang, e, game, get);
          if (line) out += `${line}<br>`;
        }
      }
    }
  }

  if (mem) {
    const rage = typeof mem.rage === "number" && !Number.isNaN(mem.rage) ? mem.rage : 0;
    out += "<br>";
    out += vbLine(lang, "rage", fmt2(rage));
  }

  if (!mem) return out || getInspectNoDataText(lang);

  const players = (game && game.players) || [];
  const dead = (game && game.dead) || [];
  const others = players.concat(dead).filter(p => p && p !== target);
  if (!others.length) return out;

  out += "<br>";
  out += `${vbText(lang, "sectionAttitude")}:<br>`;

  for (const p of others) {
    const name = formatColoredPlayerName(p, get);
    const pid = getPid(p);
    const impression = (mem.firstImpression && mem.firstImpression[pid]) || 0;
    const evidence = (mem.evidence && mem.evidence[pid]) || 0;
    const grudge = (mem.grudge && mem.grudge[pid]) || 0;
    const rageTo = (mem.rageTowards && mem.rageTowards[pid]) || 0;
    const att = typeof get === "object" && typeof get.attitude === "function" ? get.attitude(target, p) : 0;
    const shown = p && p.ai && typeof p.ai.shown === "number" ? p.ai.shown : 0;
    const guess = explainGuessIdentityFor(target, p, game);
    const guessedIdentity = guess && typeof guess === "object" ? guess.identity : "unknown";
    let exposeKey = resolveExposeLevel(!!p.identityShown, shown);
    if (exposeKey === "hidden" && String(guess?.reason || "") === "soft_assigned_remaining_allies") {
      exposeKey = "soft";
    }
    const tag = tagText(lang, exposeKey);
    const stats = getStats(p);
    const score = getOutputCoreScore(stats);
    const camp = getPlayerCamp(p.identity);
    const campCore = camp === "zhu" ? zhuCore : camp === "fan" ? fanCore : null;
    const core = !!(campCore && campCore === p && camp !== "other");

    out += `${name}[${tag}]: ${vbText(lang, "identity")}=${formatIdentityLabel(lang, guessedIdentity)} ${vbText(lang, "attitude")}=${fmt2(att)} ${vbText(
      lang,
      "coreScore"
    )}=${fmt2(score)} ${vbText(lang, "outputCore")}=${yesNoText(lang, core)} (${vbText(
      lang,
      "revealDegree"
    )}=${fmt2(shown)} ${vbText(lang, "revealLevel")}=${formatExposeLabel(lang, exposeKey, guess)} ${vbText(
      lang,
      "impression"
    )}=${fmt2(
      impression
    )} ${vbText(lang, "evidence")}=${fmt2(evidence)} ${vbText(lang, "grudge")}=${fmt2(grudge)} ${vbText(lang, "rageTo")}=${fmt2(rageTo)})<br>`;
  }

  // 基本牌推断：仅展示“杀密度倾向”绝对值较大的 Top 项，避免面板过长
  const tempoMap = mem.basicTempo && typeof mem.basicTempo === "object" ? mem.basicTempo : null;
  if (tempoMap) {
    const entries = [];
    for (const p of others) {
      const pid = getPid(p);
      const rec = tempoMap[pid];
      const v = rec && typeof rec.sha === "number" && !Number.isNaN(rec.sha) ? rec.sha : 0;
      if (Math.abs(v) < 0.2) continue;
      const samples = rec && typeof rec.shaSamples === "number" && !Number.isNaN(rec.shaSamples) ? rec.shaSamples : 0;
      const name = formatColoredPlayerName(p, get);
      entries.push({ name, sha: v, samples });
    }
    entries.sort((a, b) => Math.abs(b.sha) - Math.abs(a.sha));
    if (entries.length) {
      out += "<br>";
      out += `${vbText(lang, "basicInference")}:<br>`;
      for (const it of entries.slice(0, 5)) {
        out += `${it.name}: ${vbText(lang, "shaTempo")}=${fmt2(it.sha)} (n=${it.samples})<br>`;
      }
    }
  }

  return out;
}
