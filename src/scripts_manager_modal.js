import { listExtensionScriptFiles, normalizeScriptsRegistry, readScriptsRegistry, saveScriptsRegistry } from "./scripts_registry.js";

const ROOT_ID = "slqj-ai-scripts-manager-root";

/** @type {{ close: Function }|null} */
let active = null;

/**
 * @typedef {Object} SlqjAiScriptMeta
 * @property {string} name
 * @property {string} version
 * @property {string} description
 */

/**
 * 打开 scripts 脚本插件管理器（模态对话框）。
 *
 * 说明：
 * - 该 UI 仅负责修改“启用/顺序”配置；实际生效需重启（与脚本加载器的启动时机一致）。
 * - 若运行环境无法读取扩展目录，则显示不可用提示。
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl 用于解析 `scripts/` 目录的基准 URL（建议传入 `import.meta.url`）
 * @param {*} opts.lib
 * @param {*} opts.game
 * @param {*} opts.ui
 * @param {*} opts.config
 * @returns {Promise<void>}
 */
export async function openScriptsPluginManagerModal(opts) {
  const baseUrl = opts && opts.baseUrl ? String(opts.baseUrl) : "";
  const lib = opts ? opts.lib : null;
  const game = opts ? opts.game : null;
  const ui = opts ? opts.ui : null;
  const config = opts ? opts.config : null;

  // 单实例：重复打开则关闭旧实例再创建新实例（避免多层遮罩叠加）
  try {
    active?.close?.();
  } catch (e) {}

  const listResult = await listExtensionScriptFiles({ baseUrl, game });
  const files = listResult.files || [];
  const initialRegistry = normalizeScriptsRegistry(files, readScriptsRegistry(config, lib));

  /** @type {string[]} */
  let order = initialRegistry.order.slice();
  /** @type {Record<string, boolean>} */
  let disabled = { ...initialRegistry.disabled };

  const shell = createModalShell({
    title: "scripts 插件管理",
    subtitle: "修改后建议重启生效（与 scripts 加载器的启动时机一致）。",
    ui,
  });
  active = { close: shell.close };

  if (listResult.skipped) {
    const reason = String(listResult.reason || "unknown");
    renderUnavailable(shell, `当前运行环境无法读取扩展目录下的 scripts/ 文件列表，无法提供插件管理。原因：${reason}`);
    return;
  }

  const metaByFile = await loadScriptsMeta({ baseUrl, files });

  const toolbar = shell.shadow.querySelector("[data-slqj-ai-toolbar]");
  const listWrap = shell.shadow.querySelector("[data-slqj-ai-list]");
  const footer = shell.shadow.querySelector("[data-slqj-ai-footer]");
  if (!toolbar || !listWrap || !footer) return;

  // 触屏滚动兜底：iOS/部分 WebView 下仅 stopPropagation 仍可能不稳定
  try {
    if (ui && ui.click && typeof ui.click.touchStart === "function" && typeof ui.click.touchScroll === "function" && listWrap instanceof HTMLElement) {
      listWrap.ontouchstart = ui.click.touchStart;
      listWrap.ontouchmove = ui.click.touchScroll;
    }
  } catch (e) {}

  addButton(toolbar, "全部启用", () => {
    disabled = {};
    renderList();
  });
  addButton(toolbar, "全部禁用", () => {
    /** @type {Record<string, boolean>} */
    const next = {};
    for (const f of order) next[f] = true;
    disabled = next;
    renderList();
  });
  addButton(toolbar, "重置为文件名排序", () => {
    order = files.slice().sort((a, b) => a.localeCompare(b));
    renderList();
  });

  addButton(footer, "保存并关闭", () => {
    const normalized = normalizeScriptsRegistry(files, { version: 1, order, disabled });
    const ok = saveScriptsRegistry(game, normalized);
    shell.setStatus(ok ? "已保存：重启后生效" : "保存失败：请查看控制台");
    if (ok) shell.close();
  });
  addButton(footer, "取消", () => shell.close(), { variant: "ghost" });

  /**
   * 重新渲染插件列表（启用开关 + 上下移动）。
   * @returns {void}
   */
  function renderList() {
    listWrap.innerHTML = "";
    for (let i = 0; i < order.length; i++) {
      const file = order[i];
      const enabled = !disabled[file];

      const row = document.createElement("div");
      row.className = "slqj-ai-row" + (enabled ? "" : " is-disabled");

      const left = document.createElement("div");
      left.className = "slqj-ai-left";

      const toggle = createToggle(enabled, (nextEnabled) => {
        if (nextEnabled) delete disabled[file];
        else disabled[file] = true;
        row.classList.toggle("is-disabled", !nextEnabled);
      });

      const label = document.createElement("div");
      label.className = "slqj-ai-label";

      const title = document.createElement("div");
      title.className = "slqj-ai-titleline";
      title.textContent = formatScriptTitle(file, metaByFile[file]);

      const subtitle = document.createElement("div");
      subtitle.className = "slqj-ai-subline";
      subtitle.textContent = formatScriptSubtitle(file, metaByFile[file]);
      subtitle.title = subtitle.textContent;

      label.appendChild(title);
      label.appendChild(subtitle);

      left.appendChild(toggle);
      left.appendChild(label);

      const right = document.createElement("div");
      right.className = "slqj-ai-right";

      const up = addIconButton(right, "上移", "↑", () => {
        move(file, -1);
        renderList();
      });
      const down = addIconButton(right, "下移", "↓", () => {
        move(file, +1);
        renderList();
      });
      if (i === 0) up.disabled = true;
      if (i === order.length - 1) down.disabled = true;

      row.appendChild(left);
      row.appendChild(right);
      listWrap.appendChild(row);
    }
  }

  /**
   * @param {string} file
   * @param {number} delta
   * @returns {void}
   */
  function move(file, delta) {
    const idx = order.indexOf(file);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= order.length) return;
    const copy = order.slice();
    copy.splice(idx, 1);
    copy.splice(next, 0, file);
    order = copy;
  }

  renderList();
}

