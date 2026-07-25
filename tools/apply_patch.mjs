// tools/apply_patch.mjs
// The `apply_patch` tool: create, update, or delete files via a batch of
// structured operations (modeled after OpenAI's official apply_patch tool).
// Unlike the official V4A unified-diff format, `update_file` here uses exact
// oldStr/newStr replacements (same idea as Notion's own page-edit tool),
// which is simpler to implement correctly than a full diff parser.

import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { resolvePath } from "../lib/paths.mjs"
import { log } from "../lib/rpc.mjs"

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
		return { path: rawPath, type, status: "failed", output: "Missing required 'path' string" }
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
				if (count === 0) throw new Error(`oldStr not found in ${rawPath}: ${JSON.stringify(oldStr.slice(0, 200))}`)
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
		return { path: rawPath, type, status: "failed", output: String((err && err.message) || err) }
	}
}

export async function call(args) {
	const operations = (args && args.operations) || []
	if (!Array.isArray(operations) || operations.length === 0) {
		return { content: [{ type: "text", text: "Error: 'operations' must be a non-empty array" }], isError: true }
	}
	const results = []
	for (const op of operations) {
		const result = await applyOperation(op)
		results.push(result)
		log(`apply_patch ${result.type} ${JSON.stringify(result.path)} -> ${result.status}`)
	}
	const text = results
		.map((r) => `[${r.status}] ${r.type} ${r.path}${r.output ? ` \u2014 ${r.output}` : ""}`)
		.join("\n")
	const hasFailure = results.some((r) => r.status === "failed")
	return { content: [{ type: "text", text }], isError: hasFailure }
}
