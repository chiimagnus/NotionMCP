import { SANDBOX_DIR } from "../lib/config.mjs"
import { formatAgentsMdContext, getAgentsMdContext, markAgentsMdContextDelivered } from "../lib/agentsMd.mjs"
import { resolvePath } from "../lib/paths.mjs"
import { getSkillsCatalog } from "./load_skills.mjs"

export const name = "project_context"
export const definition = {
	name,
	title: "读取项目上下文（只读）",
	description: "只读地加载全局 ~/.codex/AGENTS.md、当前项目从外到内的 AGENTS.md，以及所有可用 skills 的 key、name、description。返回规则来源与 digest；开始开发任务时先调用，随后用 load_skills 的精确 key 按需读取正文。",
	inputSchema: {
		type: "object",
		properties: {
			cwd: { type: "string", description: "可选，相对默认工作目录的子目录或绝对目录。" },
		},
	},
}

function formatSkillsCatalog() {
	const skills = getSkillsCatalog()
	if (skills.length === 0) return "\n\n[available skills]\n(no skills found)"
	return `\n\n[available skills]\n${skills
		.map((skill) => `- key: ${skill.key}\n  name: ${skill.name}\n  description: ${skill.description}`)
		.join("\n")}`
}

export async function call(args, { signal } = {}) {
	const cwd = args?.cwd
	if (cwd !== undefined && typeof cwd !== "string") {
		return { content: [{ type: "text", text: "Error: cwd must be a string" }], isError: true }
	}
	const workDir = cwd ? resolvePath(cwd) : SANDBOX_DIR
	const context = await getAgentsMdContext(workDir, { signal })
	if (context.cancelled) return { content: [{ type: "text", text: "Error: Project context read cancelled" }], isError: true }
	markAgentsMdContextDelivered(context)
	if (signal?.aborted) return { content: [{ type: "text", text: "Error: Project context read cancelled" }], isError: true }
	return { content: [{ type: "text", text: formatAgentsMdContext(context) + formatSkillsCatalog() }] }
}
