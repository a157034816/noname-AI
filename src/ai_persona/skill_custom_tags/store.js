/**
 * @typedef {Record<string, boolean|number|string>} SkillCustomTags
 */

/**
 * 技能自定义 tag 仓库：按 skillId 聚合多个补全处理器的结果，并提供统一写入入口。
 */
export class SkillCustomTagStore {
	constructor() {
		/** @type {Record<string, SkillCustomTags>} */
		this.bySkill = Object.create(null);
	}

	/**
	 * 为某个技能追加/覆盖自定义 tag。
	 *
	 * @param {string} skillId
	 * @param {SkillCustomTags} tags
	 * @returns {void}
	 */
	add(skillId, tags) {
		const id = String(skillId || "");
		if (!id) return;
		if (!tags || typeof tags !== "object") return;
		const current = this.bySkill[id] || (this.bySkill[id] = Object.create(null));
		for (const [k, v] of Object.entries(tags)) {
			if (!k) continue;
			if (typeof v === "undefined") continue;
			current[k] = v;
		}
	}

	/**
	 * 导出为可序列化的 plain object（仅浅拷贝一层）。
	 *
	 * @returns {Record<string, SkillCustomTags>}
	 */
	toJSON() {
		/** @type {Record<string, SkillCustomTags>} */
		const out = Object.create(null);
		for (const [sid, tags] of Object.entries(this.bySkill)) {
			out[sid] = Object.assign(Object.create(null), tags);
		}
		return out;
	}

	/**
	 * 将 store 中的 tags 写入 `lib.skill[skillId].ai`。
	 *
	 * @param {*} lib
	 * @param {{overwrite?: boolean}} [opts]
	 * @returns {{applied: string[], missingSkills: string[], skippedExisting: Array<{skillId:string, tag:string}>}}
	 */
	applyToLib(lib, opts) {
		const overwrite = !!(opts && opts.overwrite);
		const applied = [];
		const missingSkills = [];
		/** @type {Array<{skillId:string, tag:string}>} */
		const skippedExisting = [];

		const skills = lib && lib.skill;
		if (!skills || typeof skills !== "object") {
			return { applied, missingSkills: Object.keys(this.bySkill), skippedExisting };
		}

		for (const [skillId, tags] of Object.entries(this.bySkill)) {
			const info = skills[skillId];
			if (!info || typeof info !== "object") {
				missingSkills.push(skillId);
				continue;
			}

			// skill.ai 可能为空/非对象；这里做兼容性兜底
			if (!info.ai || typeof info.ai !== "object") {
				info.ai = Object.create(null);
			}

			for (const [tag, value] of Object.entries(tags || {})) {
				if (!tag) continue;
				if (!overwrite && Object.prototype.hasOwnProperty.call(info.ai, tag)) {
					skippedExisting.push({ skillId, tag });
					continue;
				}
				info.ai[tag] = value;
			}
			applied.push(skillId);
		}

		return { applied, missingSkills, skippedExisting };
	}
}

