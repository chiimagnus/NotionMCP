import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"

import { createHealthSnapshot, HEALTH_PATH } from "./health.mjs"

import { LEGACY_MESSAGES_PATH, LEGACY_SSE_PATH, createLegacySseManager } from "./legacy-sse.mjs"
import { log, registerLogSecret } from "./log.mjs"
import { createProtocolHandler, SERVER_VERSION } from "./mcp-protocol.mjs"

const HOST = "127.0.0.1"
const MAX_BODY_BYTES = 1024 * 1024
const MAX_ACTIVE_REQUESTS = 10
const requestTrace = new AsyncLocalStorage()

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

function logRejection(status, reason, trace) {
	trace(status >= 500 ? "error" : "warning", "rejected", { status, reason })
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

function singleHeader(value) {
	return Array.isArray(value) ? value[0] : value
}

function isAllowedOrigin(req) {
	const value = singleHeader(req.headers.origin)
	if (!value) return true
	try {
		return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname)
	} catch {
		return false
	}
}

function isDirectLoopbackRequest(req) {
	const address = req.socket.remoteAddress
	return (
		["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) &&
		!req.headers["x-forwarded-for"] &&
		!req.headers["x-real-ip"]
	)
}

function requestUrl(req) {
	try {
		return new URL(req.url || "/", "http://localhost")
	} catch {
		return null
	}
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
		const onAborted = () => finish(signal.reason || new Error("HTTP request aborted"))
		const onError = (error) => finish(error)
		const onAbort = () => finish(signal.reason || new Error("HTTP request cancelled"))
		req.on("data", onData)
		req.once("end", onEnd)
		req.once("aborted", onAborted)
		req.once("error", onError)
		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) onAbort()
	})
}

function toWebRequest(req, parsedBody, signal) {
	const method = (req.method || "GET").toUpperCase()
	const headers = new Headers()
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined || name.startsWith(":")) continue
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry)
		} else {
			headers.set(name, value)
		}
	}
	let body
	if (method !== "GET" && method !== "HEAD") {
		body = JSON.stringify(parsedBody)
		headers.delete("content-encoding")
		headers.delete("transfer-encoding")
		headers.set("content-length", String(Buffer.byteLength(body)))
	}
	const host = singleHeader(req.headers.host) || "localhost"
	return new Request(`http://${host}${req.url || "/"}`, { method, headers, body, signal })
}

async function sendProtocolResponse(res, response) {
	if (res.destroyed || res.writableEnded) return
	const headers = Object.fromEntries(response.headers)
	res.writeHead(response.status, headers)
	if (response.body === null) {
		res.end()
		return
	}
	res.end(Buffer.from(await response.arrayBuffer()))
}

