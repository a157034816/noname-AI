import { createModalShell } from "../scripts_manager_modal.js";
import {
  SLQJ_AI_EXTENSION_BUILD_CHANNEL,
  SLQJ_AI_EXTENSION_BUILD_PR_NUMBER,
  SLQJ_AI_UPDATE_REPO,
} from "../version.js";
import { fetchSelectablePrBuilds } from "./pr_selector.js";
import { checkForUpdate } from "./updater.js";
import {
  describeUpdateTarget,
  normalizeBuildChannel,
  normalizeUpdatePrNumber,
  readUpdateTarget,
  saveUpdateChannel,
  saveUpdatePrNumber,
  UPDATE_CHANNEL_PR,
} from "./settings.js";

const ROOT_ID = "slqj-ai-pr-selector-modal-root";

/**
 * 打开“选择 PR 测试版”弹窗。
 *
 * @param {{lib:any, game:any, ui:any, config:any, currentVersion:string}} opts
 * @returns {Promise<void>}
 */
export async function openPrSelectorModal(opts) {
  const game = opts?.game;
  const currentVersion = String(opts?.currentVersion || "").trim();
  if (!currentVersion) return;

  const initialTarget = readUpdateTarget(opts?.config, opts?.lib);
  const installedChannel = normalizeBuildChannel(SLQJ_AI_EXTENSION_BUILD_CHANNEL);
  const installedPrNumber = normalizeUpdatePrNumber(SLQJ_AI_EXTENSION_BUILD_PR_NUMBER);

  const shell = createModalShell({
    title: "选择 PR 测试版",
    subtitle: "只显示开放且已有测试包的 PR。选择后会自动检查更新，但不会自动下载安装。",
    ui: opts?.ui,
    rootId: ROOT_ID,
  });
  const toolbar = shell.shadow.querySelector("[data-slqj-ai-toolbar]");
  const listWrap = shell.shadow.querySelector("[data-slqj-ai-list]");
  const footer = shell.shadow.querySelector("[data-slqj-ai-footer]");
  if (!toolbar || !listWrap || !footer) return;

  const info = document.createElement("div");
  info.className = "slqj-ai-empty";
  const list = document.createElement("div");
  list.style.display = "grid";
  list.style.gap = "10px";

  listWrap.innerHTML = "";
  listWrap.appendChild(info);
  listWrap.appendChild(list);

  const state = {
    loading: false,
    selectingPrNumber: "",
    error: "",
    items: /** @type {any[]} */ ([]),
    selectedPrNumber: initialTarget.targetChannel === UPDATE_CHANNEL_PR ? initialTarget.targetPrNumber : "",
    lastCheck: readCachedCheck(game, initialTarget.targetPrNumber),
  };

  const btnRefresh = addButton(toolbar, "刷新列表", async () => {
    await loadList();
  });
  addButton(footer, "关闭", () => shell.close(), { variant: "ghost" });

  const render = () => {
    const effectiveTargetChannel = state.selectedPrNumber ? UPDATE_CHANNEL_PR : initialTarget.targetChannel;
    info.innerHTML = "";
    appendLine(info, `当前版本：${currentVersion}`);
    appendLine(info, `当前安装：${describeUpdateTarget(installedChannel, installedPrNumber)}`);
    appendLine(info, `当前目标：${describeUpdateTarget(effectiveTargetChannel, state.selectedPrNumber)}`);
    if (state.selectedPrNumber && !state.items.some((item) => item.prNumber === state.selectedPrNumber)) {
      appendLine(info, "当前已保存的目标 PR 不在可选列表中，可能已关闭或尚未生成测试包。");
    }

    if (!state.lastCheck) {
      appendLine(info, "检查结果：未执行");
    } else if (!state.lastCheck.ok) {
      appendLine(info, `检查结果：失败（${state.lastCheck.error || "unknown"}）`);
    } else {
      appendLine(info, `目标版本：${state.lastCheck.latestVersion}（tag: ${state.lastCheck.latestTag}）`);
      appendLine(info, `资源文件：${state.lastCheck.assetName || "未知"}`);
      appendLine(info, `更新方式：${state.lastCheck.requiresReinstall ? "需重新下载安装" : "可直接下载安装"}`);
    }

    list.innerHTML = "";
    if (state.loading) {
      appendEmptyMessage(list, "正在加载可选 PR 列表…");
    } else if (state.error) {
      appendEmptyMessage(list, `加载失败：${state.error}`);
    } else if (!state.items.length) {
      appendEmptyMessage(list, "当前没有可选的 PR 测试版。");
    } else {
      for (const item of state.items) {
        const row = document.createElement("div");
        row.style.border = item.prNumber === state.selectedPrNumber ? "1px solid rgba(92,196,255,.65)" : "1px solid rgba(255,255,255,.10)";
        row.style.borderRadius = "12px";
        row.style.padding = "10px 12px";
        row.style.background = item.prNumber === state.selectedPrNumber ? "rgba(92,196,255,.10)" : "rgba(255,255,255,.03)";

        const head = document.createElement("div");
        head.style.display = "flex";
        head.style.alignItems = "center";
        head.style.justifyContent = "space-between";
        head.style.gap = "12px";

        const textWrap = document.createElement("div");
        textWrap.style.flex = "1";
        textWrap.style.minWidth = "0";

        const title = document.createElement("div");
        title.style.fontWeight = "600";
        title.style.wordBreak = "break-word";
        title.textContent = item.title || `PR #${item.prNumber}`;
        textWrap.appendChild(title);

        const meta = document.createElement("div");
        meta.style.marginTop = "4px";
        meta.style.opacity = "0.86";
        meta.style.fontSize = "12px";
        meta.style.wordBreak = "break-word";
        meta.textContent = `#${item.prNumber}  最新测试版：${item.latestVersion}  发布时间：${formatDate(item.publishedAt)}`;
        textWrap.appendChild(meta);

        head.appendChild(textWrap);

        const btnSelect = document.createElement("button");
        btnSelect.type = "button";
        btnSelect.className = "slqj-ai-btn" + (item.prNumber === state.selectedPrNumber ? " is-ghost" : "");
        btnSelect.textContent = state.selectingPrNumber === item.prNumber ? "检查中…" : item.prNumber === state.selectedPrNumber ? "已选中" : "选择";
        btnSelect.disabled = !!state.selectingPrNumber;
        btnSelect.addEventListener("click", () => {
          void selectPr(item);
        });
        head.appendChild(btnSelect);

        row.appendChild(head);

        if (state.lastCheck?.ok && state.lastCheck.targetPrNumber === item.prNumber) {
          const status = document.createElement("div");
          status.style.marginTop = "8px";
          status.style.fontSize = "12px";
          status.style.opacity = "0.88";
          status.textContent = describeCheckResult(state.lastCheck);
          row.appendChild(status);
        } else if (!state.lastCheck?.ok && state.selectedPrNumber === item.prNumber && state.lastCheck) {
          const status = document.createElement("div");
          status.style.marginTop = "8px";
          status.style.fontSize = "12px";
          status.style.opacity = "0.88";
          status.textContent = `检查失败：${state.lastCheck.error || "unknown"}`;
          row.appendChild(status);
        }

        list.appendChild(row);
      }
    }

    btnRefresh.disabled = state.loading || !!state.selectingPrNumber;
  };

  const loadList = async () => {
    if (state.loading || state.selectingPrNumber) return;
    state.loading = true;
    state.error = "";
    shell.setStatus("正在加载可选 PR 列表…");
    render();

    const result = await fetchSelectablePrBuilds(SLQJ_AI_UPDATE_REPO);
    if (result.ok) {
      state.items = Array.isArray(result.items) ? result.items : [];
      shell.setStatus(state.items.length ? "已加载可选 PR 测试版列表" : "当前没有可选的 PR 测试版");
    } else {
      state.items = [];
      state.error = String(result.error || "unknown");
      shell.setStatus(`列表加载失败：${state.error}`);
    }

    state.loading = false;
    render();
  };

  const selectPr = async (item) => {
    const prNumber = normalizeUpdatePrNumber(item?.prNumber);
    if (!prNumber || state.loading || state.selectingPrNumber) return;

    state.selectingPrNumber = prNumber;
    state.selectedPrNumber = prNumber;
    state.lastCheck = null;
    saveUpdateChannel(game, UPDATE_CHANNEL_PR);
    saveUpdatePrNumber(game, prNumber);
    shell.setStatus(`已切换目标到 PR测试版 #${prNumber}，正在检查更新…`);
    render();

    const result = await checkForUpdate({
      currentVersion,
      installedChannel,
      installedPrNumber,
      targetChannel: UPDATE_CHANNEL_PR,
      targetPrNumber: prNumber,
    });
    state.lastCheck = result;
    mergeGameUpdateState(game, { checkedAt: Date.now(), ...result });
    shell.setStatus(describeCheckStatus(result, prNumber));
    state.selectingPrNumber = "";
    render();
  };

  render();
  await loadList();
}

