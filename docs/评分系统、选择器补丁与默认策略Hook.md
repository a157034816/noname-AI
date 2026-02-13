# 评分系统、选择器补丁与默认策略 Hook

本文解释本扩展“改 AI 决策”的核心：  
它不是替换引擎 AI，而是**在引擎原有“枚举候选→check 打分→取最大值”的框架上**，通过：

1) 包装 `ai.basic.chooseCard/chooseTarget/chooseButton` 的 check 函数  
2) 在 check 的评分链中引入 HookBus（`slqj_ai_score`）与内置策略（反全知/噪声/小心眼等）  
3) 通过默认策略 hooks（大量启发式门禁/偏置）把行为更“像人”

对应源码：

- 选择器补丁：`src/ai_persona/selector_patch.js`
- 默认策略 hooks：`src/ai_persona/strategies/default_score_hooks.js`
- HookBus：`src/ai_persona/lib/hook_bus.js`
- 身份局门禁工具：`src/ai_persona/lib/identity_utils.js`、`src/ai_persona/lib/card_utils.js`

---

## 1) 选择器补丁：包装 ai.basic.chooseX

`installSelectorPatch({ ai, get, game, _status })` 会把以下函数包装为“可插拔评分链”：

- `ai.basic.chooseCard(check)`
- `ai.basic.chooseTarget(check)`
- `ai.basic.chooseButton(check)`

### 1.1 何时生效？
补丁对每次选择都会先判断：

- 当前决策玩家来自 `_status.event.player`
- 该玩家必须是“本地 AI 玩家”（见 `isLocalAIPlayer`）且已初始化 persona

否则直接调用引擎原实现（默认不影响玩家本人手操；自机仅在托管（`isAuto===true`）时会视为本地 AI 走该链路；联机玩家/连接模式仍会跳过）。

### 1.2 wrapCheck：评分链结构（base → hook → builtin → hook → final）
对每个候选 `candidate`，扩展会：

1) 调用引擎原 `check(candidate, all)` 得到 `base`
2) 执行内置规则（反全知/噪声/小心眼等）并计算 `extra`
3) 通过 HookBus 在多个阶段 `emit("slqj_ai_score", ctx)` 让外部改写评分
4) 返回最终 `score`

---

## 2) slqj_ai_score：HookBus 事件（对外接口）

选择器补丁在每个候选的评分过程中会 emit `slqj_ai_score`，ctx 典型字段（见 `selector_patch.js`）：

- `kind`：`"chooseCard" | "chooseTarget" | "chooseButton"`
- `stage`：`"base" | "builtin" | "final"`（同一次候选会多次 emit）
- `player`：做决策的玩家（本地 AI）
- `candidate`：当前候选（卡/目标/按钮）
- `all`：候选集合
- `event`：`_status.event`（当前引擎事件）
- `base`：引擎原评分
- `score`：当前可写的最终评分（hook 可改）
- `extra`：扩展内置额外分（噪声/偏置等）
- `game` / `get`：便于 hook 使用引擎工具
- `stop`：置为 `true` 可终止后续 handler
- `skipBuiltin`：置为 `true` 可跳过扩展内置偏置（噪声/小心眼等）

> handler 若返回非 `undefined`，会作为新的 ctx 继续向后传递（HookBus 的链式语义见 `hook_bus.js`）。

---

## 3) 内置评分改动（selector_patch 内部）

### 3.1 反全知：盲选他人手牌随机化（chooseButton）
当处于如下事件场景之一：

- `choosePlayerCard`
- `discardPlayerCard`

且选择位置包含手牌（`event.position` 含 `h`），并且：

- `event.visible !== true`（手牌不可见）
- 目标不在控制范围（`target.isUnderControl(true)` 为 false）
- 决策者没有 `viewHandcard` 标签
- 该按钮对应的卡牌真实位置为 `h`
- 且不是“已明示手牌”（`get.is.shownCard`）

则对 `base>0` 的候选把分数改成一个很小的随机正数：

- 目的：保留“该不该选/该不该取消”的符号信息（base<=0 不改），同时避免“按真实暗牌最优解”。

### 3.2 评分噪声（仅 impulsive + 仅正收益）
若配置 `slqj_ai_score_noise_enable` 开启，且人格为 `impulsive`，且 `baseScore>0`：

- 加入对称小噪声：`(Math.random()-0.5) * traits.randomness * 0.2`
- 并保证：不会把 0/负收益抬成正收益（base<=0 时噪声为 0）