/**
 * 从脚本模块中读取元信息（不调用其入口函数）。
 *
 * 说明：
 * - 约定脚本可导出 `slqjAiScriptMeta` 对象，供插件管理 UI 显示名称/版本/说明
 * - 若脚本未提供元信息或读取失败，则该脚本在 UI 中回退显示文件名
 *
 * @param {{baseUrl:string, files:string[]}} opts
 * @returns {Promise<Record<string, SlqjAiScriptMeta>>}
 */
async function loadScriptsMeta(opts) {
  const baseUrl = opts && opts.baseUrl ? String(opts.baseUrl) : "";
  const files = Array.isArray(opts?.files) ? opts.files.map((f) => String(f || "")).filter(Boolean) : [];
  const scriptsUrl = safeNewUrl("./scripts/", baseUrl);
  if (!scriptsUrl) return {};

  /** @type {Record<string, SlqjAiScriptMeta>} */
  const out = {};
  await Promise.all(
    files.map(async (file) => {
      try {
        const modUrl = new URL(file, scriptsUrl);
        const mod = await import(modUrl.href);
        const meta = normalizeScriptMeta(mod && mod.slqjAiScriptMeta);
        if (meta) out[file] = meta;
      } catch (e) {}
    })
  );
  return out;
}

/**
 * @param {any} input
 * @returns {SlqjAiScriptMeta|null}
 */
function normalizeScriptMeta(input) {
  if (!input || typeof input !== "object") return null;
  const name = String(input.name || "").trim();
  if (!name) return null;
  const version = String(input.version || "").trim();
  const description = String(input.description || "").trim();
  return { name, version, description };
}

/**
 * @param {string} file
 * @param {SlqjAiScriptMeta|undefined} meta
 * @returns {string}
 */
function formatScriptTitle(file, meta) {
  if (meta && meta.name) {
    const ver = meta.version ? ` v${meta.version}` : "";
    return `${meta.name}${ver}`;
  }
  return String(file || "");
}

/**
 * @param {string} file
 * @param {SlqjAiScriptMeta|undefined} meta
 * @returns {string}
 */
function formatScriptSubtitle(file, meta) {
  if (meta) {
    const desc = meta.description ? meta.description : "";
    if (desc) return `${desc}（${String(file || "")}）`;
    return String(file || "");
  }
  return String(file || "");
}

