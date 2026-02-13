import { createModalShell } from "../scripts_manager_modal.js";
import { canWriteFiles } from "./node_env.js";
import { checkForUpdate, downloadAndApplyUpdate } from "./updater.js";
import { SLQJ_AI_UPDATE_REPO } from "../version.js";

/**
 * 打开“检查更新/一键更新”弹窗。
 *
 * @param {{baseUrl:string, lib:any, game:any, ui:any, config:any, currentVersion:string}} opts
 * @returns {Promise<void>}
 */
export async function openUpdateModal(opts) {
  const baseUrl = String(opts?.baseUrl || "");
  const game = opts?.game;
  const currentVersion = String(opts?.currentVersion || "").trim();
  if (!baseUrl || !currentVersion) return;

  const shell = createModalShell({
    title: "扩展更新",
    subtitle: "从 GitHub Releases 检查新版本；下载并覆盖更新后需重启生效。",
    ui: opts?.ui,
  });

  const toolbar = shell.shadow.querySelector("[data-slqj-ai-toolbar]");
  const listWrap = shell.shadow.querySelector("[data-slqj-ai-list]");
  const footer = shell.shadow.querySelector("[data-slqj-ai-footer]");
  if (!toolbar || !listWrap || !footer) return;

  const state = {
    writable: false,
    checking: false,
    updating: false,
    confirmUntil: 0,
    lastCheck: /** @type {any} */ (null),
  };

  state.writable = await canWriteFiles({ game });

  const info = document.createElement("div");
  info.className = "slqj-ai-empty";
  listWrap.innerHTML = "";
  listWrap.appendChild(info);

  const btnCheck = addButton(toolbar, "检查更新", async () => {
    await doCheck();
  });
  const btnOpenRelease = addButton(toolbar, "打开发布页", () => {
    const owner = String(SLQJ_AI_UPDATE_REPO?.owner || "").trim();
    const repo = String(SLQJ_AI_UPDATE_REPO?.repo || "").trim();
    const fallback = owner && repo ? `https://github.com/${owner}/${repo}/releases` : "";
    openExternal(game, state.lastCheck?.ok ? state.lastCheck.htmlUrl : fallback);
  });

  const btnUpdate = addButton(footer, "下载并更新", async () => {
    await doUpdate();
  });
  btnUpdate.disabled = true;
  addButton(footer, "关闭", () => shell.close(), { variant: "ghost" });

  const render = () => {
    info.innerHTML = "";
    appendLine(info, `当前版本：${currentVersion}`);

    if (!state.lastCheck) appendLine(info, "最新版本：未检查");
    else if (!state.lastCheck.ok) appendLine(info, `最新版本：检查失败（${state.lastCheck.error || "unknown"}）`);
    else {
      appendLine(info, `最新版本：${state.lastCheck.latestVersion}（tag: ${state.lastCheck.latestTag}）`);
      appendLine(info, `资源文件：${state.lastCheck.assetName || "未知"}`);
    }

    try {
      const owner = String(SLQJ_AI_UPDATE_REPO?.owner || "").trim();
      const repo = String(SLQJ_AI_UPDATE_REPO?.repo || "").trim();
      if (owner && repo) appendLine(info, `更新源：${owner}/${repo}`);
    } catch (e) {}

    appendLine(info, `自动更新：${state.writable ? "可用（将覆盖文件，保留你额外新增的 scripts/）" : "不可用（当前环境无法写入文件）"}`);

    if (state.lastCheck?.ok) {
      appendLine(info, `发布页：${state.lastCheck.htmlUrl || ""}`);
    }

    btnUpdate.disabled = !state.writable || !state.lastCheck?.ok || !state.lastCheck.updateAvailable || state.updating;
    btnCheck.disabled = state.checking || state.updating;
    btnOpenRelease.disabled = false;
  };

  const doCheck = async () => {
    if (state.checking || state.updating) return;
    state.checking = true;
    shell.setStatus("正在检查更新…");
    render();
    const result = await checkForUpdate({ currentVersion });
    state.lastCheck = result;
    try {
      if (game) game.__slqjAiUpdateState = { checkedAt: Date.now(), ...result };
    } catch (e) {}
    if (result.ok) {
      shell.setStatus(result.updateAvailable ? "发现新版本：可点击“下载并更新”" : "已是最新版本");
    } else {
      shell.setStatus("检查失败：" + String(result.error || "unknown"));
    }
    state.checking = false;
    render();
  };

  const doUpdate = async () => {
    const r = state.lastCheck;
    if (!r || !r.ok) return;
    if (!r.updateAvailable) return;
    if (!state.writable) {
      shell.setStatus("当前环境无法写入文件，无法自动更新");
      render();
      return;
    }
    if (state.updating || state.checking) return;

    const tip = `将下载并覆盖更新：${r.currentVersion} -> ${r.latestVersion}。完成后需要重启游戏/重载扩展生效。是否继续？`;
    let confirmed = false;
    try {
      if (typeof confirm === "function") {
        // eslint-disable-next-line no-undef
        confirmed = !!confirm(tip);
        if (!confirmed) return;
      }
    } catch (e) {}
    if (!confirmed) {
      const now = Date.now();
      if (!state.confirmUntil || now > state.confirmUntil) {
        state.confirmUntil = now + 10000;
        shell.setStatus("再次点击“下载并更新”以确认（10 秒内有效）");
        render();
        return;
      }
    }
    state.confirmUntil = 0;

    state.updating = true;
    shell.setStatus("正在下载并更新…");
    render();
    const applied = await downloadAndApplyUpdate({ game, baseUrl, downloadUrl: r.downloadUrl, backup: true });
    if (applied.ok) {
      shell.setStatus(`更新完成：写入 ${applied.updatedFiles} 个文件。请重启生效（已备份：${applied.backupDir || "无"}）`);
    } else {
      shell.setStatus("更新失败：" + String(applied.error || "unknown"));
    }
    state.updating = false;
    render();
  };

  render();

  // 打开弹窗后自动检查一次（不自动更新）
  try {
    await doCheck();
  } catch (e) {}
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
 */
function appendLine(root, text) {
  const line = document.createElement("div");
  line.textContent = String(text || "");
  root.appendChild(line);
}

/**
 * 尝试在不同环境打开外部链接。
 *
 * @param {*} game
 * @param {string} url
 */
function openExternal(game, url) {
  const u = String(url || "").trim();
  if (!u) return;
  try {
    if (game && typeof game.open === "function") {
      game.open(u);
      return;
    }
  } catch (e) {}
  try {
    // @ts-ignore
    if (typeof window.require === "function") {
      // @ts-ignore
      const electron = window.require("electron");
      if (electron && electron.shell && typeof electron.shell.openExternal === "function") {
        electron.shell.openExternal(u);
        return;
      }
    }
  } catch (e) {}
  try {
    window.open(u);
  } catch (e) {}
}