### 3.3 记仇偏置（petty）
若人格为 `petty`：

- 读取 `memory.grudge[targetPid]`
- 仅当目标本就偏敌对（`get.attitude(player,target) < 0`）时，追加偏置  
`extra += clamp(grudge * 0.12, 0, 2)`

---

## 4) 默认策略 hooks（default_score_hooks）

默认策略通过订阅 `slqj_ai_score` 在“评分层”实现大量经验规则与保守门禁。  
它不直接改动引擎 AI 函数；而是在 selector_patch 发出的评分链上做增减分。

安装入口：`src/ai_persona/strategies/default_score_hooks.js -> installDefaultScoreHooks({game,get,_status})`  
安装时机：`installPersonaSystem(...)` 内调用。

### 4.1 默认策略清单（按代码安装标记）
以下是该文件中用于“只安装一次”的标记（每个标记对应一组 hooks 逻辑）：

- `_openingBlindSnipeHookInstalled`
- `_shownEnemyFirstHookInstalled`
- `_equipHoldInHandHookInstalled`
- `_wuxieKeepPriorityHookInstalled`
- `_basicCardGeneralTipsHookInstalled`
- `_shaTempoInferenceHookInstalled`
- `_handStoragePriorityHookInstalled`
- `_rageBiasHookInstalled`
- `_immediateUseValueHookInstalled`
- `_drawFirstThenActHookInstalled`
- `_trickGeneralOrderHookInstalled`
- `_trickSubsectionsHookInstalled`
- `_trickSpecificTipsHookInstalled`
- `_situationTempoHookInstalled`
- `_noRescueRecentAttackHookInstalled`
- `_taoReserveHookInstalled`
- `_delayTrickTargetHookInstalled`
- `_trickTargetSafetyHookInstalled`
- `_groupTrickGateHookInstalled`
- `_groupBeneficialTrickGateHookInstalled`

下面挑其中“影响最大/最容易在对局中观察到”的规则，做机制级解释。

---

## 5) 重点规则详解（可观测行为）

### 5.1 开局避免“盲狙远位菜刀将”（身份局前两轮）
（`_openingBlindSnipeHookInstalled`）

在身份局 `round<=2`：

- 仅对“目标未明置 + 软暴露不高（shown<0.85）”的盲打未知生效
- 仅对“有害行为”（tv<0）生效
- 要求目标距离较远（dist>=2）
- 要求目标像“菜刀将”（输出向标签）
- 若当前态度已极度敌对（att<-3.5）则不再限制

效果：对这类“盲狙”目标降低评分，减少开局乱打导致的误伤/跳身份风险。

### 5.2 若有“已明置敌人”，优先处理明置敌人，避免继续盲打未知
（`_shownEnemyFirstHookInstalled`）

在身份局：

- 当候选目标是“未知且敌对倾向”（att<-0.6）且本次行为为有害（tv<0）
- 若候选集中存在“已明置且敌对”的可用目标（同样 tv<0）

则对未知目标施加大惩罚（强行把分数压下去）。

效果：只要桌上已经有人明示为敌，AI 更少把输出浪费在未知身上。

### 5.3 “装备别急着挂”：手牌未到上限且无进攻需求时尽量暗藏
（`_equipHoldInHandHookInstalled`）

在出牌阶段的 `chooseCard`：

- 若手牌未到上限（hand < limit）
- 且当前没有明显“马上能打出的进攻需求”

则对“武器/减马”等装备的出牌做降权（base 越低惩罚越明显）。

目的：贴近 `docs/通用技巧.md` 的经验：无收益的明牌会带来风险（借刀、被拆顺、暴露意图等）。

### 5.4 弃牌时优先保留无懈（多数情况下比桃更关键）
（`_wuxieKeepPriorityHookInstalled`）

在弃牌/被迫失去牌的 `chooseCard` 上：

- 若候选是 `wuxie`：显著降低其“被弃置”的评分（即更不愿弃无懈）
- 对 `tao` 有少数例外：自身濒死/极低血线时桃更关键

### 5.5 基本牌通用技巧：留闪/卖血保杀/酒的时机
（`_basicCardGeneralTipsHookInstalled`）

这一组规则覆盖多个上下文：