/**
 * @param {string} rel
 * @param {string} base
 * @returns {URL|null}
 */
function safeNewUrl(rel, base) {
  try {
    return new URL(rel, base);
  } catch (e) {
    return null;
  }
}

/**
 * 创建并挂载模态 UI 外壳。
 *
 * @param {{title:string, subtitle?:string, ui?: any}} opts
 * @returns {{ shadow: ShadowRoot, close: Function, setStatus: (text: string) => void }}
 */
function createModalShell(opts) {
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    try {
      existing.remove();
    } catch (e) {}
  }

  // 通过 Shadow DOM 隔离全局样式污染（避免出现“元素重叠/布局错乱”）
  // 同时可用 :host 直接样式化遮罩层（避免额外全局 CSS）。
  const backdrop = document.createElement("div");
  backdrop.id = ROOT_ID;
  // 兜底：项目全局 CSS 里对 div 有 position/transition 的默认样式
  // 移动端/缩放环境下 fixed/inset 可能出现“遮罩缩角”，因此这里使用 vw/vh 并配合 transform 补偿兜底。
  try {
    backdrop.style.position = "fixed";
    backdrop.style.left = "0";
    backdrop.style.top = "0";
    // 使用 vw/vh：在某些“fixed 被祖先 transform 影响”的环境下，inset:0 可能只覆盖到包含块，导致遮罩缩角。
    backdrop.style.right = "auto";
    backdrop.style.bottom = "auto";
    backdrop.style.width = "100vw";
    backdrop.style.height = "100vh";
    backdrop.style.margin = "0";
    backdrop.style.zIndex = "9999";
  } catch (e) {}
  const shadow = backdrop.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = getCssText();
  shadow.appendChild(style);

  const offsetWrap = document.createElement("div");
  offsetWrap.className = "slqj-ai-offset";

  const backdropLayer = document.createElement("div");
  backdropLayer.className = "slqj-ai-backdrop-layer";

  const modal = document.createElement("div");
  modal.className = "slqj-ai-modal";

  const header = document.createElement("div");
  header.className = "slqj-ai-header";

  const title = document.createElement("div");
  title.className = "slqj-ai-title";
  title.textContent = String(opts?.title || "插件管理");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "slqj-ai-close";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.innerHTML = "×";

  header.appendChild(title);
  header.appendChild(closeBtn);

  const subtitle = document.createElement("div");
  subtitle.className = "slqj-ai-subtitle";
  subtitle.textContent = String(opts?.subtitle || "");

  const info = document.createElement("div");
  info.className = "slqj-ai-info";

  const toolbar = document.createElement("div");
  toolbar.className = "slqj-ai-toolbar";
  toolbar.setAttribute("data-slqj-ai-toolbar", "1");

  const body = document.createElement("div");
  body.className = "slqj-ai-body";

  const list = document.createElement("div");
  list.className = "slqj-ai-list";
  list.setAttribute("data-slqj-ai-list", "1");

  body.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "slqj-ai-footer";
  footer.setAttribute("data-slqj-ai-footer", "1");

  const status = document.createElement("div");
  status.className = "slqj-ai-status";
  status.textContent = "";

  const footerBtns = document.createElement("div");
  footerBtns.className = "slqj-ai-footer-buttons";

  footer.appendChild(status);
  footer.appendChild(footerBtns);

  modal.appendChild(header);
  if (opts?.subtitle) info.appendChild(subtitle);
  info.appendChild(toolbar);
  modal.appendChild(info);
  modal.appendChild(body);
  modal.appendChild(footer);
  offsetWrap.appendChild(backdropLayer);
  offsetWrap.appendChild(modal);
  shadow.appendChild(offsetWrap);

  // 由 JS 计算尺寸（避免仅靠 CSS 计算导致兼容问题）
  applyModalSize(modal);

  // 挂载策略：
  // - 优先挂载到 html 作为 body 的兄弟节点，避免 body/游戏根容器存在 transform/overflow 导致 fixed 被裁切
  // - 失败则退回到 body/documentElement
  let mounted = false;
  try {
    const html = document.documentElement;
    const body = document.body;
    if (html && body && html.insertBefore) {
      html.insertBefore(backdrop, body);
      mounted = backdrop.parentNode === html;
    }
  } catch (e) {}
  if (!mounted) {
    try {
      const mountNode = document.body || document.documentElement;
      mountNode && mountNode.appendChild && mountNode.appendChild(backdrop);
    } catch (e) {}
  }

  /**
   * 阻止事件冒泡到 document：触屏模式下引擎会在 document.touchmove 里 preventDefault，导致列表无法滚动。
   *
   * @param {Event} e
   * @returns {void}
   */
  const stopToDocument = (e) => {
    try {
      e && e.stopPropagation && e.stopPropagation();
    } catch (e) {}
  };
  try {
    backdrop.addEventListener("touchstart", stopToDocument, { passive: true });
    backdrop.addEventListener("touchmove", stopToDocument, { passive: true });
    backdrop.addEventListener("touchend", stopToDocument, { passive: true });
    backdrop.addEventListener("click", stopToDocument);
    backdrop.addEventListener("mousedown", stopToDocument);
  } catch (e) {}

  const state = { sx: 1, sy: 1 };
  const recomputeLayout = () => {
    try {
      const comp = compensateOverlayTransform(backdrop);
      state.sx = comp.sx;
      state.sy = comp.sy;
      applyCenterOffset(offsetWrap, state, opts?.ui);
      // 保持弹窗视觉尺寸稳定（对 overlay scale 的反向补偿）
      applyInverseScale(modal, state);
      applyModalSize(modal, state);
    } catch (e) {}
  };

  let closing = false;
  const onKeyDown = (e) => {
    if (!e) return;
    if (e.key === "Escape") close();
  };
  const onResize = () => recomputeLayout();
  const onViewportResize = () => recomputeLayout();

  /**
   * @returns {void}
   */
  const close = () => {
    if (closing) return;
    closing = true;
    try {
      window.removeEventListener("keydown", onKeyDown);
    } catch (e) {}
    try {
      window.removeEventListener("resize", onResize);
    } catch (e) {}
    try {
      window.visualViewport && window.visualViewport.removeEventListener && window.visualViewport.removeEventListener("resize", onViewportResize);
    } catch (e) {}
    try {
      window.visualViewport && window.visualViewport.removeEventListener && window.visualViewport.removeEventListener("scroll", onViewportResize);
    } catch (e) {}
    try {
      backdrop.remove();
    } catch (e) {}
    if (active && typeof active === "object") active = null;
  };

  closeBtn.addEventListener("click", () => close());
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);
  try {
    window.visualViewport && window.visualViewport.addEventListener && window.visualViewport.addEventListener("resize", onViewportResize);
  } catch (e) {}
  try {
    window.visualViewport && window.visualViewport.addEventListener && window.visualViewport.addEventListener("scroll", onViewportResize);
  } catch (e) {}
  // 在 Shadow DOM 内部监听“遮罩空白区域点击”，避免 event retarget 导致“点哪都关”。
  backdropLayer.addEventListener("pointerdown", () => close());
  backdropLayer.addEventListener("mousedown", () => close());
  backdropLayer.addEventListener("touchstart", () => close(), { passive: true });

  recomputeLayout();
  // 某些 WebView 下初次 append 后布局信息会延迟一帧才稳定，这里额外补一次，避免出现“遮罩缩角/弹窗偏移”。
  try {
    typeof requestAnimationFrame === "function" && requestAnimationFrame(() => recomputeLayout());
  } catch (e) {}

  return {
    shadow,
    close,
    setStatus: (text) => {
      status.textContent = String(text || "");
    },
  };
}

