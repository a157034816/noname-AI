import { checkForUpdate } from "./updater.js";
import logManager from "../logger/manager.js";

const LAST_CHECK_KEY = "slqj_ai_update_last_check_ts";

/**
 * 启动时自动检查更新（每次启动最多一次），不负责弹窗、不自动更新。
 *
 * @param {{baseUrl:string, lib:any, game:any, config:any, currentVersion:string, connectMode?:boolean}} opts
 * @returns {Promise<any|null>}
 */
export async function maybeAutoCheckForUpdates(opts) {
  const game = opts?.game;
  const lib = opts?.lib;
  const config = opts?.config;
  const logger = logManager;

  const connectMode = !!opts?.connectMode;
  if (connectMode) return null;

  const enabled = config?.slqj_ai_update_auto_check ?? lib?.config?.slqj_ai_update_auto_check ?? true;
  if (!enabled) return null;

  const now = Date.now();

  // 仅每次启动最多执行一次，避免某些环境反复加载 precontent。
  try {
    if (game && game.__slqjAiUpdateAutoChecked) return null;
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
  if (!currentVersion) return null;

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
      logger.warn(
        "update",
        `发现新版本：${result.currentVersion} -> ${result.latestVersion}（在扩展设置中点击“检查更新/更新”）`
      );
    }
  } catch (e) {}

  return result;
}
