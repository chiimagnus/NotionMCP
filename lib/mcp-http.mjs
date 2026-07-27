import { createHash, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js"

import { log, registerLogSecret } from "./log.mjs"
import {
	DEFAULT_IMAGE_MAX_SIZE,
	DEFAULT_TIMEOUT_MS,
	MAX_IMAGE_MAX_SIZE,
	MAX_OUTPUT_CHARS,
	MAX_TIMEOUT_MS,
	SANDBOX_DIR,
	SKILLS_ROOT,
} from "./config.mjs"
import { definitions, handlers } from "../tools/index.mjs"

const HOST = "127.0.0.1"
const MAX_BODY_BYTES = 1024 * 1024
const MAX_ACTIVE_REQUESTS = 4

const SERVER_INSTRUCTIONS = `这个 MCP 提供 4 个工具：run_command（执行命令）、apply_patch（编辑文件）、read_image（读图片）、load_skills（加载技能）。

- 这不是严格沙盒：cwd/path 只是默认工作目录，绝对路径、cd 切换等仍可访问 ${SANDBOX_DIR} 之外的文件。
- 不要按进程名批量杀进程；先用完整命令行精确定位 PID，再只结束目标进程。
- 后台服务应重定向 stdout/stderr；否则继承管道会让 run_command 等待 EOF。
- 改文件优先使用 apply_patch 的精确替换，避免 shell 转义、编码和换行损坏内容。
- run_command 输出超过约 ${MAX_OUTPUT_CHARS} 字符会截断；默认 timeout ${DEFAULT_TIMEOUT_MS}ms，最大 ${MAX_TIMEOUT_MS}ms。
- read_image 默认最长边 ${DEFAULT_IMAGE_MAX_SIZE}px，最大 ${MAX_IMAGE_MAX_SIZE}px，单个输入/输出最多 10 MiB。
- run_command 和 apply_patch 每次调用都会重新查找目标目录及上级目录里的 AGENTS.md。
- load_skills 的目录是 ${SKILLS_ROOT}；技能目录增删后重启服务才能刷新 catalog。`

class HttpError extends Error {
	constructor(status, message) {
		super(message)
		this.status = status
	}
}

function digest(value) {
	return createHash("sha256").update(value).digest()
}

function jsonRpcError(status, code, message) {
	return {
		status,
		body: JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
	}
}

function send(res, status, body = "", headers = {}) {
	if (res.destroyed || res.writableEnded) return
	res.writeHead(status, headers)
	res.end(body)
}

function sendAndClose(res, status, body = "", headers = {}) {
	res.shouldKeepAlive = false
	send(res, status, body, { ...headers, Connection: "close" })
}

function logRejection(status, reason) {
	log(status >= 500 ? "error" : "warning", "http", "request_rejected", { status, reason })
}

function contentTypeIs(header, expected) {
	return String(header || "").split(";", 1)[0].trim().toLowerCase() === expected
}

function accepts(header, expected) {
	return String(header || "")
		.toLowerCase()
		.split(",")
		.some((entry) => {
			const [mediaType, ...parameters] = entry.split(";").map((part) => part.trim())
			if (mediaType !== expected) return false
			const quality = parameters.find((parameter) => /^q\s*=/.test(parameter))
			return quality === undefined || Number(quality.replace(/^q\s*=\s*/, "")) > 0
		})
}

function readBody(req, signal) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let bytes = 0
		let settled = false
		const cleanup = () => {
			req.off("data", onData)
			req.off("end", onEnd)
			req.off("aborted", onAborted)
			req.off("error", onError)
			signal.removeEventListener("abort", onAbort)
		}
		const finish = (error, body) => {
			if (settled) return
			settled = true
			cleanup()
			if (error) reject(error)
			else resolve(body)
		}
		const onData = (chunk) => {
			bytes += chunk.length
			if (bytes > MAX_BODY_BYTES) {
				req.pause()
				finish(new HttpError(413, "Request body too large"))
				return
			}
			chunks.push(chunk)
		}
		const onEnd = () => finish(null, Buffer.concat(chunks, bytes))
		const onAborted = () => finish(signal.reason || new Error("Request aborted"))
		const onError = (error) => finish(error)
		const onAbort = () => finish(signal.reason || new Error("Request cancelled"))
		req.on("data", onData)
		req.once("end", onEnd)
		req.once("aborted", onAborted)
		req.once("error", onError)
		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) onAbort()
	})
}

