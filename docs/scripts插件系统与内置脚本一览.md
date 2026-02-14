# scripts 插件系统与内置脚本一览

本扩展内置一个轻量的“脚本插件系统”，用于在不改动扩展核心代码的情况下，通过 `scripts/*.js` 注入 Hook、接管个别武将 AI、实现队友配合等。

本文分三部分：

1) scripts 系统机制（加载器/注册表/管理 UI）  
2) 给脚本作者的接口说明（ctx、HookBus、元信息约定）  
3) 仓库自带脚本逐个拆解（做了什么、哪里接入、可调参数与副作用）

对应源码：

- 加载器：`src/scripts_loader.js`
- 注册表：`src/scripts_registry.js`
- 管理 UI：`src/scripts_manager_modal.js`
- 脚本目录：`scripts/*.js`

---

## 1) scripts 是什么？（玩家视角）

- `scripts/` 下的每个 `.js/.mjs` 文件都是一个“插件”
- 扩展开局会按顺序加载这些脚本（可在扩展设置里关闭）
- 脚本可以：
  - 订阅 `slqj_ai_score` 等 Hook，影响 AI 选择
  - 监听 `slqj_ai_emotion_throw` 实现“投花协作”一类玩法
  - 对特定武将做“AI 接管/加强”

> “保存后建议重启生效”是因为脚本加载发生在扩展启动时；运行中不会自动重新 import（除非你自行实现热重载）。

---

## 2) 加载器：loadExtensionScripts 的行为约定

入口：`src/scripts_loader.js -> loadExtensionScripts(opts)`

### 2.1 整体开关
若配置 `slqj_ai_scripts_enable` 关闭：

- 返回 `{loaded:[], failed:[], skipped:true}`，不加载任何脚本

### 2.2 枚举脚本文件（不递归）
枚举函数：`src/scripts_registry.js -> listExtensionScriptFiles({baseUrl, game})`

优先级：

1) **引擎接口**（适用于 sandbox/浏览器环境）  
   - `game.promises.getFileList(dir)` 或 `game.getFileList(dir, ...)`  
   - 默认目录为：`extension/身临其境的AI/scripts`
2) **Node 兜底**（仅在 Node 环境可用）  
   - `import("fs")` + `import("url")` + `fileURLToPath`

过滤规则：

- 只取一层文件
- 只取后缀 `.js` / `.mjs`
- 默认按文件名排序

若无法枚举（例如 fs 不可用且引擎也不给列表）：

- 加载器会跳过，并输出 warning

### 2.3 注册表与加载计划（顺序/禁用）
注册表读取：`readScriptsRegistry(config, lib)`，支持：

- 未设置 → 空注册表
- JSON 字符串 → parse 后归一化
- 对象 → 直接归一化

加载顺序计算：`getScriptsLoadPlan(files, registry)`

- `registry.order`：优先指定加载顺序
- `registry.disabled[file]=true`：跳过加载
- `normalizeScriptsRegistry` 会：
  - 清理不存在的文件
  - 把新文件追加到末尾（按文件名排序）

### 2.4 入口函数约定（default/setup/install）
对每个脚本模块：

1) 先 `import(modUrl.href)`  
2) 再挑选入口函数（优先级）：
   - `export default function(ctx){...}`
   - `export function setup(ctx){...}`
   - `export function install(ctx){...}`
3) 若入口存在且为函数，则调用 `await fn(ctx)`

也就是说：脚本既可以纯靠 “import 副作用” 注册，也可以把逻辑放在入口函数里（更推荐）。

### 2.5 ctx（脚本上下文）结构
加载器传给脚本的 ctx 字段（见 `src/scripts_loader.js`）：

- `lib, game, ui, get, ai, _status`
- `config`：扩展配置对象（可能为 null）
- `hooks`：HookBus（`game.slqjAiHooks` 或 `game.__slqjAiPersona.hooks`）

> 推荐脚本优先使用 `ctx.hooks` 来注入规则，而不是直接 monkey patch 引擎函数。

### 2.6 加载结果记录（便于调试）
加载器会在 `game.__slqjAiPersona.scripts` 记录：

- `loaded`：成功加载的文件名数组
- `skipped`：被禁用跳过的文件名数组
- `failed`：失败文件名数组
- `order`：本次实际加载顺序

---

## 3) 注册表：slqj_ai_scripts_registry（启用/顺序持久化）

注册表结构（v1）见 `src/scripts_registry.js`：

