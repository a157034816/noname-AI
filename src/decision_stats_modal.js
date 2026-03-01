import { createModalShell } from "./scripts_manager_modal.js";

const ROOT_ID = "slqj-ai-decision-stats-root";

/**
 * 决策类型筛选：
 * - all：合并统计（选牌+选目标+选按钮）
 * - chooseCard：选牌
 * - chooseTarget：选目标
 * - chooseButton：选按钮
 *
 * @typedef {"all"|"chooseCard"|"chooseTarget"|"chooseButton"} DecisionStatsKindFilter
 */

/**
 * 将 n/d 格式化为百分比字符串（尽量保留可读性）。
 *
 * @param {number} n
 * @param {number} d
 * @returns {string}
 */
function formatRate(n, d) {
  if (!d) return "0%";
  const pct = Math.max(0, Math.min(100, (n / d) * 100));
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

/**
 * 将策略来源（origin）缩短为更易读的文件名片段。
 *
 * @param {string} origin
 * @returns {string}
 */
function shortenOrigin(origin) {
  const s = String(origin || "").trim();
  if (!s) return "";
  const noQuery = s.split("?")[0];
  const parts = noQuery.split(/[\\/]/);
  return parts[parts.length - 1] || noQuery;
}

/**
 * 将 Error.stack 规范化为更易读的展示文本。
 *
 * 说明：
 * - 去掉首行 `Error`，避免用户误以为发生了报错（这里只是用 Error 来拿调用栈）。
 * - 保留后续 frame 行用于定位策略注册位置（会清理掉行首 `at` 与 hook_bus 内部帧）。
 *
 * @param {string} stack
 * @returns {string}
 */
function normalizeStackText(stack) {
  let s = String(stack || "");
  if (!s) return "";
  s = s.replace(/\r\n/g, "\n");
  // 兼容部分 WebView/压缩堆栈格式：两条 frame 可能被拼在同一行里，例如 `...:1:2)at foo(...)`。
  // 这里把 `)at` / `) at` 断开成换行，避免用户看到一长串“像报错”的文本。
  s = s.replace(/\)\s*at\b/g, ")\n at");
  // 兼容 `)atasync` 这类缺少空格的情况（少见，但出现时也能拆开）。
  s = s.replace(/\)\s*at(?=async\b)/g, ")\n at ");
  const lines = s
    .split("\n")
    .map((l) => String(l || "").trimEnd())
    .filter(Boolean);

  if (lines.length && String(lines[0] || "").trim().startsWith("Error")) {
    lines.shift();
  }

  // 为了更直观：去掉 hook_bus 内部帧，保留真正的“策略注册来源”链路。
  const cleaned = lines
    .map((l) => String(l || "").trim())
    .filter(Boolean)
    .filter((l) => !l.includes("hook_bus.js") && !l.includes("createHookBus"))
    // 去掉每行开头的 `at`，减少“报错感”（仍保留完整定位信息）。
    .map((l) => l.replace(/^at\s+/i, ""));

  return cleaned.join("\n");
}

/**
 * 从某策略的 statsByKind 中按筛选类型取出（或合并）计数器。
 *
 * @param {any} statsByKind
 * @param {DecisionStatsKindFilter} filter
 * @returns {{cover:number, hit:number, pick:number}}
 */
function pickCounters(statsByKind, filter) {
  const st = statsByKind && typeof statsByKind === "object" ? statsByKind : null;
  const zero = { cover: 0, hit: 0, pick: 0 };
  if (!st) return zero;
  if (filter !== "all") return st[filter] || zero;
  const a = st.chooseCard || zero;
  const b = st.chooseTarget || zero;
  const c = st.chooseButton || zero;
  return {
    cover: (a.cover || 0) + (b.cover || 0) + (c.cover || 0),
    hit: (a.hit || 0) + (b.hit || 0) + (c.hit || 0),
    pick: (a.pick || 0) + (b.pick || 0) + (c.pick || 0),
  };
}

