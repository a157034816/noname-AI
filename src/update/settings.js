export const UPDATE_CHANNEL_STABLE = "stable";
export const UPDATE_CHANNEL_PR = "pr";

const EXTENSION_NAME = "身临其境的AI";
const UPDATE_CHANNEL_KEY = "slqj_ai_update_channel";
const UPDATE_PR_NUMBER_KEY = "slqj_ai_update_pr_number";

/**
 * @param {any} value
 * @returns {"stable"|"pr"}
 */
export function normalizeUpdateChannel(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === UPDATE_CHANNEL_PR ? UPDATE_CHANNEL_PR : UPDATE_CHANNEL_STABLE;
}

/**
 * @param {any} value
 * @returns {string}
 */
export function normalizeUpdatePrNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return digits.replace(/^0+/, "");
}

/**
 * @param {any} value
 * @returns {"stable"|"pr"}
 */
export function normalizeBuildChannel(value) {
  return normalizeUpdateChannel(value);
}

/**
 * @param {any} config
 * @param {any} lib
 * @returns {{ targetChannel: "stable"|"pr", targetPrNumber: string }}
 */
export function readUpdateTarget(config, lib) {
  const targetChannel = normalizeUpdateChannel(config?.[UPDATE_CHANNEL_KEY] ?? lib?.config?.[UPDATE_CHANNEL_KEY]);
  const targetPrNumber = normalizeUpdatePrNumber(
    config?.[UPDATE_PR_NUMBER_KEY] ?? lib?.config?.[UPDATE_PR_NUMBER_KEY]
  );
  return { targetChannel, targetPrNumber };
}

/**
 * @param {any} game
 * @param {"stable"|"pr"} channel
 * @returns {void}
 */
export function saveUpdateChannel(game, channel) {
  const value = normalizeUpdateChannel(channel);
  if (!game || typeof game.saveConfig !== "function") return;
  game.saveConfig(`extension_${EXTENSION_NAME}_${UPDATE_CHANNEL_KEY}`, value);
  game.saveConfig(UPDATE_CHANNEL_KEY, value);
}

/**
 * @param {any} game
 * @param {string} prNumber
 * @returns {void}
 */
export function saveUpdatePrNumber(game, prNumber) {
  const value = normalizeUpdatePrNumber(prNumber);
  if (!game || typeof game.saveConfig !== "function") return;
  game.saveConfig(`extension_${EXTENSION_NAME}_${UPDATE_PR_NUMBER_KEY}`, value);
  game.saveConfig(UPDATE_PR_NUMBER_KEY, value);
}

/**
 * @param {"stable"|"pr"} channel
 * @param {string} prNumber
 * @returns {string}
 */
export function describeUpdateTarget(channel, prNumber) {
  if (normalizeUpdateChannel(channel) === UPDATE_CHANNEL_PR) {
    const normalizedPrNumber = normalizeUpdatePrNumber(prNumber);
    return normalizedPrNumber ? `PR测试版 #${normalizedPrNumber}` : "PR测试版（未填写PR编号）";
  }
  return "stable 正式版";
}
