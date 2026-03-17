import { createModalShell } from "../scripts_manager_modal.js";
import { canWriteFiles } from "./node_env.js";
import { checkForUpdate, downloadAndApplyUpdate, fetchReleaseNotesBetweenVersions } from "./updater.js";
import { SLQJ_AI_UPDATE_REPO } from "../version.js";

/**
 * @typedef {{version:string, tagName:string, title:string, body:string, htmlUrl:string, publishedAt:string}} SlqjAiReleaseNote
 */

/**
 * 打开“检查更新/一键更新”弹窗。
 *
 * @param {{baseUrl:string, lib:any, game:any, ui:any, config:any, currentVersion:string, initialCheck?:any}} opts
 * @returns {Promise<void>}
 */
export async function openUpdateModal(opts) {
  const baseUrl = String(opts?.baseUrl || "");
  const game = opts?.game;
  const currentVersion = String(opts?.currentVersion || "").trim();
  if (!baseUrl || !currentVersion) return;

  const shell = createModalShell({
    title: "身临其境的AI-扩展更新",
    subtitle: "从 GitHub Releases 检查新版本；下载并覆盖更新后需重启生效。",
    ui: opts?.ui,
  });

  const toolbar = shell.shadow.querySelector("[data-slqj-ai-toolbar]");
  const listWrap = shell.shadow.querySelector("[data-slqj-ai-list]");
  const footer = shell.shadow.querySelector("[data-slqj-ai-footer]");
  if (!toolbar || !listWrap || !footer) return;

  /**
   * @param {Record<string, any>} patch
   * @returns {void}
   */
  const mergeGameUpdateState = (patch) => {
    try {
      if (!game) return;
      const prev = game.__slqjAiUpdateState;
      const base = prev && typeof prev === "object" ? prev : {};
      game.__slqjAiUpdateState = Object.assign({}, base, patch);
    } catch (e) {}
  };

  /**
   * @param {string} key
   * @returns {{notes: SlqjAiReleaseNote[], warning: string}|null}
   */
  const readCachedNotes = (key) => {
    try {
      if (!game) return null;
      const s = game.__slqjAiUpdateState;
      if (!s || typeof s !== "object") return null;
      if (String(s.releaseNotesKey || "") !== String(key || "")) return null;
      if (!Array.isArray(s.releaseNotes)) return null;
      return { notes: /** @type {SlqjAiReleaseNote[]} */ (s.releaseNotes), warning: String(s.releaseNotesWarning || "") };
    } catch (e) {
      return null;
    }
  };

  const state = {
    writable: false,
    checking: false,
    updating: false,
    confirmUntil: 0,
    lastCheck: /** @type {any} */ (null),
    notesLoading: false,
    notesKey: "",
    notesError: "",
    notesWarning: "",
    releaseNotes: /** @type {SlqjAiReleaseNote[]|null} */ (null),
  };

  state.writable = await canWriteFiles({ game });

  // 若启动时已完成检查，可直接复用结果，避免重复请求。
  const initialCheck = opts?.initialCheck;
  if (initialCheck) {
    state.lastCheck = initialCheck;
    try {
      mergeGameUpdateState({ checkedAt: Date.now(), ...initialCheck });
    } catch (e) {}
    if (initialCheck.ok) {
      shell.setStatus(initialCheck.updateAvailable ? "发现新版本：可点击“下载并更新”" : "已是最新版本");
    } else {
      shell.setStatus("检查失败：" + String(initialCheck.error || "unknown"));
    }
  }

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

  /**
   * @param {string} iso
   * @returns {string}
   */
  const formatDate = (iso) => {
    const raw = String(iso || "").trim();
    if (!raw) return "";
    // GitHub published_at 为 ISO 字符串，这里仅展示日期部分即可。
    return raw.length >= 10 ? raw.slice(0, 10) : raw;
  };

  const clearNotes = () => {
    state.notesLoading = false;
    state.notesKey = "";
    state.notesError = "";
    state.notesWarning = "";
    state.releaseNotes = null;
  };

  /**
   * 拉取并渲染“更新内容”（从当前版本到 latest 的 release body）。
   *
   * @returns {void}
   */
  const kickNotesFetch = () => {
    try {
      if (state.notesLoading) return;
      const r = state.lastCheck;
      if (!r || !r.ok) {
        clearNotes();
        return;
      }
      if (!r.updateAvailable) {
        clearNotes();
        render();
        return;
      }

      const key = `${String(r.currentVersion || "").trim()}->${String(r.latestTag || r.latestVersion || "").trim()}`;
      if (!key) return;

      // 若 key 未变化且已有结果，则不重复请求。
      if (state.notesKey === key && (state.releaseNotes || state.notesError)) return;
      state.notesKey = key;

      const cached = readCachedNotes(key);
      if (cached) {
        state.notesLoading = false;
        state.notesError = "";
        state.notesWarning = String(cached.warning || "");
        state.releaseNotes = cached.notes;
        render();
        return;
      }

      state.notesLoading = true;
      state.notesError = "";
      state.notesWarning = "";
      state.releaseNotes = null;
      render();

      fetchReleaseNotesBetweenVersions({ currentVersion: r.currentVersion, latestVersion: r.latestVersion, latestTag: r.latestTag })
        .then((res) => {
          state.notesLoading = false;
          if (!res || !res.ok) {
            state.notesError = String((res && res.error) || "unknown");
            state.notesWarning = "";
            state.releaseNotes = null;
            render();
            return;
          }
          state.notesError = "";
          state.notesWarning = String(res.warning || "");
          state.releaseNotes = Array.isArray(res.notes) ? res.notes : [];

          try {
            mergeGameUpdateState({
              releaseNotesKey: key,
              releaseNotes: state.releaseNotes,
              releaseNotesWarning: state.notesWarning,
              releaseNotesFetchedAt: Date.now(),
            });
          } catch (e) {}

          render();
        })
        .catch((e) => {
          state.notesLoading = false;
          state.notesError = String(e && e.message ? e.message : e) || "unknown";
          state.notesWarning = "";
          state.releaseNotes = null;
          render();
        });
    } catch (e) {}
  };

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

    // —— 更新内容 ——
    try {
      const notesWrap = document.createElement("div");
      notesWrap.style.marginTop = "12px";

      const header = document.createElement("div");
      header.style.fontWeight = "600";
      header.style.opacity = "0.95";
      header.textContent = state.lastCheck?.ok
        ? `更新内容（${currentVersion} -> ${String(state.lastCheck.latestVersion || "").trim() || "latest"}）`
        : "更新内容";
      notesWrap.appendChild(header);

      const addMsg = (text) => {
        const el = document.createElement("div");
        el.textContent = String(text || "");
        el.style.marginTop = "6px";
        el.style.opacity = "0.9";
        notesWrap.appendChild(el);
      };

      if (!state.lastCheck) {
        addMsg("（检查更新后显示）");
      } else if (!state.lastCheck.ok) {
        addMsg("（检查失败，无法获取更新内容）");
      } else if (!state.lastCheck.updateAvailable) {
        addMsg("无（已是最新版本）");
      } else if (state.notesLoading) {
        addMsg("正在获取更新内容…");
      } else if (state.notesError) {
        addMsg(`更新内容获取失败（${state.notesError}）`);
      } else if (!state.releaseNotes) {
        addMsg("（待加载）");
      } else if (!state.releaseNotes.length) {
        addMsg("无（release 未提供更新说明或未命中区间）");
      } else {
        if (state.notesWarning) {
          const w = document.createElement("div");
          w.textContent = String(state.notesWarning || "");
          w.style.marginTop = "6px";
          w.style.opacity = "0.85";
          notesWrap.appendChild(w);
        }

        const list = state.releaseNotes;
        for (let i = 0; i < list.length; i++) {
          const n = list[i];
          const ver = String(n?.version || "").trim();
          const tag = String(n?.tagName || "").trim();
          const title = String(n?.title || "").trim();
          const date = formatDate(n?.publishedAt);

          const details = document.createElement("details");
          details.open = i === list.length - 1;
          details.style.marginTop = "8px";
          details.style.border = "1px solid rgba(255,255,255,.10)";
          details.style.borderRadius = "12px";
          details.style.padding = "8px 10px";
          details.style.background = "rgba(255,255,255,.03)";

          const summary = document.createElement("summary");
          summary.style.cursor = "pointer";
          summary.style.userSelect = "text";
          summary.textContent = `${ver ? "v" + ver : tag || "release"}${tag ? `（tag: ${tag}）` : ""}${date ? `  ${date}` : ""}${title ? `  ${title}` : ""}`;
          details.appendChild(summary);

          const body = document.createElement("div");
          body.style.whiteSpace = "pre-wrap";
          body.style.wordBreak = "break-word";
          body.style.marginTop = "8px";
          body.style.fontSize = "12px";
          body.style.opacity = "0.92";
          body.textContent = String(n?.body || "").trim() || "（该版本未提供更新说明）";
          details.appendChild(body);

          notesWrap.appendChild(details);
        }
      }

      info.appendChild(notesWrap);
    } catch (e) {}

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
      mergeGameUpdateState({ checkedAt: Date.now(), ...result });
    } catch (e) {}
    if (result.ok) {
      shell.setStatus(result.updateAvailable ? "发现新版本：可点击“下载并更新”" : "已是最新版本");
    } else {
      shell.setStatus("检查失败：" + String(result.error || "unknown"));
    }
    state.checking = false;
    render();
    kickNotesFetch();
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
  kickNotesFetch();

  // 打开弹窗后自动检查一次（不自动更新）
  try {
    if (!state.lastCheck) await doCheck();
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
