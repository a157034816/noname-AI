/**
 * 本文件用于集中定义 JSDoc 类型（供编辑器/静态分析使用）。
 *
 * 约束：
 * - 不包含任何运行时逻辑
 * - 不要在此处引入会改变行为的代码
 */
export {};

/**
 * 人格类型枚举。
 * @typedef {"balanced"|"impulsive"|"petty"|"camouflage"} PersonaId
 */

/**
 * 人格特质参数。
 * @typedef {{aggressiveness:number, randomness:number, revengeWeight:number, insight:number, camouflageRounds:number}} PersonaTraits
 */

/**
 * 人格配置。
 * @typedef {{id: PersonaId, traits: PersonaTraits}} Persona
 */

/**
 * 身份猜测的可用 id（不读取真实身份，仅用于“猜测结果”的展示/逻辑）。
 * @typedef {"zhu"|"zhong"|"mingzhong"|"fan"|"nei"|"unknown"} IdentityId
 */

/**
 * 心智模型：对他人的印象/证据/仇恨/主公线索等。
 * @typedef {{
 *  firstImpression: Record<string, number>,
 *  evidence: Record<string, number>,
 *  grudge: Record<string, number>,
 *  rage: number,
 *  rageTowards: Record<string, number>,
 *  zhuSignal: Record<string, number>,
 *  zhuHelp: Record<string, number>,
 *  zhuHarm: Record<string, number>,
 *  habits?: {
 *    jiuSearchSha?: ("heuristic"|"conservative")
 *  },
 * }} SlqjAiMemory
 */

/**
 * 运行期状态核心字段（便于与新增字段解耦）。
 * @typedef {{turnsTaken:number, installedAtRound:number, _impressionInited?:boolean, _habitsInited?:boolean, recentAttack?: ({targetPid:string, cardName:string, setAtRound:number}|null)}} SlqjAiRuntimeCore
 */

/**
 * 运行期状态（仅本局有效）。
 * @typedef {SlqjAiRuntimeCore & {turnMemory?: SlqjAiTurnMemory}} SlqjAiRuntime
 */

/**
 * 统计信息（用于 UI 展示/策略）。
 * @typedef {{
 *  draw:number,
 *  damageDealt:number,
 *  outputCore?: boolean, // 输出核心（本局内）：在任意连续两回合达标后锁定为 true
 *  turnDraw?: number, // 当前回合（自身回合）内累计过牌
 *  turnDamageDealt?: number, // 当前回合（自身回合）内累计造成伤害
 *  prevTurnDraw?: number, // 上一回合（自身回合）内累计过牌
 *  prevTurnDamageDealt?: number, // 上一回合（自身回合）内累计造成伤害
 * }} SlqjAiStats
 */

/**
 * 回合内记忆：仅在“当前回合”有效，随回合切换清空。
 *
 * 用途：
 * - 让 AI 在同一回合内能回看“谁对谁造成了扣血/加血/弃牌/摸牌”
 * - 供 UI/调试查看（不持久化）
 *
 * @typedef {{turnId:number, activePid:string, events: SlqjAiTurnEvent[]}} SlqjAiTurnMemory
 */

/**
 * 回合事件类型枚举。
 * @typedef {"damage"|"loseHp"|"recover"|"discard"|"draw"} SlqjAiTurnEventKind
 */

/**
 * 回合内事件记录（尽量只存公开信息）。
 *
 * 约定：
 * - sourcePid：造成该事件的一方（缺失时可为空字符串）
 * - targetPid：承受/获得该事件影响的一方
 *
 * @typedef {{
 *  kind: SlqjAiTurnEventKind,
 *  sourcePid: string,
 *  targetPid: string,
 *  num?: number,
 *  via?: string,
 *  cardNames?: string[],
 *  cardName?: string,
 * }} SlqjAiTurnEvent
 */

/**
 * player.storage[STORAGE_KEY] 对应的扩展存储结构（字段可能随版本演进）。
 * @typedef {{persona: Persona|null, memory: SlqjAiMemory, runtime: SlqjAiRuntime, stats?: SlqjAiStats}} SlqjAiStorage
 */

/**
 * Hook Bus 订阅选项。
 * @typedef {{priority?:number, once?:boolean}} SlqjAiHookOptions
 */

/**
 * Hook Bus（事件总线）结构。
 * @typedef {{
 *  on: (name:string, fn:(ctx:any)=>any, opts?:SlqjAiHookOptions)=>Function,
 *  off: (name:string, fn:Function)=>void,
 *  emit: (name:string, ctx:any)=>any,
 *  has: (name:string)=>boolean,
 *  clear: (name?:string)=>void,
 *  list: ()=>string[]
 * }} SlqjAiHookBus
 */

/**
 * 扩展配置（lib.config / 传入 config）中涉及本扩展的字段集合。
 * @typedef {{
 *  slqj_ai_inspect_lang?: ("zh"|"en"|string),
 *  slqj_ai_inspect_enable?: boolean,
 *  slqj_ai_blind_handcard_random?: boolean,
 *  slqj_ai_score_noise_enable?: boolean,
 *  slqj_ai_output_core_draw_threshold?: (number|string),
 *  slqj_ai_output_core_damage_threshold?: (number|string),
 *  slqj_ai_persona_enable_balanced?: boolean,
 *  slqj_ai_persona_enable_impulsive?: boolean,
 *  slqj_ai_persona_enable_petty?: boolean,
 *  slqj_ai_persona_enable_camouflage?: boolean,
 *  slqj_ai_scripts_enable?: boolean,
 *  slqj_ai_scripts_registry?: (string|object),
 *  slqj_ai_scripts_debug?: boolean
 * }} SlqjAiExtensionConfig
 */ 