```js
{
  version: 1,
  order: ["10_xxx.js", "20_yyy.js"],
  disabled: { "22_zzz.js": true }
}
```

保存函数：`saveScriptsRegistry(game, registry)` 会把 JSON 字符串写入：

- `extension_身临其境的AI_slqj_ai_scripts_registry`
- `slqj_ai_scripts_registry`

这样做与扩展其它配置项保持一致。

---

## 4) 管理 UI：scripts 插件管理（模态对话框）

入口：`src/scripts_manager_modal.js -> openScriptsPluginManagerModal(opts)`

功能：

- 单实例：重复打开会先关闭旧实例
- 显示每个脚本的：
  - 启用开关
  - 上移/下移调整顺序
  - 标题/说明（若脚本提供 meta）
- 工具栏：
  - 全部启用
  - 全部禁用
  - 重置为文件名排序
- 底部：
  - 保存并关闭（调用 `saveScriptsRegistry`）
  - 取消

### 4.1 脚本元信息约定：slqjAiScriptMeta
管理 UI 会 import 每个脚本模块并读取：

- `export const slqjAiScriptMeta = { name, version, description }`

注意：

- UI 只读取该对象，不会自动调用脚本入口函数
- 若脚本未提供 meta，则 UI 回退显示文件名

### 4.2 布局与调试

- 触屏/手机端：弹窗以视口中心为基准居中（不使用 `ui.arena/ui.window` 的偏移），避免部分 WebView 下整体偏到左上/右下。
- 调试：在控制台执行 `window.__slqjAiDebugModalLayout = true` 后重新打开弹窗，可输出布局计算日志；用完设回 `false`。

---

## 5) 写一个 scripts 插件（开发者指南）

### 5.1 最小模板

- 导出元信息（可选但推荐）：
  - `slqjAiScriptMeta`
- 导出入口函数（建议 default）：
  - 在入口里订阅 Hook、挂全局技能、或写入 `game.__slqjAiPersona.<yourPlugin>` 运行时状态

### 5.2 推荐的状态存放位置
建议把插件运行时对象挂到：

- `game.__slqjAiPersona.<pluginKey>`

好处：

- 每局自动清空（随 game 生命周期）
- 不污染全局命名空间
- 与扩展其它模块风格一致

### 5.3 Hook 优先级建议
HookBus 支持 `priority`（越大越先执行）：

- 想做“强门禁”（直接禁止某选择）：用更高优先级，并在必要时 `ctx.stop=true`
- 想做“细微加权”：用较低优先级，避免覆盖扩展默认策略

---

## 6) 内置脚本逐个拆解

> 说明：以下脚本位于本扩展根目录 `scripts/`，会被加载器按顺序加载（可在管理 UI 调整）。

---

### 6.1 `01_popular_general_candidates.js`：热门武将候选偏置

元信息：

- name：热门武将候选偏置
- version：1.0.3
- 作用：影响开局 AI 选将候选列表，让热门/强势武将更容易出现并被选择

接入点：

- 包装 `game.chooseCharacter()` 并捕获 `game.createEvent("chooseCharacter")`
- 包装 `event.ai(player, list, list2, back)`：对候选列表做重排/替换

关键机制：

1) **候选热度表**：脚本内手工维护 `POPULAR_KEYS`（不存在于当前环境会自动跳过）
2) **启用比例与概率**：
   - `启用比例=0.5`：随机抽取 AI 玩家的一半进入“判定池”
   - `启用概率=1`：进入判定池后再按概率决定是否启用（当前为 100%）
3) **候选重排/换入**：
   - 将热门 key 尽量换入候选前若干槽位，并整体把热门放前

额外补丁（重要）：

- `patchCharacterReplaceRandomGetExact`：在 `chooseCharacter/chooseCharacterOL` 阶段，把 `lib.characterReplace[key].randomGet()` 强制为“严格返回源 key”，避免候选 key 被随机替换成变体导致“候选与实际不一致”。
- 为避免某些环境源 key 不存在导致 mode 脚本报错，该补丁会先判断 `lib.character[key]` 存在才强制。

潜在副作用：

- 改变选将公平性（让热门更常出现）
- 与其他也在选将阶段 patch `chooseCharacter` 的扩展/脚本可能产生叠加或冲突

---

### 6.2 `10_chain_elemental_teamplay.js`：队友配合（铁索传导）

元信息：

- name：队友配合：铁索传导
- version：1.1.5
- 作用：用“投花（flower）信号”驱动队友协作：铁索连环 + 属性伤害传导；在 AI vs AI 场景可自动确认提高触发率