1) **弃牌**：回合外更需要基本牌  
   - 最后一闪更难弃（并结合“敌方杀密度推断”进一步强化）
   - 杀稀缺时更保留；并按火/雷/红/黑做“先丢谁”的倾向
   - 酒重复时更愿意丢（酒一回合只能喝一次）

2) **响应**：温和“卖血保杀”  
   - 当 hp 不低且手里杀很稀缺时，对南蛮/决斗的响应“出杀”做轻度降权  
   - 仅是温和偏置，不会推翻必防致命伤的情况

3) **出牌阶段**：酒的时机按本局 habit 分流  
   - `habits.jiuSearchSha=conservative`：手里没杀就不空喝酒
   - `heuristic`：允许“先喝酒再找牌”，但要求存在过牌候选作为“找牌载体”，且桌上确有明显敌对目标

### 5.6 基本牌节奏推断落地：优先控“杀密度更高”的敌人
（`_shaTempoInferenceHookInstalled`）

当扩展从公开信息推断“某敌人杀出得早→杀更多”（见 `basic_tempo_events.js`）后：

- 在使用 `lebu/bingliang/guohe/shunshou` 等控场/拆迁牌选目标时
- 对“杀密度更高”的敌对目标做小幅加权
- 但当基础收益已经很高（base>=4.5）时不再额外干预，避免推翻明显最优解

### 5.7 “刚刚被我攻击的人我不救”
（`_noRescueRecentAttackHookInstalled`）

当本地 AI 在同一结算链里刚刚“单点进攻”过某目标（recentAttack 记录，见 `recent_attack_events.js`），并在一个救助类 `chooseTarget` 上遇到同一目标时：

- 直接大幅降低评分（`score -= 9999`）

效果：能显著复现“刚打完你我不救你”的人类行为风格。

### 5.8 桃保留策略：不救未暴露友方（身份局）
（`_taoReserveHookInstalled`）

当事件是“使用桃选目标”时：

- 若 `shouldReserveTao(player, target, game, get)===true`（核心含义：目标不是自救/不是主公/不是已暴露友方）
- 则对救该目标施加惩罚（桃越少惩罚越大）

目的：避免在身份不明时把关键资源浪费给“可能是敌人”的目标。

### 5.9 延时锦囊/普通锦囊的“安全门禁”
（`_delayTrickTargetHookInstalled` / `_trickTargetSafetyHookInstalled`）

身份局中，扩展对“未暴露目标”更谨慎：

- 延时锦囊：只对“已暴露且敌对”的目标下（否则降权）
- 普通锦囊（type=trick）：
  - 有害锦囊（tv<0）：只对已暴露敌方使用
  - 有益锦囊（tv>0）：只对已暴露友方使用（自用不受限）

### 5.10 群体锦囊门禁：弱势不乱开
（`_groupTrickGateHookInstalled` / `_groupBeneficialTrickGateHookInstalled`）

身份局对“群体进攻/群体增益”锦囊设门禁：

- 群体进攻（如南蛮/万箭等同类）：仅当“友军人数 < 敌军人数”时才放行
- 群体增益（如桃园/五谷等同类）：默认更保守，仅在“我方更需要资源”时放行（会考虑主公/输出核心濒危、双方缺血差等）

这些门禁的通用识别与放行条件主要由：

- `card_utils.js`：识别群体进攻/群体增益锦囊
- `identity_utils.js`：人数与局面门禁（含输出核心判定）

---

## 6) 开发者：如何在 scripts/外部扩展中接入？

### 6.1 订阅评分事件
任何脚本/扩展只要拿到 HookBus（通常是 `game.slqjAiHooks`），即可：

- `hooks.on("slqj_ai_score", (ctx)=>{ ... }, {priority})`

常见用法：

- 在 `stage==="base"` 时读取引擎原分数并做粗过滤
- 在 `stage==="final"` 时做强门禁（例如直接 `ctx.score -= 9999`）
- 需要完全接管时可设置 `ctx.stop=true` 阻止后续 handler
- 需要禁用扩展自带噪声/小心眼时可设置 `ctx.skipBuiltin=true`

### 6.2 与人格/心智模型联动
可在 `slqj_ai_persona_init`（见前文人格系统）时修改 traits，从而影响：

- 证据权重（洞察）
- 仇恨权重（记仇）
- 激进偏置
- 伪装回合

也可直接读取/写入 `player.storage.slqj_ai.memory`（建议只在 dev/调试时使用，避免过强副作用）。