/**
 * 取得当前筛选下的“总决策步数”（作为覆盖/命中/选用率的分母）。
 *
 * @param {any} totalsByKind
 * @param {DecisionStatsKindFilter} filter
 * @returns {number}
 */
function pickDenom(totalsByKind, filter) {
  const t = totalsByKind && typeof totalsByKind === "object" ? totalsByKind : {};
  if (filter !== "all") return Number(t[filter] || 0);
  return Number(t.chooseCard || 0) + Number(t.chooseTarget || 0) + Number(t.chooseButton || 0);
}

/**
 * 将某一类决策的计数器格式化为“覆盖/命中/最终选用”一行文本。
 *
 * @param {string} label
 * @param {{cover:number, hit:number, pick:number}} counters
 * @param {number} denom
 * @returns {string}
 */
function formatKindLine(label, counters, denom) {
  const c = counters || { cover: 0, hit: 0, pick: 0 };
  const d = Number(denom || 0);
  return `${label}：覆盖 ${c.cover}/${d} (${formatRate(c.cover, d)}) · 命中 ${c.hit}/${d} (${formatRate(c.hit, d)}) · 最终选用 ${c.pick}/${d} (${formatRate(c.pick, d)})`;
}

/**
 * 打开“AI 决策”统计面板（模态对话框）。
 *
 * 统计口径（按“策略=slqj_ai_score 的每个 hook handler”）：
 * - 覆盖率：该策略在某个决策步中对任意候选产生过非 0 delta 的占比
 * - 命中率：该策略在某个决策步中对最终选中项产生过非 0 delta 的占比
 * - 最终选用率：在最终选中项上 |delta| 最大的策略占比（并列按 strategyId 较小者归因；全为 0 则不归因）
 *
 * @param {{game:any, ui:any}=} opts
 * @returns {void}
 */