/**
 * @param {*} game
 * @param {Record<string, any>} patch
 * @returns {void}
 */
function mergeGameUpdateState(game, patch) {
  try {
    if (!game) return;
    const prev = game.__slqjAiUpdateState;
    const base = prev && typeof prev === "object" ? prev : {};
    game.__slqjAiUpdateState = Object.assign({}, base, patch);
  } catch (e) {}
}

/**
 * @param {*} game
 * @param {string} targetPrNumber
 * @returns {any}
 */
function readCachedCheck(game, targetPrNumber) {
  try {
    const state = game?.__slqjAiUpdateState;
    const prNumber = normalizeUpdatePrNumber(targetPrNumber);
    if (!state || typeof state !== "object") return null;
    if (String(state?.targetChannel || "") !== UPDATE_CHANNEL_PR) return null;
    if (normalizeUpdatePrNumber(state?.targetPrNumber) !== prNumber) return null;
    return state;
  } catch (e) {
    return null;
  }
}

/**
 * @param {any} result
 * @param {string} prNumber
 * @returns {string}
 */
function describeCheckStatus(result, prNumber) {
  if (!result?.ok) return `已切换到 PR测试版 #${prNumber}，但检查失败：${String(result?.error || "unknown")}`;
  if (!result.updateAvailable) return `已切换到 PR测试版 #${prNumber}，当前已是目标通道最新版本`;
  if (result.requiresReinstall) return `已切换到 PR测试版 #${prNumber}，发现目标版本；请在“检查更新/更新”中重新下载安装`;
  return `已切换到 PR测试版 #${prNumber}，发现新版本；请在“检查更新/更新”中下载安装`;
}

