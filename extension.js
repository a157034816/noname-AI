import { lib, game, ui, get, ai, _status } from "../../noname.js";
import { installPersonaSystem } from "./src/ai_persona/index.js";
import { installEmotionThrowEvent } from "./src/ai_persona/emotion_throw_event.js";
import { installSkillCustomTags } from "./src/ai_persona/skill_custom_tags/index.js";
import { loadExtensionScripts } from "./src/scripts_loader.js";
import { openScriptsPluginManagerModal } from "./src/scripts_manager_modal.js";
import { maybeAutoCheckForUpdates } from "./src/update/auto_check.js";
import { openUpdateModal } from "./src/update/update_modal.js";
import { SLQJ_AI_EXTENSION_VERSION } from "./src/version.js";
export const type = "extension";

/**
 * @typedef {import("./src/ai_persona/lib/jsdoc_types.js").SlqjAiExtensionConfig} SlqjAiExtensionConfig
 */

/**
 * 扩展入口：返回无名杀扩展定义对象。
 *
 * 说明：
 * - precontent 中安装人格系统、互动事件与 scripts 插件加载器
 * - config 中暴露可配置项（保存后建议重启生效）
 *
 * @returns {Object}
 */
export default function(){
			return {name:"身临其境的AI",editable:true,connect:false,
		/**
		 * 场景就绪回调（预留）。
		 * @returns {void}
		 */
		arenaReady:function(){
    
},
		/**
		 * 扩展内容定义（预留）。
		 * @param {SlqjAiExtensionConfig|any} config
		 * @param {*} pack
		 * @returns {void}
		 */
		content:function(config,pack){
    
},
		/**
		 * 扩展 prepare 阶段（预留）。
		 * @returns {void}
		 */
		prepare:function(){
    
},
		/**
		 * 扩展 precontent 阶段：安装人格系统、互动事件、scripts 加载器。
		 * @param {SlqjAiExtensionConfig|any} config
		 * @returns {void}
		 */
		precontent:function(config){
			try{
				installPersonaSystem({ lib, game, get, ai, _status, config });
			}catch(e){
				console.error("[身临其境的AI] installPersonaSystem failed", e);
			}

			/** 核心：技能自定义 tag 补全（基于技能说明正则匹配推导并写入 skill.ai）。 */
			try{
				installSkillCustomTags({ lib, game, ui, get, ai, _status, config });
			}catch(e){
				console.error("[身临其境的AI] installSkillCustomTags failed", e);
			}

		/** 互动事件：监听 `player.throwEmotion(...)` 并通过 game.slqjAiHooks 分发。 */
		try{
			installEmotionThrowEvent({ lib, game, _status });
		}catch(e){
			console.error("[身临其境的AI] installEmotionThrowEvent failed", e);
		}

		/** 扩展脚本插件：加载 `scripts/` 下的一层脚本文件（可通过 game.slqjAiHooks 注册 hook）。 */
		try{
			loadExtensionScripts({ baseUrl: import.meta.url, lib, game, ui, get, ai, _status, config }).catch(function(e){
				console.error("[身临其境的AI] loadExtensionScripts failed", e);
			});
	}catch(e){
		console.error("[身临其境的AI] loadExtensionScripts failed", e);
	}

		/** 自动检查更新（节流；发现新版本仅提示控制台，需手动在设置里打开“检查更新/更新”）。 */
		try{
			maybeAutoCheckForUpdates({ baseUrl: import.meta.url, lib, game, config, currentVersion: SLQJ_AI_EXTENSION_VERSION, connectMode: _status && _status.connectMode }).catch(function(e){
				console.error("[身临其境的AI] maybeAutoCheckForUpdates failed", e);
			});
		}catch(e){
			console.error("[身临其境的AI] maybeAutoCheckForUpdates failed", e);
		}
},config:{
	slqj_ai_inspect_lang:{
		name:'AI标记用语',
		intro:'设置AI标记详情中的名词显示语言（默认：中文；修改后建议重启生效）',
		init: lib.config.slqj_ai_inspect_lang===undefined?'zh':lib.config.slqj_ai_inspect_lang,
		item:{en:'英文',zh:'中文'},
		/**
		 * @param {"en"|"zh"|string} item
		 * @returns {void}
		 */
		onclick:function(item){
			game.saveConfig('extension_身临其境的AI_slqj_ai_inspect_lang',item);
			game.saveConfig('slqj_ai_inspect_lang',item);
		},
	},
	slqj_ai_inspect_enable:{
		name:'开局添加AI标记(Debug)',
		intro:'开启后在游戏开始时为所有角色添加AI查看标记（默认：关闭；修改后建议重启生效）',
		init: lib.config.slqj_ai_inspect_enable===undefined?false:lib.config.slqj_ai_inspect_enable,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_inspect_enable',bool);
			game.saveConfig('slqj_ai_inspect_enable',bool);
		},
	},
	slqj_ai_blind_handcard_random:{
		name:'盲选手牌随机化（反全知）',
		intro:'开启后，本地AI在“手牌不可见”的盲选场景（如盲摸/盲拆）不再依据真实牌面做最优选择，而改为随机选择手牌；仅影响不可见的手牌按钮，明牌/可观手牌仍按原逻辑选择（默认：开启；修改后建议重启生效）',
		init: lib.config.slqj_ai_blind_handcard_random===undefined?true:lib.config.slqj_ai_blind_handcard_random,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_blind_handcard_random',bool);
			game.saveConfig('slqj_ai_blind_handcard_random',bool);
		},
	},
	slqj_ai_score_noise_enable:{
		name:'评分噪声（仅冲动型）',
		intro:'开启后，仅“冲动型(impulsive)”人格在选择卡牌/目标/按钮时会对评分加入少量噪声；为避免明显不合理选择，噪声不会把0/负收益抬成正收益（默认：开启；修改后建议重启生效）',
		init: lib.config.slqj_ai_score_noise_enable===undefined?true:lib.config.slqj_ai_score_noise_enable,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_score_noise_enable',bool);
			game.saveConfig('slqj_ai_score_noise_enable',bool);
		},
	},
	slqj_ai_persona_enable_balanced:{
		name:'启用人格：均衡（Balanced）',
		intro:'开启后，开局随机人格时可能抽到“均衡(balanced)”（默认：开启；修改后建议重启生效）',
		init: lib.config.slqj_ai_persona_enable_balanced===undefined?true:lib.config.slqj_ai_persona_enable_balanced,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_persona_enable_balanced',bool);
			game.saveConfig('slqj_ai_persona_enable_balanced',bool);
		},
	},
	slqj_ai_persona_enable_impulsive:{
		name:'启用人格：冲动（Impulsive）',
		intro:'开启后，开局随机人格时可能抽到“冲动(impulsive)”（默认：开启；修改后建议重启生效）',
		init: lib.config.slqj_ai_persona_enable_impulsive===undefined?true:lib.config.slqj_ai_persona_enable_impulsive,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_persona_enable_impulsive',bool);
			game.saveConfig('slqj_ai_persona_enable_impulsive',bool);
		},
	},
	slqj_ai_persona_enable_petty:{
		name:'启用人格：记仇（Petty）',
		intro:'开启后，开局随机人格时可能抽到“记仇(petty)”（默认：开启；修改后建议重启生效）',
		init: lib.config.slqj_ai_persona_enable_petty===undefined?true:lib.config.slqj_ai_persona_enable_petty,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_persona_enable_petty',bool);
			game.saveConfig('slqj_ai_persona_enable_petty',bool);
		},
	},
	slqj_ai_persona_enable_camouflage:{
		name:'启用人格：伪装（Camouflage）',
		intro:'开启后，开局随机人格时可能抽到“伪装(camouflage)”；该人格仅在身份局反贼时会压制前期对主公敌意（默认：关闭；修改后建议重启生效）',
		init: lib.config.slqj_ai_persona_enable_camouflage===undefined?false:lib.config.slqj_ai_persona_enable_camouflage,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_persona_enable_camouflage',bool);
			game.saveConfig('slqj_ai_persona_enable_camouflage',bool);
		},
	},
	slqj_ai_scripts_enable:{
		name:'加载 scripts 插件',
		intro:'开启后会自动加载扩展目录 scripts/ 下的一层脚本文件（用于自定义 hook/规则；默认：开启；修改后建议重启生效）',
		init: lib.config.slqj_ai_scripts_enable===undefined?true:lib.config.slqj_ai_scripts_enable,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_scripts_enable',bool);
			game.saveConfig('slqj_ai_scripts_enable',bool);
		},
	},
	slqj_ai_scripts_manager:{
		name:'scripts 插件管理',
		intro:'打开模态对话框管理 scripts/ 脚本插件：可单独启用/禁用并调整加载顺序（保存后建议重启生效）',
		clear:true,
		/**
		 * @returns {void}
		 */
		onclick:function(){
			try{
				openScriptsPluginManagerModal({ baseUrl: import.meta.url, lib, game, ui, config: lib.config });
			}catch(e){
				console.error("[身临其境的AI] openScriptsPluginManagerModal failed", e);
			}
		},
	},
	slqj_ai_update_auto_check:{
		name:'启动时自动检查更新',
		intro:'开启后会在启动时（节流）从 GitHub Releases 检查新版本；发现更新不会自动下载，需要在“检查更新/更新”里确认后才会覆盖更新（默认：开启）',
		init: lib.config.slqj_ai_update_auto_check===undefined?true:lib.config.slqj_ai_update_auto_check,
		/**
		 * @param {boolean} bool
		 * @returns {void}
		 */
		onclick:function(bool){
			game.saveConfig('extension_身临其境的AI_slqj_ai_update_auto_check',bool);
			game.saveConfig('slqj_ai_update_auto_check',bool);
		},
	},
	slqj_ai_update_check:{
		name:'检查更新/更新',
		intro:'打开更新弹窗：检查最新版本并可一键下载覆盖更新（自动更新仅在支持写文件的环境可用；更新后需重启生效）',
		clear:true,
		/**
		 * @returns {void}
		 */
		onclick:function(){
			try{
				openUpdateModal({ baseUrl: import.meta.url, lib, game, ui, config: lib.config, currentVersion: SLQJ_AI_EXTENSION_VERSION }).catch(function(e){
					console.error("[身临其境的AI] openUpdateModal failed", e);
				});
			}catch(e){
				console.error("[身临其境的AI] openUpdateModal failed", e);
			}
		},
	},
	slqj_ai_join_group_link:{
		name:'<span style="text-decoration: underline;">加群</span>',
		intro:'点击后访问加群链接：https://qm.qq.com/q/dsLvzGUvhC',
		clear:true,
		/**
		 * 点击访问加群链接。
		 * @returns {void}
		 */
		onclick:function(){
			var url = "https://qm.qq.com/q/dsLvzGUvhC";
			try{
				if (game && typeof game.open === "function") {
					game.open(url);
					return;
				}
			}catch(e){}
			try{
				// Electron 客户端优先使用 openExternal（避免在 iframe 内打开）
				// @ts-ignore
				if (typeof window.require === "function") {
					// @ts-ignore
					var electron = window.require("electron");
					if (electron && electron.shell && typeof electron.shell.openExternal === "function") {
						electron.shell.openExternal(url);
						return;
					}
				}
			}catch(e){}
			try{
				window.open(url);
			}catch(e){
				console.error("[身临其境的AI] open join group url failed", e);
			}
		},
	},
},help:{
    "身临其境的AI": [
		'<div style="margin:10px"><b>身临其境的AI</b>（仅本地单机 AI）</div>',
		'<ul style="margin-top:0">',
		'<li>为本地 AI 增加“人格/心智模型”，并提供可视化 AI 面板（需开启“开局添加AI标记(Debug)”后，头像旁出现 <b>AI</b> 标记，点击可查看）。</li>',
		'<li>身份局提供独立身份猜测（不读取引擎真实身份），并随回合推进衰减线索。</li>',
		'<li>可选：盲选手牌随机化（反全知）、评分噪声（仅冲动型）。</li>',
		'<li>支持 <b>scripts</b> 脚本插件：加载扩展目录 <b>scripts/</b> 下一层脚本，并可在“scripts 插件管理”里启用/禁用与调整顺序。</li>',
		'<li>支持 <b>检查更新/更新</b>：从 GitHub Releases 检查新版本；在支持写文件的环境可一键下载并覆盖更新（需重启生效）。</li>',
		'</ul>',

		'<div style="margin:10px"><b>生效范围（重要）</b></div>',
		'<ul style="margin-top:0">',
		'<li>仅对本地单机 AI 生效；联机/连接模式（<b>_status.connectMode</b>）下多数功能会跳过。</li>',
		'<li><b>默认不影响玩家本人手操</b>；当你进入托管（自机 <b>isAuto</b>）时，本扩展的 AI 评分/策略与 scripts 插件会对你生效。</li>',
		'<li>开局会为全场角色（含自机）初始化并持续更新人格/心智模型/怒气/回合记忆等属性（用于面板查看与托管接管）。</li>',
		'<li>人格与记忆仅本局有效，不会持久化到下局。</li>',
		'<li>修改配置或调整 scripts 顺序后，通常需要重启才能完全生效。</li>',
		'</ul>',

		'<div style="margin:10px"><b>人格类型（开局随机，整局固定）</b></div>',
		'<ul style="margin-top:0">',
		'<li><b>均衡（Balanced）</b>：整体稳健，traits 接近默认值。</li>',
		'<li><b>冲动（Impulsive）</b>：更激进，洞察偏低；开启“评分噪声（仅冲动型）”后，对正收益候选加入少量随机扰动。</li>',
		'<li><b>记仇（Petty）</b>：更在意受伤来源，对仇恨目标更容易持续报复（态度与选目标都会偏向“报复”）。</li>',
		'<li><b>伪装（Camouflage）</b>：仅反贼身份生效；前若干回合压制对主公的敌意，更像“装忠/不跳反”。</li>',
		'</ul>',

		'<div style="margin:10px"><b>特质字段（面板可见，节选）</b></div>',
		'<ul style="margin-top:0">',
		'<li><b>激进 Aggressiveness</b>：越高越倾向进攻/把未知当潜在敌人。</li>',
		'<li><b>洞察 Insight</b>：证据对态度的影响强度（越高越敢从行为线索下判断）。</li>',
		'<li><b>记仇权重 Revenge Weight</b>：仇恨对态度与选目标的影响强度。</li>',
		'<li><b>随机 Randomness</b>：仅在启用评分噪声时用于冲动型，给评分加入少量对称噪声（不会把 0/负收益抬成正收益）。</li>',
		'<li><b>伪装回合 Camo Rounds</b>：伪装型压制对主公敌意的持续回合数。</li>',
		'</ul>',

		'<div style="margin:10px"><b>内置 scripts（默认随扩展安装，可在“scripts 插件管理”禁用/排序）</b></div>',
		'<ul style="margin-top:0">',
		'<li><b>热门武将候选偏置</b>：影响开局 AI 选将候选列表，让热门/强势武将更容易被选中。</li>',
		'<li><b>点绛唇：AI禁将时机优化</b>：检测点绛唇启用后，把 AI 禁将提前到选将阶段；若 AI 候选中出现“AI禁用”武将则自动重抽替换，直到候选不含禁将。</li>',
		'<li><b>队友配合：铁索传导</b>：基于投花信号进行队友协作：铁索连环 + 属性伤害传导（AI vs AI 场景可自动确认以提高触发率）。</li>',
		'<li><b>裴秀 AI 接管（行图/爵制）</b>：接管裴秀关键选牌，优化行图摸牌与爵制合成点数策略。</li>',
		'<li><b>武诸葛亮 AI 接管（情势/智哲）</b>：接管武诸葛亮关键决策：情势偏加伤、谨慎过牌；智哲偏复制无懈/桃等关键牌。</li>',
		'<li><b>界沮授武将红利（摸牌偏置诸葛连弩）</b>：干预摸牌顺序让诸葛连弩更容易被摸到；会影响随机性/公平性，不需要该效果请关闭。</li>',
		'<li><b>界沮授 AI 加强（出牌优先触发渐营）</b>：出牌阶段尽可能凑花色/点数以更频繁触发渐营摸牌。</li>',
		'<li><b>友善互动：怒气丢鸡蛋</b>：怒气达到阈值时投掷鸡蛋表情（不改变出牌策略）。</li>',
		'</ul>',
	].join(""),
},package:{
    character: {
        character: {
        },
        translate: {
        },
    },
    card: {
        card: {
        },
        translate: {
        },
        list: [],
    },
    skill: {
        skill: {
        },
        translate: {
        },
    },
    intro: "为本地单机 AI 增加人格/心智模型、独立身份猜测、AI 面板与 scripts 插件系统, 修改出牌/少数技能策略。\n 因为个人精力有限, 无法大量进行测试, 所以我很需要听到你们的声音...",
    author: "乐白/Q群:1082672096",
    diskURL: "",
    forumURL: "",
    version: SLQJ_AI_EXTENSION_VERSION,
},files:{"character":[],"card":[],"skill":[],"audio":[]}} 
};