export function createMcpHttpServer({ port, token }) {
	registerLogSecret(token)
	const expectedAuthorization = digest(`Bearer ${token}`)
	const active = new Set()
	let shuttingDown = false
	let shutdownPromise = null
	let wasListening = false
	let resolveUnexpected
	const unexpected = new Promise((resolve) => {
		resolveUnexpected = resolve
	})
	const protocol = createProtocolHandler((error) => {
		const trace = requestTrace.getStore()
		log("warning", "protocol", "rejected", {
			error,
			traceId: trace?.traceId,
			elapsedMs: trace && Date.now() - trace.startedAt,
		})
	})
	const legacySse = createLegacySseManager({ onerror: (error) => log("warning", "legacySse", "failed", { error }) })
	const healthSnapshot = createHealthSnapshot({
		version: SERVER_VERSION,
		maxActiveRequests: MAX_ACTIVE_REQUESTS,
		activeRequestCount: () => active.size,
		isShuttingDown: () => shuttingDown,
	})

	const authorized = (header) => {
		const actual = digest(typeof header === "string" ? header : "")
		return timingSafeEqual(actual, expectedAuthorization)
	}

	const rejectRestrictedRequest = (req, res, trace) => {
		if (!isAllowedOrigin(req)) {
			logRejection(403, "origin_not_allowed", trace)
			sendAndClose(res, 403, "Forbidden")
			return true
		}
		if (shuttingDown) {
			logRejection(503, "server_shutting_down", trace)
			sendAndClose(res, 503, "Service Unavailable")
			return true
		}
		if (!authorized(req.headers.authorization)) {
			logRejection(401, "unauthorized", trace)
			sendAndClose(res, 401, "Unauthorized", {
				"WWW-Authenticate": "Bearer",
				"Cache-Control": "no-store",
			})
			return true
		}
		return false
	}

	const handleLegacyMessage = async (req, res, url, trace) => {
		const sessionId = url.searchParams.get("sessionId")
		if (!sessionId || sessionId.length > 128 || !legacySse.hasSession(sessionId)) {
			logRejection(404, "sse_session_not_found", trace)
			sendAndClose(res, 404, "Session Not Found")
			return
		}
		if (!contentTypeIs(req.headers["content-type"], "application/json")) {
			logRejection(415, "unsupported_media_type", trace)
			sendAndClose(res, 415, "Unsupported Media Type")
			return
		}
		const contentLength = req.headers["content-length"]
		if (typeof contentLength === "string" && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
			logRejection(413, "body_too_large", trace)
			sendAndClose(res, 413, "Request body too large")
			return
		}
		if (active.size >= MAX_ACTIVE_REQUESTS) {
			logRejection(429, "too_many_requests", trace)
			sendAndClose(res, 429, "Too Many Requests")
			return
		}

		const controller = new AbortController()
		let resolveDone
		const context = {
			controller,
			done: new Promise((resolve) => {
				resolveDone = resolve
			}),
		}
		active.add(context)
		const onRequestAborted = () => controller.abort(new Error("HTTP request aborted"))
		req.once("aborted", onRequestAborted)
		try {
			const body = await readBody(req, controller.signal)
			let parsedBody
			try {
				parsedBody = JSON.parse(body.toString("utf8"))
			} catch {
				logRejection(400, "invalid_json", trace)
				sendAndClose(res, 400, "Invalid JSON")
				return
			}
			if (!(await legacySse.handleMessage(req, res, sessionId, parsedBody))) {
				logRejection(404, "sse_session_not_found", trace)
				sendAndClose(res, 404, "Session Not Found")
				return
			}
			trace("info", "completed", { status: res.statusCode || 202 })
		} catch (error) {
			if (error instanceof HttpError) {
				logRejection(error.status, "body_too_large", trace)
				sendAndClose(res, error.status, error.message)
				return
			}
			if (controller.signal.aborted) {
				trace("info", "cancelled", { signal: "http" })
				return
			}
			trace("error", "failed", { error, status: 500 })
			throw error
		} finally {
			controller.abort(new Error("HTTP request finished"))
			req.off("aborted", onRequestAborted)
			active.delete(context)
			resolveDone()
		}
	}

	const handleRequest = async (req, res) => {
		const traceId = randomUUID()
		const startedAt = Date.now()
		const trace = (level, event, fields = {}) =>
			log(level, "http", event, { traceId, elapsedMs: Date.now() - startedAt, ...fields })
		res.setHeader("X-Request-Id", traceId)
		const url = requestUrl(req)
		if (!url) {
			logRejection(400, "invalid_url", trace)
			sendAndClose(res, 400, "Bad Request")
			return
		}
		const path = url.pathname
		const method = (req.method || "GET").toUpperCase()
		trace("info", "received", { method, path })
		if (path === HEALTH_PATH) {
			if (req.method !== "GET" || !isDirectLoopbackRequest(req)) {
				logRejection(403, "health_not_local", trace)
				sendAndClose(res, 403, "Forbidden")
				return
			}
			const snapshot = healthSnapshot()
			send(res, 200, JSON.stringify(snapshot), { "Cache-Control": "no-store", "Content-Type": "application/json" })
			trace("info", "completed", { status: 200 })
			return
		}
		// 2024 clients use the configured server URL as their SSE endpoint. Keep
		// /mcp/sse as an explicit alias, but make the documented /mcp URL work too.
		if (path === LEGACY_SSE_PATH || (path === "/mcp" && method === "GET")) {
			if (method !== "GET") {
				logRejection(405, "method_not_allowed", trace)
				sendAndClose(res, 405, "Method Not Allowed", { Allow: "GET" })
				return
			}
			if (rejectRestrictedRequest(req, res, trace)) return
			if (!accepts(req.headers.accept, "text/event-stream")) {
				logRejection(406, "not_acceptable", trace)
				sendAndClose(res, 406, "Not Acceptable")
				return
			}
			await legacySse.open(res, () => trace("info", "sse_closed", { count: legacySse.size }))
			trace("info", "sse_opened", { count: legacySse.size })
			return
		}
		if (path === LEGACY_MESSAGES_PATH) {
			if (method !== "POST") {
				logRejection(405, "method_not_allowed", trace)
				sendAndClose(res, 405, "Method Not Allowed", { Allow: "POST" })
				return
			}
			if (rejectRestrictedRequest(req, res, trace)) return
			await handleLegacyMessage(req, res, url, trace)
			return
		}
		if (path !== "/mcp") {
			logRejection(404, "route_not_found", trace)
			sendAndClose(res, 404, "Not Found")
			return
		}
		if (method !== "POST") {
			if (method === "GET") trace("info", "rejected", { status: 405, reason: "get_stream_not_supported" })
			else logRejection(405, "method_not_allowed", trace)
			sendAndClose(res, 405, "Method Not Allowed", { Allow: "POST" })
			return
		}
		if (rejectRestrictedRequest(req, res, trace)) return
		if (active.size >= MAX_ACTIVE_REQUESTS) {
			logRejection(429, "too_many_requests", trace)
			sendAndClose(res, 429, "Too Many Requests")
			return
		}

		const controller = new AbortController()
		let resolveDone
		const context = {
			controller,
			done: new Promise((resolve) => {
				resolveDone = resolve
			}),
		}
		active.add(context)
		trace("info", "authenticated")
		trace("info", "queued", { count: active.size })
		const onRequestAborted = () => controller.abort(new Error("HTTP request aborted"))
		const onResponseClose = () => {
			if (!res.writableFinished) controller.abort(new Error("HTTP response closed"))
		}
		req.once("aborted", onRequestAborted)
		res.once("close", onResponseClose)
		try {
			if (!accepts(req.headers.accept, "application/json") || !accepts(req.headers.accept, "text/event-stream")) {
				const error = jsonRpcError(406, -32000, "Not Acceptable")
				logRejection(error.status, "not_acceptable", trace)
				sendAndClose(res, error.status, error.body, { "Content-Type": "application/json" })
				return
			}
			if (!contentTypeIs(req.headers["content-type"], "application/json")) {
				const error = jsonRpcError(415, -32000, "Unsupported Media Type")
				logRejection(error.status, "unsupported_media_type", trace)
				sendAndClose(res, error.status, error.body, { "Content-Type": "application/json" })
				return
			}
			const contentLength = req.headers["content-length"]
			if (typeof contentLength === "string" && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
				logRejection(413, "body_too_large", trace)
				sendAndClose(res, 413, "Request body too large")
				return
			}
			const body = await readBody(req, controller.signal)
			let parsedBody
			try {
				parsedBody = JSON.parse(body.toString("utf8"))
			} catch {
				const error = jsonRpcError(400, -32700, "Parse error")
				logRejection(error.status, "invalid_json", trace)
				send(res, error.status, error.body, { "Content-Type": "application/json" })
				return
			}
			if (Array.isArray(parsedBody)) {
				const error = jsonRpcError(400, -32600, "Invalid Request: batch is not supported")
				logRejection(error.status, "batch_not_supported", trace)
				send(res, error.status, error.body, { "Content-Type": "application/json" })
				return
			}
			trace("info", "started")
			await requestTrace.run({ traceId, startedAt }, async () => {
				const webRequest = toWebRequest(req, parsedBody, controller.signal)
				const response = await protocol.fetch(webRequest)
				await sendProtocolResponse(res, response)
			})
			if (controller.signal.aborted) {
				trace("info", "cancelled", { signal: "http" })
				return
			}
			trace("info", "completed", { status: res.statusCode || 200 })
		} catch (error) {
			if (error instanceof HttpError) {
				logRejection(error.status, "body_too_large", trace)
				sendAndClose(res, error.status, error.message)
				return
			}
			if (controller.signal.aborted) {
				trace("info", "cancelled", { signal: "http" })
				if (shuttingDown) {
					logRejection(503, "server_shutting_down", trace)
					sendAndClose(res, 503, "Service Unavailable")
				}
				return
			}
			trace("error", "failed", { error, status: 500 })
			throw error
		} finally {
			controller.abort(new Error("HTTP request finished"))
			req.off("aborted", onRequestAborted)
			res.off("close", onResponseClose)
			active.delete(context)
			resolveDone()
		}
	}

	const httpServer = createServer((req, res) => {
		handleRequest(req, res).catch((error) => {
			if (!res.headersSent) sendAndClose(res, 500, "Internal Server Error")
			else if (!res.writableEnded) res.destroy()
		})
	})
		httpServer.headersTimeout = 10_000
		httpServer.requestTimeout = 15_000
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
			await legacySse.close()
			httpServer.closeIdleConnections?.()
			await Promise.allSettled([close, protocol.close(), ...requests])
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