/**
 * 渲染“不可用”提示页。
 *
 * @param {HTMLElement} root
 * @param {string} text
 * @returns {void}
 */
function renderUnavailable(shell, text) {
  const toolbar = shell.shadow.querySelector("[data-slqj-ai-toolbar]");
  const listWrap = shell.shadow.querySelector("[data-slqj-ai-list]");
  const footer = shell.shadow.querySelector("[data-slqj-ai-footer]");
  if (!toolbar || !listWrap || !footer) return;
  toolbar.innerHTML = "";
  listWrap.innerHTML = "";
  const msg = document.createElement("div");
  msg.className = "slqj-ai-empty";
  msg.textContent = String(text || "");
  listWrap.appendChild(msg);
}

/**
 * 添加按钮到容器。
 *
 * @param {Element} parent
 * @param {string} text
 * @param {Function} onClick
 * @param {{variant?: 'primary'|'ghost'}} [opts]
 * @returns {HTMLButtonElement}
 */
function addButton(parent, text, onClick, opts) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "slqj-ai-btn" + (opts?.variant === "ghost" ? " is-ghost" : "");
  btn.textContent = String(text || "");
  btn.addEventListener("click", () => {
    try {
      onClick && onClick();
    } catch (e) {}
  });

  // footer 下实际按钮容器
  if (parent.classList.contains("slqj-ai-footer")) {
    const holder = parent.querySelector(".slqj-ai-footer-buttons") || parent;
    holder.appendChild(btn);
  } else {
    parent.appendChild(btn);
  }

  return btn;
}