接入点：

- 订阅 Hook：`slqj_ai_emotion_throw`（由扩展的投掷表情事件提供）
- 运行期大量使用 `get.attitude(...)` 与 `guessIdentityFor(...)` 做敌友判定

关键配置（脚本内 `DEFAULT_CFG`）：

- 目标门槛：敌人手牌下限、队友态度下限、队友血量下限
- 猜测门槛：队友/敌人的 shown 与 confidence 阈值
- 信号与窗口：`signalEmotion="flower"`，确认窗口 `ackWindowMs`，冷却 `cooldownMs`
- 自动确认：`autoAckInAIVsAI=true`（避免无人回投导致永远不执行）

核心流程（概念级）：

1) AI 判断存在“可铁索传导”的收益窗口（有铁索/已有连环/有属性伤害等）
2) 向队友投掷 `flower` 作为“请求确认”
3) 队友在窗口内回投 `flower` 视为同意（脚本可自动回投）
4) 达成确认后执行：铁索连环目标选择 + 属性伤害传导（并包含大量门禁避免误伤）

调试能力（脚本会向 `game.__slqjAiPersona` 暴露若干调试 API）：

- 降低阈值预设（low preset）
- 恢复默认阈值
- 查看当前 cfg 快照
- “锁定全场连环”调试（并阻止解除连环）
- 可选：摸牌阶段额外生成铁索+雷杀（debug extra draw）

潜在副作用：

- 会改变 AI 的表情投掷行为（作为信号）
- 在开启调试功能时可能强行改变连环状态或生成牌（仅建议开发调试）

---

### 6.3 `20_peixiu_takeover.js`：裴秀 AI 接管（行图/爵制）

元信息：

- name：裴秀 AI 接管（行图/爵制）
- version：1.0.3
- 作用：接管裴秀（`peixiu`）关键选牌：优先行图约数摸牌与倍数无次数限制，并优化爵制合成点数的选牌

接入点：

- 订阅 `slqj_ai_score`：对 chooseCard/chooseTarget 等评分注入偏置
- 安装全局跟踪 skill：记录上一张使用牌点数，用于行图 mark 缺失时兜底
- （可选）对托管的玩家本人也生效：脚本额外提供 “managed me” 选择器补丁（解释见脚本内注释）

关键策略摘要：

- 行图（xingtu）偏好：
  - 候选点数与当前行图点数满足“约数/倍数关系”的加权
  - 小点装备更重要（过渡与蓄爆空间）
  - 可选“1 步前瞻”估计“打出后是否更容易续链”
- 爵制（juezhi）选牌：
  - 倾向合成出与行图 mark 相关的点数结果
  - 强烈避免拿关键牌/低点装备去爵制

潜在副作用：

- 对裴秀的出牌序列有显著影响（更贴近人类“滚点数/不断链”的打法）
- 若与其他裴秀 AI 改动脚本叠加，可能导致评分偏置过强

---

### 6.4 `21_wu_zhugeliang_takeover.js`：武诸葛亮 AI 接管（情势/智哲）

元信息：

- name：武诸葛亮 AI 接管（情势/智哲）
- version：1.0.0
- 作用：接管武诸葛亮（`wu_zhugeliang`）关键决策：情势默认优先加伤、谨慎发牌/摸牌（减少消耗牌堆 7 点）；智哲更偏向复制无懈/桃等关键牌并兼顾后续触发情势

接入点：

- patch `lib.skill` 中相关技能的 AI check/选择逻辑（脚本内识别技能 id：`dcjincui/dcqingshi/dczhizhe`）
- 默认只影响本地 AI；对玩家本人仅在托管时可生效（可配置）

关键倾向摘要：

- 情势：更偏“加伤”而不是发牌/自摸（避免过度消耗牌堆中点数为 7 的牌，从而影响尽瘁回满）
- 智哲：更偏复制 `wuxie/tao` 等关键牌，并在需要时为情势制造“同名牌支点”

潜在副作用：

- 改动的是技能 AI 选择逻辑，可能与不同版本/不同包的技能实现存在兼容性差异

---

### 6.5 `22_xin_jushou_zhuge_bonus.js`：界沮授红利（摸牌偏置诸葛连弩）

元信息：

- name：界沮授武将红利（摸牌偏置诸葛连弩）
- version：1.0.1
- 作用：当玩家使用界沮授（`xin_jushou`）时，在摸牌前以一定概率把牌堆中的【诸葛连弩】移动到牌堆顶，从而更容易摸到

