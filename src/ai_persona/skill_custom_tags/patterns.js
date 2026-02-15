/**
 * 技能说明文本正则片段与工具函数。
 *
 * 说明：
 * - 这些片段主要用于“基于技能说明文本”的正则推导，默认面向中文翻译文本
 * - 仅作为启发式标注，不保证 100% 精确
 */

/** 数字片段：阿拉伯数字 / 常见中文数字 / X/Y / 占位写法（如 `[0]`、`×`）/ 简单表达式（如 `X+1`、`X-1`）。 */
export const NUM = String.raw`(?:\[\d+\]|\d+|[一二两三四五六七八九十百]+|X|Y|×)(?:\s*[+-]\s*(?:\[\d+\]|\d+|[一二两三四五六七八九十百]+|X|Y|×))?`;

/**
 * 判断文本是否包含任意关键词（用于正则前的快速门禁）。
 *
 * @param {string} text
 * @param {string[]} keywords
 * @returns {boolean}
 */
export function includesAny(text, keywords) {
	if (!text || !Array.isArray(keywords) || !keywords.length) return false;
	for (const k of keywords) {
		if (!k) continue;
		if (text.includes(k)) return true;
	}
	return false;
}