/**
 * 添加带图标的行内按钮。
 *
 * @param {HTMLElement} parent
 * @param {string} title
 * @param {string} icon
 * @param {Function} onClick
 * @returns {HTMLButtonElement}
 */
function addIconButton(parent, title, icon, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "slqj-ai-icon-btn";
  btn.title = String(title || "");
  btn.setAttribute("aria-label", String(title || ""));
  btn.textContent = String(icon || "");
  btn.addEventListener("click", () => {
    try {
      onClick && onClick();
    } catch (e) {}
  });
  parent.appendChild(btn);
  return btn;
}

/**
 * 创建启用/禁用开关。
 *
 * @param {boolean} checked
 * @param {(next: boolean) => void} onChange
 * @returns {HTMLElement}
 */
function createToggle(checked, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "slqj-ai-switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!checked;
  const slider = document.createElement("span");
  slider.className = "slqj-ai-slider";
  input.addEventListener("change", () => {
    try {
      onChange && onChange(!!input.checked);
    } catch (e) {}
  });
  wrap.appendChild(input);
  wrap.appendChild(slider);
  return wrap;
}

/**
 * @returns {string}
 */
function getCssText() {
  return `
:host{
  position:fixed;
  inset:0;
  width:100vw;
  height:100vh;
  z-index:9999;
  display:block;
  box-sizing:border-box;
  padding:8px;
  background:rgba(0,0,0,.55);
  backdrop-filter: blur(10px);
  transform-origin: 0 0;
  will-change: transform;
  transition:none;
}
.slqj-ai-offset{
  width:100%;
  height:100%;
  display:flex;
  align-items:center;
  justify-content:center;
  position:relative;
  transform: translate(0px, 0px);
  will-change: transform;
}
.slqj-ai-backdrop-layer{
  position:absolute;
  inset:0;
}
.slqj-ai-modal{
  width: 920px;
  height: 820px;
  border-radius:14px;
  background:rgba(20,22,26,.92);
  color:#e9eef7;
  box-shadow: 0 20px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08);
  overflow:hidden;
  display:grid;
  grid-template-rows: auto auto 1fr auto;
  box-sizing:border-box;
  position:relative;
  z-index:1;
}
.slqj-ai-modal, .slqj-ai-modal *{ box-sizing: border-box; }
.slqj-ai-header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:16px 16px 10px 16px;
}
.slqj-ai-title{
  font-size:18px;
  font-weight:700;
  letter-spacing:.2px;
}
.slqj-ai-close{
  width:32px;
  height:32px;
  border-radius:10px;
  border:1px solid rgba(255,255,255,.12);
  background:rgba(255,255,255,.06);
  color:#e9eef7;
  font-size:22px;
  line-height:28px;
  cursor:pointer;
}
.slqj-ai-close:hover{ background:rgba(255,255,255,.10); }
.slqj-ai-subtitle{
  padding:0;
  font-size:13px;
  opacity:.85;
}
.slqj-ai-info{
  padding:0 16px 12px 16px;
}
.slqj-ai-info .slqj-ai-subtitle{
  padding:0 0 12px 0;
}
.slqj-ai-toolbar{
  display:flex;
  gap:10px;
  padding:0;
  flex-wrap:wrap;
}
.slqj-ai-body{
  padding:0 16px;
  min-height:0;
  display:flex;
  flex-direction:column;
}
.slqj-ai-list{
  flex:1 1 auto;
  min-height:0;
  overflow:auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border-radius:12px;
  background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.07);
}
.slqj-ai-row{
  display:grid;
  align-items:center;
  grid-template-columns: minmax(0, 1fr) auto;
  gap:12px;
  padding:12px 28px 12px 12px;
  border-bottom:1px solid rgba(255,255,255,.06);
}
.slqj-ai-row:last-child{ border-bottom:none; }
.slqj-ai-row.is-disabled{ opacity:.65; }
.slqj-ai-left{
  display:flex;
  align-items:center;
  gap:12px;
  min-width:0;
  flex:1 1 auto;
}
.slqj-ai-label{
  min-width:0;
  flex:1 1 auto;
}
.slqj-ai-titleline{
  font-size:13px;
  font-weight:600;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.slqj-ai-subline{
  font-size:12px;
  opacity:.75;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.slqj-ai-right{
  display:flex;
  gap:8px;
  flex:0 0 auto;
  justify-self:end;
}
.slqj-ai-btn{
  border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.06);
  color:#e9eef7;
  border-radius:10px;
  padding:8px 12px;
  font-size:13px;
  cursor:pointer;
}
.slqj-ai-btn:hover{ background:rgba(255,255,255,.10); }
.slqj-ai-btn.is-ghost{
  background:transparent;
}
.slqj-ai-icon-btn{
  width:32px;
  height:32px;
  border-radius:10px;
  border:1px solid rgba(255,255,255,.12);
  background:rgba(255,255,255,.06);
  color:#e9eef7;
  cursor:pointer;
  font-size:14px;
}
.slqj-ai-icon-btn:disabled{
  opacity:.35;
  cursor:default;
}
.slqj-ai-icon-btn:not(:disabled):hover{ background:rgba(255,255,255,.10); }
.slqj-ai-footer{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:12px 16px 16px 16px;
}
.slqj-ai-status{
  font-size:12px;
  opacity:.85;
  min-height:16px;
}
.slqj-ai-footer-buttons{
  display:flex;
  gap:10px;
}
.slqj-ai-empty{
  padding:18px;
  font-size:13px;
  opacity:.9;
  line-height:1.6;
}
.slqj-ai-switch{
  position:relative;
  width:44px;
  height:24px;
  flex:0 0 auto;
}
.slqj-ai-switch input{
  opacity:0;
  width:0;
  height:0;
}
.slqj-ai-slider{
  position:absolute;
  cursor:pointer;
  inset:0;
  background:rgba(255,255,255,.12);
  border:1px solid rgba(255,255,255,.10);
  transition:.18s;
  border-radius:999px;
}
.slqj-ai-slider:before{
  position:absolute;
  content:\"\";
  height:18px;
  width:18px;
  left:3px;
  top:2px;
  background:rgba(255,255,255,.88);
  transition:.18s;
  border-radius:999px;
}
.slqj-ai-switch input:checked + .slqj-ai-slider{
  background:rgba(46, 204, 113, .28);
  border-color:rgba(46,204,113,.35);
}
.slqj-ai-switch input:checked + .slqj-ai-slider:before{
  transform: translateX(20px);
  background:rgba(255,255,255,.95);
}
`;
}