接入点：

- 注册全局技能 `slqj_bonus_xin_jushou_zhuge_draw`（触发：`drawBegin`）

关键机制：

- 不凭空生成牌：仅当牌堆（`ui.cardPile`）中存在 `zhuge` 时，才将其 DOM 节点移动到牌堆顶
- 默认触发概率：`0.75`
- 重复保护：若玩家已持有 `zhuge`（手牌/装备区任一处），则触发概率会乘以 `hasCardChanceFactor`（默认 `0.02`，即大幅降低再次摸到第二把的概率）

重要副作用提示（玩家需要知道）：

- 这是“摸牌顺序干预”，会影响公平性/随机性
- 该脚本不限定“仅 AI”，理论上 **人类玩家使用界沮授也会享受红利**

---

### 6.6 `23_xin_jushou_jianying_ai.js`：界沮授 AI 加强（渐营优先）

元信息：

- name：界沮授 AI 加强（出牌优先触发渐营）
- version：1.0.0
- 作用：仅对界沮授（`xin_jushou`）生效：出牌阶段尽可能选择与上一张牌点数/花色相同的出牌序列，以更频繁触发「渐营」（`xinjianying_draw`）摸牌

接入点：

- 订阅 `slqj_ai_score`（chooseCard + 出牌阶段 chooseToUse 上下文）

策略要点：

- 若同一 `phaseUse` 内已有上一张使用牌：
  - 若候选牌与上一张同花色或同点数：显著加权（matchBonus）
- 若本阶段尚无上一张牌：
  - 估算候选牌在手牌里“同花色/同点数的潜在连锁数量”，作为“起手铺垫”的轻度加权（setupBonus）

影响范围控制：

- 默认仅本地 AI；对玩家本人仅在托管时可生效（可配置）

---

### 6.7 `30_friendly_rage_egg_throw.js`：友善互动（怒气丢鸡蛋）

元信息：

- name：友善互动：怒气丢鸡蛋
- version：1.1.2
- 作用：当本地 AI 对某玩家的“定向怒气”达到阈值时投掷鸡蛋表情；阶段 2 会按人格进行高频连丢，并可能在后续随机回合追加连丢；另含首回合极端速杀彩蛋（小概率触发“肢解鸡蛋大战”）

接入点：

- 不通过 `slqj_ai_score` 改策略；只影响 `throwEmotion(...)` 的表情投掷
- 注册多个全局技能，在事件后检查怒气阈值：
  - `slqj_ai_friendly_egg_damage`：本地 AI `damageEnd` 后（对来源的定向怒气通常会升高）
  - `slqj_ai_friendly_egg_guohe`：本地 AI 成为过河拆桥目标的 `rewriteDiscardResult`
  - `slqj_ai_friendly_egg_shunshou`：本地 AI 成为顺手牵羊目标的 `rewriteGainResult`
  - `slqj_ai_friendly_egg_turn_tick`：每回合 `phaseBeginStart` tick（用于触发“追加连丢”的随机回合任务）

关键参数（脚本内 `CFG`）：

- 阶段 1 阈值：`stage1Threshold=6`（达到则丢 1 个鸡蛋）
- 阶段 2 阈值：`stage2Threshold=14`（达到则进入高频连丢）
- 滞回：`hysteresis=0.6`（避免阈值附近抖动反复触发）
- 高频连丢间隔：`burstIntervalMs=250`
- 阶段 2 持续时间：短 `2000ms` / 长 `10000ms`（按人格选择），并按“超过阈值的怒气值”追加时长（封顶）
- 防刷屏：`maxBurstTargets=2`（同一 AI 同时最多对 2 个目标连丢）
- 彩蛋：首回合“肢解鸡蛋大战”参数（默认开启）
  - 触发条件：首回合内，本地 AI 回合开始满血，且被同一名玩家在该回合内打入濒死/击杀
  - 触发概率：`instakillWarChance=0.08`
  - 对砸持续：`instakillWarPairMs=0`（0 表示直到游戏结束；也可改为固定毫秒数到期自动结束）
  - 对砸节奏：`instakillWarCooldownMs/instakillWarDelayMsMin/instakillWarDelayMsMax`
  - 单方面补偿：若对方不是本地 AI（无法自动反击），则由濒死方按 `instakillWarBurstMs/instakillWarBurstIntervalMs` 单方面连砸一段时间