function createSdkServer(requestState) {
	// ponytail: SDK 1.29.0 的 low-level Server 可直接复用现有 JSON Schema；
	// 高层 McpServer 会要求无收益地把四套 schema 重写成 Zod。四个并发槽各
	// 复用一个 close 后的 Server，避免每个请求重复构造和注册同一组 handler。
	const mcp = new Server(
		{ name: "notionmcp", version: "1.1.0" },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
	)
	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
	mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const handler = handlers[request.params.name]
		if (!handler) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
		const signal = AbortSignal.any([extra.signal, requestState.controller.signal])
		try {
			return await handler(request.params.arguments || {}, { signal })
		} catch (error) {
			const cancelled = signal.aborted || error?.name === "AbortError"
			log(cancelled ? "warning" : "error", "tool", cancelled ? "cancelled" : "failed", {
				tool: request.params.name,
				error,
			})
			return {
				content: [{ type: "text", text: `Error: ${error?.message || error}` }],
				isError: true,
			}
		}
	})
	return mcp
}

export function createMcpHttpServer({ port, token }) {
	registerLogSecret(token)
	const expectedAuthorization = digest(`Bearer ${token}`)
	const active = new Set()
	const sdkPool = Array.from({ length: MAX_ACTIVE_REQUESTS }, () => {
		const state = { controller: null }
		return { state, mcp: createSdkServer(state) }
	})
	let shuttingDown = false
	let shutdownPromise = null
	let wasListening = false
	let resolveUnexpected
	const unexpected = new Promise((resolve) => {
		resolveUnexpected = resolve
	})

	const authorized = (header) => {
		const actual = digest(typeof header === "string" ? header : "")
		return timingSafeEqual(actual, expectedAuthorization)
	}

	const handleRequest = async (req, res) => {
		if (req.url !== "/mcp") {
			logRejection(404, "route_not_found")
			sendAndClose(res, 404, "Not Found")
			return
		}
		if (req.method !== "POST") {
			// ponytail: MCP Streamable HTTP 允许客户端发 GET 建立 SSE 推送流；这个 server 是一次性
			// POST-per-call 设计，不需要 server push，不支持 GET 完全符合协议——属于正常协商而不
			// 是异常，记 info 不占 warning 名额；真正意外的方法（PUT/DELETE 等）才算 warning。
			if (req.method === "GET") log("info", "http", "request_rejected", { status: 405, reason: "get_stream_not_supported" })
			else logRejection(405, "method_not_allowed")
			sendAndClose(res, 405, "Method Not Allowed", { Allow: "POST" })
			return
		}
		if (shuttingDown) {
			logRejection(503, "server_shutting_down")
			sendAndClose(res, 503, "Service Unavailable")
			return
		}
		if (!authorized(req.headers.authorization)) {
			logRejection(401, "unauthorized")
			sendAndClose(res, 401, "Unauthorized", {
				"WWW-Authenticate": "Bearer",
				"Cache-Control": "no-store",
			})
			return
		}
		if (active.size >= MAX_ACTIVE_REQUESTS) {
			logRejection(429, "too_many_requests")
			sendAndClose(res, 429, "Too Many Requests")
			return
		}

		const controller = new AbortController()
		const sdkSlot = sdkPool.pop()
		sdkSlot.state.controller = controller
		let resolveDone
		const context = {
			controller,
			sdkSlot,
			done: new Promise((resolve) => {
				resolveDone = resolve
			}),
		}
		active.add(context)
		const onRequestAborted = () => controller.abort(new Error("HTTP request aborted"))
		const onResponseClose = () => {
			if (!res.writableFinished) controller.abort(new Error("HTTP response closed"))
		}
		req.once("aborted", onRequestAborted)
		res.once("close", onResponseClose)
		const mcp = sdkSlot.mcp
		let transport
		let connected = false
		let reusable = true
		try {
			if (
				!accepts(req.headers.accept, "application/json") ||
				!accepts(req.headers.accept, "text/event-stream")
			) {
				const error = jsonRpcError(406, -32000, "Not Acceptable")
				logRejection(error.status, "not_acceptable")
				sendAndClose(res, error.status, error.body, { "Content-Type": "application/json" })
				return
			}
			if (!contentTypeIs(req.headers["content-type"], "application/json")) {
				const error = jsonRpcError(415, -32000, "Unsupported Media Type")
				logRejection(error.status, "unsupported_media_type")
				sendAndClose(res, error.status, error.body, { "Content-Type": "application/json" })
				return
			}
			const contentLength = req.headers["content-length"]
			if (typeof contentLength === "string" && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
				logRejection(413, "body_too_large")
				sendAndClose(res, 413, "Request body too large")
				return
			}
			const body = await readBody(req, controller.signal)
			let parsedBody
			try {
				parsedBody = JSON.parse(body.toString("utf8"))
			} catch {
				const error = jsonRpcError(400, ErrorCode.ParseError, "Parse error")
				logRejection(error.status, "invalid_json")
				send(res, error.status, error.body, { "Content-Type": "application/json" })
				return
			}
			// ponytail: 一个 HTTP slot 最多执行一个工具；拒绝 batch，避免再造 message-level semaphore。
			if (Array.isArray(parsedBody)) {
				const error = jsonRpcError(400, ErrorCode.InvalidRequest, "Invalid Request: batch is not supported")
				logRejection(error.status, "batch_not_supported")
				send(res, error.status, error.body, { "Content-Type": "application/json" })
				return
			}

			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			})
			await mcp.connect(transport)
			connected = true
			await transport.handleRequest(req, res, parsedBody)
		} catch (error) {
			if (error instanceof HttpError) {
				logRejection(error.status, "body_too_large")
				sendAndClose(res, error.status, error.message)
				return
			}
			if (controller.signal.aborted) {
				if (shuttingDown) {
					logRejection(503, "server_shutting_down")
					sendAndClose(res, 503, "Service Unavailable")
				}
				return
			}
			throw error
		} finally {
			try {
				if (connected) await mcp.close()
				else if (transport) await transport.close()
			} catch (error) {
				reusable = false
				log("error", "http", "sdk_close_failed", { error })
			}
			controller.abort(new Error("HTTP request finished"))
			sdkSlot.state.controller = null
			if (reusable) sdkPool.push(sdkSlot)
			else {
				const state = { controller: null }
				sdkPool.push({ state, mcp: createSdkServer(state) })
			}
			req.off("aborted", onRequestAborted)
			res.off("close", onResponseClose)
			active.delete(context)
			resolveDone()
		}
	}

	const httpServer = createServer((req, res) => {
		handleRequest(req, res).catch((error) => {
			log("error", "http", "request_failed", { error, status: 500 })
			if (!res.headersSent) sendAndClose(res, 500, "Internal Server Error")
			else if (!res.writableEnded) res.destroy()
		})
	})
	httpServer.headersTimeout = 10_000
	httpServer.requestTimeout = 15_000
	httpServer.maxConnections = 32
	httpServer.on("error", (error) => {
		if (!shuttingDown) {
			log("error", "http", "unexpected_error", { error })
			resolveUnexpected(error)
		}
	})
	httpServer.on("close", () => {
		if (wasListening && !shuttingDown) {
			const error = new Error("HTTP server closed unexpectedly")
			log("error", "http", "unexpected_close", { error })
			resolveUnexpected(error)
		}
	})

	const listen = () =>
		new Promise((resolve, reject) => {
			const onError = (error) => {
				httpServer.off("listening", onListening)
				reject(error)
			}
			const onListening = () => {
				httpServer.off("error", onError)
				wasListening = true
				const address = httpServer.address()
				log("info", "http", "started", { port: address.port })
				resolve(address)
			}
			httpServer.once("error", onError)
			httpServer.once("listening", onListening)
			httpServer.listen(port, HOST)
		})

	const shutdown = (reason = "requested") => {
		if (shutdownPromise) return shutdownPromise
		shuttingDown = true
		log("info", "http", "stopping", { reason })
		shutdownPromise = (async () => {
			const close = httpServer.listening
				? new Promise((resolve) => httpServer.close(() => resolve()))
				: Promise.resolve()
			const requests = [...active].map((context) => context.done)
			for (const context of active) context.controller.abort(new Error("Server shutting down"))
			await Promise.allSettled([close, ...requests])
			log("info", "http", "stopped", { reason })
		})()
		return shutdownPromise
	}

	return {
		httpServer,
		listen,
		shutdown,
		unexpected,
		get activeRequestCount() {
			return active.size
		},
	}
}