/**
 * 计算并应用弹窗尺寸（基于视口大小，避免仅靠 CSS 计算导致兼容问题）。
 *
 * @param {HTMLElement} modal
 * @param {{sx:number, sy:number}} [state]
 * @returns {void}
 */
function applyModalSize(modal, state) {
  if (!modal || !modal.style) return;
  const vw = getViewportWidth();
  const vh = getViewportHeight();
  if (!vw || !vh) return;

  const minSide = Math.min(vw, vh);
  const coarse = isCoarsePointer();
  // 留出边距，避免贴边：手机端尽量留更小边距以获得更“高”的对话框
  const margin = minSide <= 520 ? 8 : clampNumber(Math.round(minSide * 0.06), 12, 24);
  const maxWVisible = Math.max(240, Math.floor(vw - margin * 2));
  const maxHVisible = Math.max(240, Math.floor(vh - margin * 2));
  const minWVisible = Math.min(320, maxWVisible);
  const minHVisible = Math.min(320, maxHVisible);

  // 目标：
  // - 触屏/手机端：尽量接近满屏（高度优先）
  // - 桌面端：保持偏“对话框”风格（宽上限 920，高上限 820）
  const wTarget = coarse ? maxWVisible : 920;
  const hTarget = coarse ? maxHVisible : Math.min(820, maxHVisible);
  const wVisible = clampNumber(wTarget, minWVisible, maxWVisible);
  const hMaxVisible = hTarget;
  const hVisible = clampNumber(hMaxVisible, minHVisible, hMaxVisible);

  try {
    modal.style.width = `${wVisible}px`;
    modal.style.height = `${hVisible}px`;
  } catch (e) {}
}