/**
 * @param {any} result
 * @returns {string}
 */
function describeCheckResult(result) {
  if (!result?.ok) return `检查失败：${String(result?.error || "unknown")}`;
  if (!result.updateAvailable) return "当前已是目标通道最新版本";
  if (result.requiresReinstall) return "发现目标版本，需重新下载安装";
  return "发现新版本，可下载安装";
}

/**
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
  if (parent.classList && parent.classList.contains("slqj-ai-footer")) {
    const holder = parent.querySelector(".slqj-ai-footer-buttons") || parent;
    holder.appendChild(btn);
  } else {
    parent.appendChild(btn);
  }
  return btn;
}

/**
 * @param {HTMLElement} root
 * @param {string} text
 * @returns {void}
 */
function appendLine(root, text) {
  const line = document.createElement("div");
  line.textContent = String(text || "");
  root.appendChild(line);
}

/**
 * @param {HTMLElement} root
 * @param {string} text
 * @returns {void}
 */
function appendEmptyMessage(root, text) {
  const el = document.createElement("div");
  el.className = "slqj-ai-empty";
  el.textContent = String(text || "");
  root.appendChild(el);
}

/**
 * @param {string} iso
 * @returns {string}
 */
function formatDate(iso) {
  const raw = String(iso || "").trim();
  if (!raw) return "";
  return raw.length >= 10 ? raw.slice(0, 10) : raw;
}