- 死亡互动（默认开启）：允许死亡角色也能扔鸡蛋/被扔鸡蛋（表现层互动，不影响结算）
  - `allowDeadThrow=true`
  - `allowDeadTarget=true`

潜在副作用：

- 会显著改变观战体验/屏幕表情数量（尤其阶段 2 高频连丢）
- 由于它不改变出牌/策略，属于纯“表现层互动”，适合想增强沉浸感但不想改强度的用户
  - 若触发“肢解鸡蛋大战”，可能出现更长时间的互砸/刷屏（可在脚本内关闭或调低概率）

---

### 6.8 技能自定义tag补全（框架）【已迁移至扩展核心】

说明：

- 该功能已从 scripts 插件迁移至扩展核心（不再由 `slqj_ai_scripts_enable` 控制）
- 入口会注册多个处理器（processor），处理器基于技能文本说明（正则匹配）推导 tag，并汇总写入 `lib.skill[skillId].ai`，以便后续通过 `hasSkillTag` 精准识别技能特征
- 执行时机固定为：首轮开始前（`gameStart`）对本局出现的技能补全；并在技能增减（`addSkillCheck`）时对新增技能增量补全（不再提供配置项）

实现要点（当前核心位置）：

- 核心入口：`src/ai_persona/skill_custom_tags/index.js`
- 子模块目录：`src/ai_persona/skill_custom_tags/`
- 处理器框架：`src/ai_persona/skill_custom_tags/framework.js`
- 正则片段：`src/ai_persona/skill_custom_tags/patterns.js`
- tag 常量：`src/ai_persona/skill_custom_tags/tags.js`
- 处理器注册表：`src/ai_persona/skill_custom_tags/processors/index.js`
- 处理器目录（更深一层）：`src/ai_persona/skill_custom_tags/processors/*/*.js`
- 内置处理器（当前）：
  - `active_maixie`：主动卖血（出牌阶段失去体力/受伤）
  - `passive_maixie`：被动卖血（受伤/失去体力后触发收益）
  - `respond_shan`：回合外防御（可响应【闪】/视为打出【闪】）
  - `respond_sha`：回合外响应（可响应【杀】/视为打出【杀】）
  - `respond_wuxie`：无懈（可使用/视为使用【无懈可击】）
  - `draw_self`：自己摸牌/补牌
  - `draw_other`：令他人摸牌/补牌
  - `discard_self`：自己弃牌
  - `discard_other`：令他人弃牌
  - `gain_other_cards`：获得他人牌（夺牌/获得其区域牌）
  - `give_cards`：交给/赠予他人牌
  - `recover_self`：回复自己体力
  - `recover_other`：令他人回复体力
  - `distance`：距离/攻击范围修正、无距离限制
  - `sha_extra`：额外出杀/无限出杀（次数相关）
  - `force_response`：强制响应（强制他人打出【闪/杀】否则受罚）
  - `forbid_cards`：禁牌（不能/不得使用或打出牌/【杀】/【闪】/【无懈可击】等）
  - `damage_other`：对他人造成伤害
  - `control_turnover`：翻面控制
  - `control_link`：横置/连环控制
  - `rejudge`：改判
  - `save`：濒死救援（保守识别）
- 写入位置：`lib.skill[skillId].ai[tag]=true`（因此可通过 `player.hasSkillTag(tag)` 读取）
- 运行期状态：
  - `game.__slqjAiPersona.skillCustomTags`：已推导出的 skillId->tags（增量累积）
  - `game.__slqjAiPersona.skillCustomTagsScanReport`：最后一次扫描/命中统计
  - `game.__slqjAiPersona.skillCustomTagsReport`：最后一次写入 `skill.ai` 的结果（missing/跳过等）

示例（当前内置）：

- 黄盖 `kurou`（苦肉）：`slqj_ai_maixie` + `slqj_ai_active_maixie` + `slqj_ai_draw_self`

---

## 7) 与扩展核心机制的关系（建议理解）

- scripts 是“策略层”，通常建立在：
  - `slqj_ai_score`（改评分）
  - `slqj_ai_attitude`（改态度）
  - `slqj_ai_emotion_throw`（用表情做信号/交互）
- 当你发现“脚本没生效”，优先排查：
  1) 是否关闭了 `slqj_ai_scripts_enable`
  2) 脚本是否在 registry 中被禁用或顺序被调整到很后
  3) 目标是否是“本地 AI 玩家”（脚本很多默认不影响人类玩家手操）
  4) 是否处于联机连接模式（connectMode）