/**
 * 处理“祖先节点 transform 导致 fixed 失真”的补偿。
 *
 * 通过对 overlay 做 translate+scale，使其在视觉上对齐视口。
 *
 * @param {HTMLElement} overlay
 * @returns {{sx:number, sy:number}}
 */
function compensateOverlayTransform(overlay) {
  // 先清空 transform 以获取“未补偿前”的真实 rect，避免 resize 时叠加漂移
  try {
    overlay.style.transform = "none";
  } catch (e) {}

  const rect = overlay.getBoundingClientRect();
  // 这里优先用 layout 尺寸（offsetWidth/offsetHeight）来推导缩放：
  // - rect.width/height 会受到祖先 transform/zoom 影响（我们要补偿的正是这个）
  // - offsetWidth/offsetHeight 是布局尺寸（不含 transform 影响），更适合作为“目标尺寸”
  // 在极端情况下 offsetWidth 可能为 0（尚未布局），此时退回到视口尺寸兜底。
  const vw = getViewportWidth();
  const vh = getViewportHeight();
  const lw = (overlay && isFiniteNumber(overlay.offsetWidth) && overlay.offsetWidth > 0) ? overlay.offsetWidth : vw;
  const lh = (overlay && isFiniteNumber(overlay.offsetHeight) && overlay.offsetHeight > 0) ? overlay.offsetHeight : vh;
  const sxRaw = rect.width ? lw / rect.width : 1;
  const syRaw = rect.height ? lh / rect.height : 1;
  const sx = clampScale(isFiniteNumber(sxRaw) ? sxRaw : 1);
  const sy = clampScale(isFiniteNumber(syRaw) ? syRaw : 1);
  // 位移同样需要按补偿后的缩放系数折算：
  // 祖先缩放会把 translate 一并缩放（A * translate），因此这里使用 -rect.left * sx 来抵消。
  const tx = isFiniteNumber(rect.left) ? -rect.left * sx : 0;
  const ty = isFiniteNumber(rect.top) ? -rect.top * sy : 0;
  try {
    // CSS transform 列表按“从右到左”应用：这里用 translate(...) scale(...)
    // 先缩放到目标尺寸，再用 translate 直接抵消 rect.left/top（避免位移被缩放导致残余偏移）。
    const need = Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01 || Math.abs(tx) > 0.5 || Math.abs(ty) > 0.5;
    overlay.style.transform = need ? `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})` : "none";
    if (!need) return { sx: 1, sy: 1 };
  } catch (e) {}
  return { sx: isFiniteNumber(sx) ? sx : 1, sy: isFiniteNumber(sy) ? sy : 1 };
}

/**
 * 将弹窗居中基准调整到“优先 ui.arena，其次 ui.window，最后视口”。
 *
 * @param {HTMLElement} offsetWrap
 * @param {{sx:number, sy:number}} state
 * @param {*} ui
 * @returns {void}
 */
