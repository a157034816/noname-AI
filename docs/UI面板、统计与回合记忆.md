# UI 面板、统计与回合记忆（AI 标记）

本文解释扩展的 UI 可视化层：`AI` 标记面板展示什么、这些数据从哪里来、以及“统计/回合记忆/基本牌推断”是如何记录的。

对应源码：

- 标记技能与全局技能安装：`src/ai_persona/skills/persona_skills.js`
- 面板内容（中/英）：`src/ai_persona/ui/inspect_valuebox_i18n.js`
- 统计结构：`src/ai_persona/stats.js`
- 回合记忆：`src/ai_persona/events/turn_memory_events.js`
- 基本牌节奏推断：`src/ai_persona/events/basic_tempo_events.js`

---

## 1) AI 标记技能：slqj_ai_inspect

扩展定义了一个 mark 技能 `slqj_ai_inspect`：

- `mark: true`，`marktext: "AI"`
- 点击 mark 弹出的 intro 内容由以下函数提供：
  - `buildInspectText(target, game, get, lang)`
  - 若无数据：`getInspectNoDataText(lang)`
- 说明：引擎默认会在角色死亡时清理大部分 marks；扩展通过在 `die` 事件里把 `slqj_ai_inspect` 放入 `excludeMark`，使其在死亡后仍保留（便于复盘/观察）

语言来源（优先级）：

- `game.__slqjAiPersona.cfg.inspectLang`
- 否则回退 `"en"`

> 是否在开局给所有角色挂上该标记由配置 `slqj_ai_inspect_enable` 控制（见 `slqj_ai_init`）。

---

## 2) 开局初始化：slqj_ai_init

全局技能 `slqj_ai_init` 在第 1 轮 `roundStart` 时运行一次，做三件事：

1. 初始化 stats：`initAllPlayersStats(game)`
2. 初始化本地 AI 的 persona/memory：`initAllAiPlayers(game,_status)`
3. 若开启 inspect：为所有角色 `addSkill("slqj_ai_inspect")`

这也是为什么很多设置“修改后建议重启”：标记/人格/脚本加载等都发生在扩展启动阶段。

---

## 3) 统计（stats）：过牌与造成伤害

### 3.1 统计结构
`stats.js` 维护：

- `draw`：过牌量（摸牌数）
- `damageDealt`：造成伤害量

并提供：

- `getOutputCoreScore(stats)`：输出核心指数（`draw*0.6 + damageDealt*2.2`）
- `getCampOutputCorePlayer(game, camp)`：选出阵营中输出核心（zhu side / fan side）

### 3.2 写入时机
由全局技能写入（见 `persona_skills.js`）：

- `slqj_ai_stat_draw`：`drawAfter` → `addDrawStat(player,n)`
- `slqj_ai_stat_damage`：`damageEnd`（source）→ `addDamageDealtStat(player,n)`

这些统计既用于 UI 展示，也会被部分策略门禁使用（例如群体有益锦囊是否值得开会参考“核心输出濒危”等启发式）。

---

## 4) 回合记忆（turnMemory）：本回合发生了什么？

### 4.1 设计目标
让 AI 在同一回合内能回看“谁对谁造成了什么”（并在面板中展示），而不是跨回合永久累积。

### 4.2 回合锚点与重置
`turn_memory_events.js` 在 `phaseBeginStart` 时触发重置：

- `game.__slqjAiPersona._turnMemoryState.id += 1`
- `activePid = getPid(trigger.player)`（当前回合行动者）
- 对每个本地 AI observer：写入 `runtime.turnMemory = {turnId, activePid, events: []}`

为了避免多次触发，reset 会在 trigger 上写一个 `_slqjAiTurnMemoryResetDone` 标记。

### 4.3 记录哪些事件？
记录的事件类型（`kind`）见 `jsdoc_types.js`：

