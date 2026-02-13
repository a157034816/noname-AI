import { checkForUpdate } from "./updater.js";

const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "slqj_ai_update_last_check_ts";

/**
 * 启动时自动检查更新（节流），不自动弹窗、不自动更新。
 *
 * @param {{baseUrl:string, lib:any, game:any, config:any, currentVersion:string, connectMode?:boolean}} opts
 * @returns {Promise<void>}
 */
export async function maybeAutoCheckForUpdates(opts) {
  const game = opts?.game;
  const lib = opts?.lib;
  const config = opts?.config;

  const connectMode = !!opts?.connectMode;
  if (connectMode) return;

  const enabled = config?.slqj_ai_update_auto_check ?? lib?.config?.slqj_ai_update_auto_check ?? true;
  if (!enabled) return;

  const now = Date.now();
  const lastRaw = config?.[LAST_CHECK_KEY] ?? lib?.config?.[LAST_CHECK_KEY];
  const last = Number(lastRaw || 0) || 0;
  if (now - last < AUTO_CHECK_INTERVAL_MS) return;

  // 仅每次启动最多执行一次，避免某些环境反复加载 precontent。
  try {
    if (game && game.__slqjAiUpdateAutoChecked) return;
    if (game) game.__slqjAiUpdateAutoChecked = true;
  } catch (e) {}

  // 先写入 last_check，避免并发/失败导致反复请求
  try {
    if (game && typeof game.saveConfig === "function") {
      game.saveConfig(`extension_身临其境的AI_${LAST_CHECK_KEY}`, String(now));
      game.saveConfig(LAST_CHECK_KEY, String(now));
    }
  } catch (e) {}

  const currentVersion = String(opts?.currentVersion || "").trim();
  if (!currentVersion) return;

  const result = await checkForUpdate({ currentVersion });
  try {
    if (game) {
      game.__slqjAiUpdateState = {
        checkedAt: now,
        ...result,
      };
    }
  } catch (e) {}

  try {
    if (result && result.ok && result.updateAvailable) {
      console.warn(
        `[身临其境的AI][update] 发现新版本：${result.currentVersion} -> ${result.latestVersion}（在扩展设置中点击“检查更新/更新”）`
      );
    }
  } catch (e) {}
}