function applyCenterOffset(offsetWrap, state, ui) {
  // 触屏/手机端：直接以视口为基准居中（避免 ui.arena 的布局/缩放导致弹窗整体右下偏移）
  if (isCoarsePointer()) {
    try {
      offsetWrap.style.transform = "translate(0px, 0px)";
    } catch (e) {}
    return;
  }
  const target = pickCenterTarget(ui);
  if (!target) {
    try {
      offsetWrap.style.transform = "translate(0px, 0px)";
    } catch (e) {}
    return;
  }
  const rect = target.getBoundingClientRect();
  // 目标容器不可见/未布局时，rect 可能为 0，避免把弹窗推到角落
  if (!rect || rect.width < 20 || rect.height < 20) {
    try {
      offsetWrap.style.transform = "translate(0px, 0px)";
    } catch (e) {}
    return;
  }
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const vx = getViewportWidth() / 2;
  const vy = getViewportHeight() / 2;
  const dx = cx - vx;
  const dy = cy - vy;
  const sx = state?.sx || 1;
  const sy = state?.sy || 1;
  const adjX = isFiniteNumber(dx) && isFiniteNumber(sx) && sx ? dx / sx : 0;
  const adjY = isFiniteNumber(dy) && isFiniteNumber(sy) && sy ? dy / sy : 0;
  try {
    offsetWrap.style.transform = `translate(${adjX}px, ${adjY}px)`;
  } catch (e) {}
}

/**
 * 对 overlay 的 scale 补偿做反向缩放，保持弹窗尺寸不随 overlay 缩放而改变。
 *
 * @param {HTMLElement} modal
 * @param {{sx:number, sy:number}} state
 * @returns {void}
 */
function applyInverseScale(modal, state) {
  const sx = state?.sx || 1;
  const sy = state?.sy || 1;
  const invX = sx ? 1 / sx : 1;
  const invY = sy ? 1 / sy : 1;
  try {
    modal.style.transformOrigin = "center";
    modal.style.transform = `scale(${invX}, ${invY})`;
  } catch (e) {}
}

/**
 * @param {*} ui
 * @returns {HTMLElement|null}
 */
function pickCenterTarget(ui) {
  try {
    if (ui && ui.arena && ui.arena.getBoundingClientRect) return ui.arena;
    if (ui && ui.window && ui.window.getBoundingClientRect) return ui.window;
  } catch (e) {}
  return null;
}

/**
 * @returns {number}
 */
function getViewportWidth() {
  try {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const a = typeof window !== "undefined" ? window.innerWidth : 0;
    const b = typeof document !== "undefined" ? document.documentElement?.clientWidth || 0 : 0;
    const c = vv && isFiniteNumber(vv.width) ? vv.width : 0;
    return Math.max(a || 0, b || 0, c || 0, 0);
  } catch (e) {
    return 0;
  }
}

/**
 * @returns {number}
 */
function getViewportHeight() {
  try {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const a = typeof window !== "undefined" ? window.innerHeight : 0;
    const b = typeof document !== "undefined" ? document.documentElement?.clientHeight || 0 : 0;
    const c = vv && isFiniteNumber(vv.height) ? vv.height : 0;
    return Math.max(a || 0, b || 0, c || 0, 0);
  } catch (e) {
    return 0;
  }
}

/**
 * @returns {boolean}
 */
function isCoarsePointer() {
  try {
    if (typeof window === "undefined") return false;
    if (typeof window.matchMedia !== "function") {
      const nav = typeof navigator !== "undefined" ? navigator : null;
      const maxTouchPoints = nav && typeof nav.maxTouchPoints === "number" ? nav.maxTouchPoints : 0;
      return ("ontouchstart" in window) || maxTouchPoints > 0;
    }
    return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches;
  } catch (e) {
    return false;
  }
}

/**
 * @param {any} n
 * @returns {boolean}
 */
function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * 缩放夹取（避免极端值导致弹窗被 inverse-scale 缩到不可用）。
 *
 * @param {number} value
 * @returns {number}
 */
function clampScale(value) {
  if (!isFiniteNumber(value) || value <= 0) return 1;
  return Math.min(Math.max(value, 0.25), 12);
}

/**
 * 数值夹取（确保返回 [min, max] 之间的整数）。
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(value, min, max) {
  const v = typeof value === "number" && !Number.isNaN(value) ? value : min;
  const lo = typeof min === "number" && !Number.isNaN(min) ? min : 0;
  const hi = typeof max === "number" && !Number.isNaN(max) ? max : lo;
  const clamped = Math.min(Math.max(v, lo), hi);
  return Math.floor(clamped);
}