- `damage`（扣血，来自 damageEnd）
- `loseHp`（流失体力，来自 loseHpEnd）
- `recover`（加血，来自 recoverEnd）
- `discard`（弃牌，来自 discardAfter / loseToDiscardpileAfter）
- `draw`（摸牌，来自 drawAfter）

对应全局技能（`persona_skills.js`）：

- `slqj_ai_turn_memory_damage`
- `slqj_ai_turn_memory_losehp`
- `slqj_ai_turn_memory_recover`
- `slqj_ai_turn_memory_discard`
- `slqj_ai_turn_memory_lose_to_discardpile`

### 4.4 只记录“与我有关”的事件（过滤规则）
turnMemory 的写入不是“全局广播给每个 AI”，而是只记录：

- `observerPid === sourcePid`（我造成的）
- 或 `observerPid === targetPid`（我承受/获得的）

这样面板不会爆炸式增长，更贴近“我只记得和我有关的事”。

### 4.5 事件来源解析（尽力而为）
一些结算事件缺少 `source` 字段（例如 loseHp），扩展会沿事件链向上找：

- `evt.source`
- `evt.discarder`
- `evt.player`

作为“来源玩家”的近似。

### 4.6 截断策略
为防止异常事件导致数组无限增长：

- 单回合最多保留 `MAX_TURN_EVENTS = 80`
- UI 展示只取最近 10 条

---

## 5) 基本牌节奏推断（basicTempo）：杀密度倾向

### 5.1 记录逻辑（公开信息）
`basic_tempo_events.js` 在 `useCardAfter`（且发生在出牌阶段）统计：

> 对手【杀】出的越快，越可能“杀多”；连续出杀信号更强。

它会把推断写入 **观察者的**：

- `memory.basicTempo[targetPid].sha`（范围 clamp 到 [-2,2]）
- 同时记录 `shaSamples`（样本数）与 `lastRound`

### 5.2 UI 展示
面板会在“基本牌推断”区块展示：

- 只展示 `|sha| >= 0.2` 的目标
- 按绝对值排序取 Top 5

用途：

- 让玩家/开发者直观看到推断是否生效
- 也被默认策略 hooks 用于轻度偏置（例如控场/拆迁优先处理“杀密度更高”的敌人）

---

## 6) 面板具体展示字段（buildInspectText）

`inspect_valuebox_i18n.js -> buildInspectText` 会展示（按大区块）：

1) **人格与身份信息**
- 人格类型、特质数值
- 真实身份是否明置（identityShown）
- 软暴露值（ai.shown）
- 猜测身份（对单目标的解释 guessIdentityFor + 对全体观察者的共识 guessIdentityConsensus）

2) **运行期信息**
- 已行动回合（turnsTaken）
- 安装回合（installedAtRound）
- 本回合记忆（active turn player、事件条数、最近事件列表）

3) **统计与输出核心**
- 过牌（draw）
- 造成伤害（damageDealt）
- 核心指数（coreScore）
- 是否为阵营输出核心（outputCore）

4) **对其他角色的态度列表**
对每个其他角色（含死亡）输出一行，包含：

- 其“明/暗/软/高软”标签（基于 identityShown 与 shown）
- 猜测身份、态度数值
- 其 coreScore/是否为输出核心
- 观察者对其的 impression/evidence/grudge/rageTowards

5) **怒气**
展示全局怒气 `memory.rage`

> 注意：面板中的态度（attitude）来自 `get.attitude(...)`，而该函数在身份未明置时可能已被扩展的“感知态度补丁”替换（详见机制文档）。

---

## 7) dev 调试接口：window.slqjAI

当 `lib.config.dev === true` 时，扩展会暴露：

- `window.slqjAI.get(player)` → 返回 `player.storage.slqj_ai`

用途：

- 在控制台快速检查某个玩家的 persona/memory/runtime/stats
- 辅助脚本插件开发与阈值调试

安全提示：

- 该接口仅用于调试；不建议在非 dev 模式依赖它来编写 scripts 逻辑（更推荐订阅 HookBus）。
