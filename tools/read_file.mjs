import { open } from "node:fs/promises"

import { resolvePath } from "../lib/paths.mjs"
import { log } from "../lib/log.mjs"

const MAX_BYTES = 1024 * 1024

export const name = "read_file"
export const definition = {
	name,
	title: "Read Text File",
	description: "只读地读取 UTF-8 普通文本文件；可指定从 startLine 到 endLine（均从 1 开始）。最多返回 1 MiB。",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "相对默认工作目录或绝对文件路径。" },
			startLine: { type: "integer", minimum: 1, description: "首行，默认 1。" },
			endLine: { type: "integer", minimum: 1, description: "末行，默认文件末尾。" },
		},
		required: ["path"],
	},
}

function failure(message) {
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true }
}

function lineRange(startLine, endLine) {
	const start = startLine === undefined ? 1 : startLine
	if (!Number.isInteger(start) || start < 1) throw new Error("startLine must be a positive integer")
	if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < start)) throw new Error("endLine must be an integer no smaller than startLine")
	return { start, end: endLine }
}

export async function call(args, { signal } = {}) {
	if (signal?.aborted) return failure("Read cancelled")
	if (!args?.path || typeof args.path !== "string") return failure("Missing required 'path' string")
	let range
	try {
		range = lineRange(args.startLine, args.endLine)
	} catch (error) {
		return failure(error.message)
	}
	try {
		const path = resolvePath(args.path)
		const handle = await open(path, "r")
		let bytes
		try {
			const info = await handle.stat()
			if (!info.isFile()) return failure("Path must be a regular file")
			if (info.size > MAX_BYTES) return failure(`File exceeds ${MAX_BYTES} byte limit`)
			bytes = await handle.readFile({ signal })
		} finally {
			await handle.close()
		}
		if (bytes.includes(0)) return failure("Binary files are not supported")
		let text
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		} catch {
			return failure("File is not valid UTF-8")
		}
		const lines = text.split(/\r?\n/)
		if (range.start > lines.length) return failure("startLine is beyond end of file")
		const end = Math.min(range.end || lines.length, lines.length)
		const selected = lines.slice(range.start - 1, end)
		log("info", "read_file", "finished", { outcome: "ok", count: selected.length })
		return { content: [{ type: "text", text: `${args.path}:${range.start}-${end}\n${selected.join("\n")}` }] }
	} catch (error) {
		if (signal?.aborted || error?.name === "AbortError") return failure("Read cancelled")
		log("warning", "read_file", "finished", { outcome: "failed", errorType: error?.name || "Error" })
		return failure("Unable to read file")
	}
}
