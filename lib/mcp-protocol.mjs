import { Server as LegacyServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js"
import {
	ProtocolError,
	ProtocolErrorCode,
	Server,
	createMcpHandler,
	isLegacyRequest,
} from "@modelcontextprotocol/server"

import {
	DEFAULT_IMAGE_MAX_SIZE,
	DEFAULT_TIMEOUT_MS,
	MAX_IMAGE_MAX_SIZE,
	MAX_OUTPUT_CHARS,
	MAX_TIMEOUT_MS,
	SANDBOX_DIR,
	SKILLS_ROOT,
} from "./config.mjs"
import { log } from "./log.mjs"
import { definitions, handlers } from "../tools/index.mjs"

const SERVER_INSTRUCTIONS = `这个 MCP 提供 6 个工具：project_context（规则与 skills 清单）、load_skills（技能正文）、read_file（文本）、read_image（图片）、run_command（命令）和 apply_patch（编辑）。

- 这不是严格沙盒：cwd/path 只是默认工作目录，绝对路径、cd 切换等仍可访问 ${SANDBOX_DIR} 之外的文件。
- 开发任务先调用 project_context；它会返回所有 skills 的 key、name、description，按需再用 load_skills 读取一个正文；先用 read_file/read_image 理解现状，最后才执行命令或写入。
- 不要按进程名批量杀进程；先用完整命令行精确定位 PID，再只结束目标进程。
- 后台服务应重定向 stdout/stderr；否则继承管道会让 run_command 等待 EOF。
- 改文件优先使用 apply_patch 的精确替换，避免 shell 转义、编码和换行损坏内容。
- run_command 输出超过约 ${MAX_OUTPUT_CHARS} 字符会截断；默认 timeout ${DEFAULT_TIMEOUT_MS}ms，最大 ${MAX_TIMEOUT_MS}ms。
- read_image 默认最长边 ${DEFAULT_IMAGE_MAX_SIZE}px，最大 ${MAX_IMAGE_MAX_SIZE}px，单个输入/输出最多 10 MiB。
- AGENTS.md 规则按全局 ~/.codex 到项目内层加载；命令和写入只在规则 digest 改变时附带一次。
- skills 根目录是 ${SKILLS_ROOT}；目录或 SKILL.md 的 mtime 变化会刷新搜索目录。`

export const SERVER_VERSION = "3.0.0"

async function runTool(name, args, signal) {
	const handler = handlers[name]
	try {
		return await handler(args || {}, { signal })
	} catch (error) {
		const cancelled = signal.aborted || error?.name === "AbortError"
		log(cancelled ? "warning" : "error", "tool", cancelled ? "cancelled" : "failed", { tool: name, error })
		return {
			content: [{ type: "text", text: `Error: ${error?.message || error}` }],
			isError: true,
		}
	}
}

function createModernServer() {
	const mcp = new Server(
		{ name: "notionmcp", version: SERVER_VERSION },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
	)
	mcp.setRequestHandler("tools/list", async () => ({ tools: definitions }))
	mcp.setRequestHandler("tools/call", async (request, context) => {
		if (!handlers[request.params.name]) {
			throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
		}
		return runTool(request.params.name, request.params.arguments, context.mcpReq.signal)
	})
	return mcp
}

function createLegacyServer(signal) {
	const mcp = new LegacyServer(
		{ name: "notionmcp", version: SERVER_VERSION },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
	)
	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
	mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		if (!handlers[request.params.name]) {
			throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
		}
		return runTool(request.params.name, request.params.arguments, AbortSignal.any([signal, extra.signal]))
	})
	return mcp
}

async function serveLegacyRequest(req, res, parsedBody, signal, onerror) {
	const mcp = createLegacyServer(signal)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})
	let connected = false
	try {
		await mcp.connect(transport)
		connected = true
		await transport.handleRequest(req, res, parsedBody)
	} finally {
		try {
			if (connected) await mcp.close()
			else await transport.close()
		} catch (error) {
			onerror(error)
		}
	}
}

// ponytail: Notion 尚会发送 2025 请求；仅在 SDK 分类为 legacy 时才使用 v1 的
// 无 session JSON 桥。Notion 全量迁到 2026-07-28 后删除它和 @modelcontextprotocol/sdk。
export function createProtocolHandler(onerror) {
	const modern = createMcpHandler(createModernServer, { legacy: "reject", onerror })
	return {
		close: () => modern.close(),
		fetch: (request) => modern.fetch(request),
		isLegacy: (request, parsedBody) => isLegacyRequest(request, parsedBody),
		serveLegacy: (req, res, parsedBody, signal) => serveLegacyRequest(req, res, parsedBody, signal, onerror),
	}
}
