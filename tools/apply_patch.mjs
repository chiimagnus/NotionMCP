// tools/apply_patch.mjs
// The `apply_patch` tool: create, update, or delete files via a batch of
// structured operations (modeled after OpenAI's official apply_patch tool).
// Unlike the official V4A unified-diff format, `update_file` here uses exact
// oldStr/newStr replacements (same idea as Notion's own page-edit tool),
// which is simpler to implement correctly than a full diff parser.

import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"
import { resolvePath } from "../lib/paths.mjs"
import { log } from "../lib/log.mjs"
import { getAgentsMdBlock } from "../lib/agentsMd.mjs"

export const name = "apply_patch"

export const definition = {
	name,
	title: "编辑文件",
	description:
		"在一次调用里对文件做批量的新建 / 修改 / 删除操作。每个 operation 独立执行、独立返回成功或失败，不会因为某一个失败就回滚其他已完成的操作。修改文件（update_file）使用精确字符串替换（oldStr/newStr），oldStr 必须在文件中唯一出现，除非设置 replaceAll。相对路径基于沙盒文件夹解析，也支持绝对路径——和 run_command 一样，这不是一个严格的沙盒边界。",
	inputSchema: {
		type: "object",
		properties: {
			operations: {
				type: "array",
				description: "要执行的文件操作列表，按顺序依次执行。",
				items: {
					type: "object",
					properties: {
						type: {
							type: "string",
							enum: ["create_file", "update_file", "delete_file"],
							description: "操作类型。",
						},
						path: { type: "string", description: "目标文件路径。" },
						content: {
							type: "string",
							description: "create_file 专用：新文件的完整内容。",
						},
						overwrite: {
							type: "boolean",
							description: "create_file 专用：目标文件已存在时是否允许覆盖，默认 false（已存在则报错）。",
						},
						edits: {
							type: "array",
							description: "update_file 专用：按顺序应用的字符串替换列表。",
							items: {
								type: "object",
								properties: {
									oldStr: { type: "string", description: "要被替换的原文，必须与文件内容精确匹配。" },
									newStr: { type: "string", description: "替换后的新内容。" },
									replaceAll: {
										type: "boolean",
										description: "oldStr 在文件中出现多次时，是否全部替换，默认 false（出现多次则报错）。",
									},
								},
								required: ["oldStr", "newStr"],
							},
						},
					},
					required: ["type", "path"],
				},
			},
		},
		required: ["operations"],
	},
}

async function fileExists(path) {
	try {
		await stat(path)
		return true
	} catch (err) {
		if (err.code === "ENOENT") return false
		throw err
	}
}

async function applyOperation(op) {
	const { type, path: rawPath } = op || {}
	if (!rawPath || typeof rawPath !== "string") {
		const error = new Error("Missing required 'path' string")
		return { path: rawPath, type, status: "failed", output: error.message, error }
	}
	const resolved = resolvePath(rawPath)
	try {
		if (type === "create_file") {
			if (typeof op.content !== "string") throw new Error("create_file requires a 'content' string")
			if (!op.overwrite && (await fileExists(resolved))) {
				throw new Error(`File already exists at '${rawPath}' (pass overwrite: true to replace it)`)
			}
			await mkdir(dirname(resolved), { recursive: true })
			await writeFile(resolved, op.content, "utf-8")
			return { path: rawPath, type, status: "completed", output: `Created ${rawPath}` }
		}
		if (type === "update_file") {
			if (!Array.isArray(op.edits) || op.edits.length === 0) {
				throw new Error("update_file requires a non-empty 'edits' array")
			}
			let text = await readFile(resolved, "utf-8")
			for (const edit of op.edits) {
				const { oldStr, newStr, replaceAll } = edit || {}
				if (typeof oldStr !== "string" || typeof newStr !== "string") {
					throw new Error("each edit requires 'oldStr' and 'newStr' strings")
				}
				const count = text.split(oldStr).length - 1
				if (count === 0) throw new Error(`oldStr not found in ${rawPath}`)
				if (count > 1 && !replaceAll) {
					throw new Error(`oldStr matches ${count} times in ${rawPath}; set replaceAll: true or make oldStr more specific`)
				}
				text = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr)
			}
			await writeFile(resolved, text, "utf-8")
			return { path: rawPath, type, status: "completed", output: `Updated ${rawPath}` }
		}
		if (type === "delete_file") {
			await unlink(resolved)
			return { path: rawPath, type, status: "completed", output: `Deleted ${rawPath}` }
		}
		throw new Error(`Unknown operation type '${type}'`)
	} catch (err) {
		return { path: rawPath, type, status: "failed", output: String((err && err.message) || err), error: err }
	}
}

export async function call(args, context = {}) {
	const operations = (args && args.operations) || []
	if (!Array.isArray(operations) || operations.length === 0) {
		log("warning", "apply_patch", "finished", { message: "'operations' must be a non-empty array" })
		return { content: [{ type: "text", text: "Error: 'operations' must be a non-empty array" }], isError: true }
	}
	const results = []
	for (const op of operations) {
		if (context.signal?.aborted) {
			results.push({ type: op?.type, path: op?.path, status: "failed", output: "Cancelled before operation" })
			log("warning", "apply_patch", "operation", {
				operation: op?.type || "unknown",
				outcome: "cancelled",
				message: "Cancelled before operation",
			})
			break
		}
		const result = await applyOperation(op)
		results.push(result)
		// ponytail: oldStr 没匹配上、文件已存在这类失败是调用方给的内容和文件真实状态对不上，
		// 不是 NotionMCP 自己的进程故障，降级为 warning；真正的进程级故障走 http 层的 tool failed 事件。
		log(result.status === "failed" ? "warning" : "info", "apply_patch", "operation", {
			operation: result.type || "unknown",
			outcome: result.status,
			...(result.error ? { error: result.error } : {}),
		})
		// ponytail: operation 是取消边界；让 HTTP close 事件有机会在下一次写入前到达。
		await yieldToEventLoop()
	}
	const text = results
		.map((r) => `[${r.status}] ${r.type} ${r.path}${r.output ? ` \u2014 ${r.output}` : ""}`)
		.join("\n")
	const hasFailure = results.some((r) => r.status === "failed")
	const firstPath = operations[0] && operations[0].path
	const agentsMdBlock = firstPath && !context.signal?.aborted ? getAgentsMdBlock(dirname(resolvePath(firstPath))) : ""
	return { content: [{ type: "text", text: text + agentsMdBlock }], isError: hasFailure }
}
