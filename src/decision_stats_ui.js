import logManager from "./logger/manager.js";
import { openAiDecisionStatsModal } from "./decision_stats_modal.js";

const SHORTCUT_BTN_ATTR = "data-slqj-ai-decision-btn";

/**
 * 安装“AI决策”统计面板入口：
 * - 暂停快捷菜单（重来/托管/退出/记录）增加“AI决策”按钮
 * - 通过 patch `ui.selected.*.add` 与 `ui.click.skill` 将“最终选中项”回传到决策统计器
 *
 * @param {{lib:any, game:any, ui:any, get:any}} opts
 * @returns {void}
 */
export function installAiDecisionStatsUi(opts) {
  const lib = opts && opts.lib ? opts.lib : null;
  const game = opts && opts.game ? opts.game : null;
  const ui = opts && opts.ui ? opts.ui : null;
  const get = opts && opts.get ? opts.get : null;
  if (!game || !ui) return;

  // 仅本地单机：联机/连接模式下不安装（避免污染）
  try {
    if (globalThis?._status?.connectMode) return;
  } catch (e) {}

  const hooks = game.slqjAiHooks || game.__slqjAiPersona?.hooks || null;
  const decisionStats = hooks && typeof hooks === "object" ? hooks.__slqjAiDecisionStats : null;
  if (!decisionStats) return;

  /**
   * patch `ui.selected.*.add`：在“最终选中项”确认后，通知统计器结束当前决策步。
   *
   * 说明：
   * - 引擎会通过 `ui.selected.cards/targets/buttons.add(x)` 记录当前选中项；
   * - 我们借此回调 `decisionStats.finalizeSelection(kind, x)` 做命中/选用归因。
   *
   * @param {any[]} list
   * @param {"chooseCard"|"chooseTarget"|"chooseButton"} kind
   * @returns {void}
   */
  function patchSelectedAdd(list, kind) {
    if (!list || typeof list !== "object") return;
    if (list.__slqjAiDecisionStatsAddPatched) return;
    const originalAdd = list.add;
    if (typeof originalAdd !== "function") return;

    Object.defineProperty(list, "__slqjAiDecisionStatsAddPatched", { value: true, configurable: true });
    Object.defineProperty(list, "__slqjAiDecisionStatsAddOriginal", { value: originalAdd, configurable: true });

    list.add = function () {
      const res = originalAdd.apply(this, arguments);
      try {
        if (decisionStats && typeof decisionStats.finalizeSelection === "function") {
          for (const x of Array.from(arguments)) decisionStats.finalizeSelection(kind, x);
        }
      } catch (e) {}
      return res;
    };
  }

  // 选中项回传：cards/targets/buttons
  try {
    patchSelectedAdd(ui.selected?.cards, "chooseCard");
    patchSelectedAdd(ui.selected?.targets, "chooseTarget");
    patchSelectedAdd(ui.selected?.buttons, "chooseButton");
  } catch (e) {}

  // 技能选择（chooseCard 里可能会选到技能字符串）：通过 ui.click.skill 回传
  try {
    if (ui.click && typeof ui.click.skill === "function" && !ui.click.__slqjAiDecisionStatsSkillPatched) {
      const originalSkill = ui.click.skill;
      ui.click.__slqjAiDecisionStatsSkillPatched = true;
      ui.click.skill = function (skill) {
        const res = originalSkill.apply(this, arguments);
        try {
          if (typeof skill === "string" && decisionStats && typeof decisionStats.finalizeSelection === "function") {
            decisionStats.finalizeSelection("chooseCard", skill);
          }
        } catch (e) {}
        return res;
      };
    }
  } catch (e) {}

  // 暂停快捷菜单按钮注入：AI决策
  try {
    if (!ui.shortcut || !ui.create || typeof ui.create.div !== "function") return;
    const existing = ui.shortcut.querySelector
      ? ui.shortcut.querySelector(`[${SHORTCUT_BTN_ATTR}]`)
      : null;
    if (existing) return;

    const btn = ui.create.div(
      ".menubutton.round",
      "<span>决策</span>",
      ui.shortcut,
      function (e) {
        try {
          e && e.stopPropagation && e.stopPropagation();
        } catch (e2) {}
        try {
          // 先关闭快捷暂停菜单，避免与遮罩层叠加
          ui.click && ui.click.shortcut && ui.click.shortcut(false);
        } catch (e2) {}
        try {
          openAiDecisionStatsModal({ game, ui });
        } catch (err) {
          try {
            logManager.error("decision_stats", "open modal failed", err);
          } catch (e2) {}
        }
      }
    );
    btn.dataset.position = 5;
    btn.setAttribute(SHORTCUT_BTN_ATTR, "1");

    // 兜底：部分主题会把 span 内容过度缩放，强制保持字距
    try {
      btn.style.letterSpacing = "0";
    } catch (e) {}
  } catch (e) {
    try {
      logManager.error("decision_stats", "inject shortcut button failed", e);
    } catch (e2) {}
  }
}
