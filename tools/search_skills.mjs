import { getSkillsCatalog } from "./load_skills.mjs"
import { log } from "../lib/log.mjs"

const MAX_RESULTS = 20

export const name = "search_skills"
export const definition = {
	name,
	title: "搜索技能",
	description: "只返回技能 key、名称和简短描述，便于按需发现技能；随后用 load_skills 的精确 key 读取一个完整 SKILL.md。",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "按 key、名称或描述匹配的关键词。" },
			limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, description: `可选，最多返回 ${MAX_RESULTS} 个，默认 10。` },
		},
		required: ["query"],
	},
}

export async function call(args, { signal } = {}) {
	const rawQuery = args?.query
	const query = typeof rawQuery === "string" ? rawQuery.trim() : ""
	const limit = args?.limit === undefined ? 10 : args.limit
	if (!query || query.length > 160) {
		return { content: [{ type: "text", text: "Error: query must be a non-empty string up to 160 characters" }], isError: true }
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
		return { content: [{ type: "text", text: `Error: limit must be an integer from 1 to ${MAX_RESULTS}` }], isError: true }
	}
	if (signal?.aborted) return { content: [{ type: "text", text: "Error: Skill search cancelled" }], isError: true }
	const terms = query.toLocaleLowerCase().split(/\s+/)
	const matches = getSkillsCatalog()
		.filter((skill) => {
			const text = `${skill.key}\n${skill.name}\n${skill.description}`.toLocaleLowerCase()
			return terms.every((term) => text.includes(term))
		})
		.slice(0, limit)
	log("info", "search_skills", "finished", { outcome: "ok", count: matches.length })
	return {
		content: [{ type: "text", text: matches.length ? matches.map((skill) => `- ${skill.key} — ${skill.description}`).join("\n") : "No matching skills." }],
	}
}