export function openAiDecisionStatsModal(opts) {
  const game = opts && opts.game ? opts.game : null;
  const ui = opts && opts.ui ? opts.ui : null;
  const hooks = game ? game.slqjAiHooks || game.__slqjAiPersona?.hooks || null : null;
  const decisionStats = hooks && typeof hooks === "object" ? hooks.__slqjAiDecisionStats : null;

  const shell = createModalShell({
    title: "AI决策",
    subtitle: "策略=slqj_ai_score 的每个 handler；展示覆盖/命中/最终选用率。",
    ui,
    rootId: ROOT_ID,
  });

  // 追加少量样式：用于显示堆栈详情
  try {
    const extra = document.createElement("style");
    extra.textContent = `
.slqj-ai-row{ cursor:pointer; }
.slqj-ai-row.is-inactive{ opacity:.55; }
.slqj-ai-row.is-open{ background:rgba(255,255,255,.06); }
.slqj-ai-details{
  display:none;
  margin-top:8px;
  padding:10px 12px;
  border-radius:12px;
  border:1px solid rgba(255,255,255,.10);
  background:rgba(0,0,0,.28);
  color:rgba(233,238,247,.92);
  font-size:12px;
  line-height:1.6;
  white-space:normal;
  word-break:break-word;
}
.slqj-ai-stacktitle{
  font-weight:600;
  opacity:.95;
}
.slqj-ai-stacktext{
  margin-top:8px;
  padding-top:8px;
  border-top:1px solid rgba(255,255,255,.08);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:11px;
  line-height:1.5;
  white-space:pre-wrap;
  word-break:break-all;
}
.slqj-ai-row.is-open .slqj-ai-details{ display:block; }
`;
    shell.shadow.appendChild(extra);
  } catch (e) {}

  const toolbar = shell.shadow.querySelector("[data-slqj-ai-toolbar]");
  const listWrap = shell.shadow.querySelector("[data-slqj-ai-list]");
  const footer = shell.shadow.querySelector("[data-slqj-ai-footer]");
  if (!toolbar || !listWrap || !footer) return;

  /** @type {DecisionStatsKindFilter} */
  let filter = "all";

  /**
   * 创建工具栏按钮。
   *
   * @param {string} label
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  function addToolbarButton(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slqj-ai-btn";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      try {
        e && e.stopPropagation && e.stopPropagation();
      } catch (e2) {}
      onClick();
    });
    toolbar.appendChild(btn);
    return btn;
  }

  /**
   * 根据 snapshot 渲染策略列表。
   *
   * @param {any} snapshot
   * @returns {void}
   */
  function render(snapshot) {
    listWrap.innerHTML = "";

    const totalsByKind = snapshot && snapshot.totalsByKind ? snapshot.totalsByKind : null;
    const denom = pickDenom(totalsByKind, filter);
    const denomCard = Number(totalsByKind?.chooseCard || 0);
    const denomTarget = Number(totalsByKind?.chooseTarget || 0);
    const denomButton = Number(totalsByKind?.chooseButton || 0);

    const info = document.createElement("div");
    info.className = "slqj-ai-empty";
    const strategies = snapshot && Array.isArray(snapshot.strategies) ? snapshot.strategies : [];
    const activeCount = strategies.filter((x) => x && x.meta && x.meta.active !== false).length;
    const inactiveCount = Math.max(0, strategies.length - activeCount);
    info.innerHTML = [
      `<div><b>口径</b>：覆盖=任意候选有delta；命中=最终选中项有delta；最终选用=最终选中项|delta|最大。</div>`,
      `<div style="margin-top:6px;opacity:.85">策略：总计 ${strategies.length}（生效中 ${activeCount} / 已解绑 ${inactiveCount}）</div>`,
      `<div style="margin-top:6px;opacity:.85">已记录决策步：选牌 ${Number(totalsByKind?.chooseCard || 0)} / 选目标 ${Number(totalsByKind?.chooseTarget || 0)} / 选按钮 ${Number(totalsByKind?.chooseButton || 0)}</div>`,
    ].join("");
    listWrap.appendChild(info);
    if (!strategies.length) {
      const empty = document.createElement("div");
      empty.className = "slqj-ai-empty";
      empty.textContent = "暂无策略：当前未注册 slqj_ai_score handler，或统计尚未初始化。";
      listWrap.appendChild(empty);
      return;
    }

    for (const item of strategies) {
      const meta = item && item.meta ? item.meta : {};
      const statsByKind = item && item.statsByKind ? item.statsByKind : null;
      const counters = pickCounters(statsByKind, filter);

      const title = String(meta.title || "").trim() || meta.fnName || shortenOrigin(meta.origin) || `策略#${meta.id || "?"}`;
      const subtitle = [
        `覆盖 ${counters.cover}/${denom} (${formatRate(counters.cover, denom)})`,
        `命中 ${counters.hit}/${denom} (${formatRate(counters.hit, denom)})`,
        `最终选用 ${counters.pick}/${denom} (${formatRate(counters.pick, denom)})`,
        meta.active === false ? "已解绑" : "生效中",
        `优先级 ${typeof meta.priority === "number" ? meta.priority : 0}`,
      ].join(" · ");

      const row = document.createElement("div");
      row.className = "slqj-ai-row";
      if (meta.active === false) row.classList.add("is-inactive");
      row.addEventListener("click", (e) => {
        try {
          e && e.stopPropagation && e.stopPropagation();
        } catch (e2) {}
        row.classList.toggle("is-open");
      });

      const left = document.createElement("div");
      left.className = "slqj-ai-left";
      const label = document.createElement("div");
      label.className = "slqj-ai-label";
      const tl = document.createElement("div");
      tl.className = "slqj-ai-titleline";
      tl.textContent = `#${meta.id || "?"} ${title}${meta.active === false ? "（已解绑）" : ""}`;
      const sl = document.createElement("div");
      sl.className = "slqj-ai-subline";
      sl.textContent = subtitle;
      label.appendChild(tl);
      label.appendChild(sl);

      // 点击展开：显示“来源 + 分项统计 + 注册堆栈”
      const details = document.createElement("div");
      details.className = "slqj-ai-details";

      const titleLine = document.createElement("div");
      titleLine.textContent = `策略：${String(meta.title || "").trim() || title}`;
      details.appendChild(titleLine);

      const originLine = document.createElement("div");
      const originText = String(meta.origin || "").trim();
      originLine.textContent = `来源：${shortenOrigin(originText) || originText || "(未知)"}`;
      details.appendChild(originLine);

      const metaLine = document.createElement("div");
      const fnName = String(meta.fnName || "").trim() || "(匿名)";
      const onceText = meta.once ? "是" : "否";
      const activeText = meta.active === false ? "已解绑" : "生效中";
      metaLine.textContent = `处理函数：${fnName} · 优先级：${typeof meta.priority === "number" ? meta.priority : 0} · 仅一次：${onceText} · 状态：${activeText}`;
      details.appendChild(metaLine);

      const st = statsByKind && typeof statsByKind === "object" ? statsByKind : {};
      const s1 = st.chooseCard || { cover: 0, hit: 0, pick: 0 };
      const s2 = st.chooseTarget || { cover: 0, hit: 0, pick: 0 };
      const s3 = st.chooseButton || { cover: 0, hit: 0, pick: 0 };

      const line1 = document.createElement("div");
      line1.textContent = formatKindLine("选牌", s1, denomCard);
      details.appendChild(line1);

      const line2 = document.createElement("div");
      line2.textContent = formatKindLine("选目标", s2, denomTarget);
      details.appendChild(line2);

      const line3 = document.createElement("div");
      line3.textContent = formatKindLine("选按钮", s3, denomButton);
      details.appendChild(line3);

      const stackTitle = document.createElement("div");
      stackTitle.className = "slqj-ai-stacktitle";
      stackTitle.textContent = "注册堆栈（非报错，用于定位策略注册位置）：";
      details.appendChild(stackTitle);

      const stackText = document.createElement("div");
      stackText.className = "slqj-ai-stacktext";
      const normalizedStack = normalizeStackText(meta.stack);
      stackText.textContent = normalizedStack || "(无堆栈)";
      details.appendChild(stackText);

      label.appendChild(details);

      left.appendChild(label);

      const right = document.createElement("div");
      right.className = "slqj-ai-right";
      const tag = document.createElement("div");
      tag.className = "slqj-ai-subline";
      tag.style.opacity = ".9";
      tag.textContent = filter === "all" ? "全部" : filter === "chooseCard" ? "选牌" : filter === "chooseTarget" ? "选目标" : "选按钮";
      right.appendChild(tag);

      row.appendChild(left);
      row.appendChild(right);
      listWrap.appendChild(row);
    }
  }

  /**
   * 从 HookBus 的统计器读取快照（失败时回退空数据）。
   *
   * @returns {any}
   */
  function getSnapshot() {
    try {
      if (decisionStats && typeof decisionStats.snapshot === "function") return decisionStats.snapshot();
    } catch (e) {}
    return { totalsByKind: { chooseCard: 0, chooseTarget: 0, chooseButton: 0 }, strategies: [] };
  }

  const statusNode = shell.shadow.querySelector(".slqj-ai-status");

  /**
   * 刷新 UI：重取快照并重新渲染。
   *
   * @returns {void}
   */
  function refresh() {
    const snap = getSnapshot();
    render(snap);
    try {
      if (statusNode) statusNode.textContent = "可点击任意策略展开查看注册堆栈。";
    } catch (e) {}
  }

  // 工具栏
  addToolbarButton("全部", () => {
    filter = "all";
    refresh();
  });
  addToolbarButton("选牌", () => {
    filter = "chooseCard";
    refresh();
  });
  addToolbarButton("选目标", () => {
    filter = "chooseTarget";
    refresh();
  });
  addToolbarButton("选按钮", () => {
    filter = "chooseButton";
    refresh();
  });
  addToolbarButton("刷新", () => refresh());
  addToolbarButton("清空统计", () => {
    try {
      decisionStats && typeof decisionStats.clear === "function" && decisionStats.clear();
    } catch (e) {}
    refresh();
  });

  refresh();
}
