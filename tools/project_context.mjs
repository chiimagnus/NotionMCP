import { SANDBOX_DIR } from "../lib/config.mjs"
import { formatAgentsMdContext, getAgentsMdContext, markAgentsMdContextDelivered } from "../lib/agentsMd.mjs"
import { resolvePath } from "../lib/paths.mjs"

export const name = "project_context"
export const definition = {
	name,
	title: "读取项目规则",
	description: "只读地加载全局 ~/.codex/AGENTS.md 与当前项目从外到内的 AGENTS.md，返回来源、digest 和完整规则。开始开发任务时先调用；规则变更后可再次调用。",
	inputSchema: {
		type: "object",
		properties: {
			cwd: { type: "string", description: "可选，相对默认工作目录的子目录或绝对目录。" },
		},
	},
}

export async function call(args, { signal } = {}) {
	const workDir = args?.cwd ? resolvePath(args.cwd) : SANDBOX_DIR
	const context = await getAgentsMdContext(workDir, { signal })
	if (context.cancelled) return { content: [{ type: "text", text: "Error: Project context read cancelled" }], isError: true }
	markAgentsMdContextDelivered(context)
	return { content: [{ type: "text", text: formatAgentsMdContext(context) }] }
}
