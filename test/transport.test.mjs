import assert from "node:assert/strict"
import http from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"

const TOKEN = "0123456789abcdef".repeat(4)
const MODERN_PROTOCOL_VERSION = "2026-07-28"
const MODERN_TOOLS_LIST = {
	jsonrpc: "2.0",
	id: 2,
	method: "tools/list",
	params: {
		_meta: {
			"io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
			"io.modelcontextprotocol/clientInfo": { name: "notionmcp-test", version: "1.0.0" },
			"io.modelcontextprotocol/clientCapabilities": {},
		},
	},
}
const MODERN_LOAD_SKILL = {
	jsonrpc: "2.0",
	id: 3,
	method: "tools/call",
	params: {
		name: "load_skills",
		arguments: { name: "fixture-skill" },
		_meta: MODERN_TOOLS_LIST.params._meta,
	},
}

async function writeConfig(dir) {
	const config = join(dir, ".env")
	await writeFile(
		config,
		[
			"MCP_PORT=8000",
			`MCP_SANDBOX_DIR_MACOS=${dir}`,
			`MCP_SKILLS_DIR_MACOS=${dir}`,
			`MCP_SANDBOX_DIR_LINUX=${dir}`,
			`MCP_SKILLS_DIR_LINUX=${dir}`,
			`MCP_TOKEN_LINUX=${TOKEN}`,
			`MCP_SANDBOX_DIR_WINDOWS=${dir}`,
			`MCP_SKILLS_DIR_WINDOWS=${dir}`,
			`MCP_TOKEN_WINDOWS=${TOKEN}`,
		].join("\n"),
	)
	return config
}

function request(port, { path = "/mcp", method = "POST", headers = {}, body = "" } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ agent: false, host: "127.0.0.1", port, path, method, headers }, (res) => {
			const chunks = []
			res.on("data", (chunk) => chunks.push(chunk))
			res.once("end", () =>
				resolve({
					status: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				}),
			)
		})
		req.once("error", reject)
		req.end(body)
	})
}

function openSse(port, path = "/mcp/sse") {
	return new Promise((resolve, reject) => {
		const messages = []
		let buffer = ""
		const req = http.request({
			host: "127.0.0.1",
			port,
			path,
			method: "GET",
			headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
		})
		req.once("error", reject)
		req.once("response", (res) => {
			if (res.statusCode !== 200) {
				reject(new Error(`SSE status ${res.statusCode}`))
				res.resume()
				return
			}
			res.setEncoding("utf8")
			res.on("data", (chunk) => {
				buffer += chunk
				let boundary
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					const frame = buffer.slice(0, boundary)
					buffer = buffer.slice(boundary + 2)
					const event = frame.match(/^event: (.+)$/m)?.[1]
					const data = frame.match(/^data: (.+)$/m)?.[1]
					if (event === "endpoint" && data) resolve({ endpoint: data, messages, close: () => { req.destroy(); res.destroy() } })
					if (event === "message" && data) messages.push(JSON.parse(data))
				}
			})
			res.once("error", reject)
		})
		req.end()
	})
}

function openStreamableSse(port) {
	return new Promise((resolve, reject) => {
		let buffer = ""
		const req = http.request({
			host: "127.0.0.1",
			port,
			path: "/mcp",
			method: "GET",
			headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream", "Mcp-Protocol-Version": MODERN_PROTOCOL_VERSION },
		})
		req.once("error", reject)
		req.once("response", (res) => {
			if (res.statusCode !== 200) {
				reject(new Error(`SSE status ${res.statusCode}`))
				res.resume()
				return
			}
			res.setEncoding("utf8")
			res.on("data", (chunk) => {
				buffer += chunk
				if (buffer.includes(": connected\n\n")) resolve({ headers: res.headers, close: () => { req.destroy(); res.destroy() } })
			})
			res.once("error", reject)
		})
		req.end()
	})
}

function modernRequest(port, message, headers = {}) {
	return request(port, {
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Mcp-Protocol-Version": MODERN_PROTOCOL_VERSION,
			"Mcp-Method": message.method,
			...headers,
		},
		body: JSON.stringify(message),
	})
}

function nodeCommand(...args) {
	return args.map((arg) => JSON.stringify(String(arg))).join(" ")
}

async function waitFor(predicate, description) {
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(description)
}

let fixture

async function getFixture() {
	if (fixture) return fixture
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-transport-"))
	const config = await writeConfig(dir)
	const skillDir = join(dir, "fixture-skill")
	await mkdir(skillDir)
	await writeFile(join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: test skill\n---\n")
	const previous = { config: process.env.MCP_CONFIG_FILE, log: process.env.MCP_LOG_FILE }
	const logFile = join(dir, "mcp.log")
	process.env.MCP_CONFIG_FILE = config
	process.env.MCP_LOG_FILE = logFile
	const module = await import(`../lib/mcp-http.mjs?transport=${Date.now()}`)
	fixture = { dir, logFile, module, previous }
	return fixture
}

after(async () => {
	if (!fixture) return
	await rm(fixture.dir, { recursive: true, force: true })
	if (fixture.previous.config === undefined) delete process.env.MCP_CONFIG_FILE
	else process.env.MCP_CONFIG_FILE = fixture.previous.config
	if (fixture.previous.log === undefined) delete process.env.MCP_LOG_FILE
	else process.env.MCP_LOG_FILE = fixture.previous.log
})

test("现代 Streamable HTTP 探测、取消和后续请求互相隔离", async (t) => {
	const { module, logFile } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()

	const initial = await modernRequest(port, MODERN_TOOLS_LIST)
	assert.equal(initial.status, 200)
	const listedTools = JSON.parse(initial.body).result.tools
	assert.equal(listedTools.length, 6)
	assert.deepEqual(
		listedTools.map(({ name, title }) => ({ name, title })),
		[
			{ name: "run_command", title: "Run Command" },
			{ name: "read_image", title: "Read Image" },
			{ name: "apply_patch", title: "Edit Files" },
			{ name: "load_skills", title: "Load Skills" },
			{ name: "read_file", title: "Read Text File" },
			{ name: "read_rules", title: "Read Rules" },
		],
	)
	assert.equal(initial.headers["mcp-session-id"], undefined)
	const legacyInitialize = await request(port, {
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "notion-legacy", version: "1.0" } },
		}),
	})
	assert.equal(legacyInitialize.status, 200)
	assert.match(legacyInitialize.headers["content-type"], /^text\/event-stream/)
	assert.match(legacyInitialize.body, /"serverInfo":\{"name":"notionmcp"/)
	const legacyToolsList = await request(port, {
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Mcp-Protocol-Version": "2025-03-26",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
	})
	assert.equal(legacyToolsList.status, 200)
	assert.match(legacyToolsList.body, /"name":"read_rules"/)

	const wrongMethod = await request(port, { method: "PUT" })
	assert.equal(wrongMethod.status, 405)
	assert.equal(wrongMethod.headers.allow, "POST")
	assert.equal(lifecycle.activeRequestCount, 0)
	assert.equal((await request(port, { path: "/not-mcp" })).status, 404)

	const partial = http.request({
		host: "127.0.0.1",
		port,
		path: "/mcp",
		method: "POST",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Content-Length": "10",
		},
	})
	partial.on("error", () => {})
	partial.flushHeaders()
	await waitFor(() => lifecycle.activeRequestCount === 1, "partial request did not occupy a slot")
	partial.destroy()
	await waitFor(() => lifecycle.activeRequestCount === 0, "cancelled request did not release its slot")
	assert.equal((await modernRequest(port, MODERN_TOOLS_LIST)).status, 200)

	const bodyMarker = "REQUEST_BODY_MUST_NOT_BE_LOGGED"
	assert.equal((await modernRequest(port, { ...MODERN_TOOLS_LIST, marker: bodyMarker }, { Authorization: "Bearer wrong" })).status, 401)
	const log = await readFile(logFile, "utf8")
	assert.doesNotMatch(log, new RegExp(TOKEN))
	assert.doesNotMatch(log, new RegExp(bodyMarker))
})

test("2026 Streamable HTTP 校验元数据和头部一致性", async (t) => {
	const { module } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()

	const current = await modernRequest(port, MODERN_TOOLS_LIST)
	assert.equal(current.status, 200)
	assert.match(current.headers["content-type"], /^application\/json/)
	assert.equal(JSON.parse(current.body).result.tools.length, 6)
	const called = await modernRequest(port, MODERN_LOAD_SKILL, { "Mcp-Name": "load_skills" })
	assert.equal(called.status, 200)
	assert.match(JSON.parse(called.body).result.content[0].text, /fixture-skill/)

	const mismatchedMethod = await modernRequest(port, MODERN_TOOLS_LIST, { "Mcp-Method": "tools/call" })
	assert.equal(mismatchedMethod.status, 400)
	assert.equal(JSON.parse(mismatchedMethod.body).error.code, -32020)
	const mismatchedName = await modernRequest(port, MODERN_LOAD_SKILL, { "Mcp-Name": "run_command" })
	assert.equal(mismatchedName.status, 400)
	assert.equal(JSON.parse(mismatchedName.body).error.code, -32020)

	const unsupportedVersion = await modernRequest(
		port,
		{
			...MODERN_TOOLS_LIST,
			params: {
				...MODERN_TOOLS_LIST.params,
				_meta: { ...MODERN_TOOLS_LIST.params._meta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
			},
		},
		{ "Mcp-Protocol-Version": "2099-01-01" },
	)
	assert.equal(unsupportedVersion.status, 400)
	assert.equal(typeof JSON.parse(unsupportedVersion.body).error.code, "number")

	const invalidOrigin = await modernRequest(port, MODERN_TOOLS_LIST, { Origin: "https://attacker.example" })
	assert.equal(invalidOrigin.status, 403)
})

test("2025 Streamable HTTP GET 保持轻量通知流，不创建旧 SSE 会话", async (t) => {
	const { module, logFile } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()

	assert.equal(
		(await request(port, { path: "/mcp", method: "GET", headers: { Accept: "text/event-stream" } })).status,
		401,
	)
	const sse = await openStreamableSse(port)
	t.after(sse.close)
	assert.match(sse.headers["content-type"], /^text\/event-stream/)
	assert.equal(lifecycle.legacySseCount, 0)
	assert.equal(lifecycle.streamableSseCount, 1)
	const health = JSON.parse((await request(port, { path: "/healthz", method: "GET" })).body)
	assert.deepEqual(health.connections, { open: health.connections.open, legacySse: 0, streamableSse: 1, totalSse: 1 })
	assert.equal((await modernRequest(port, MODERN_TOOLS_LIST)).status, 200)
	const records = (await readFile(logFile, "utf8")).trimEnd().split("\n").map(JSON.parse)
	const opened = records.findLast((record) => record.transport === "streamable_sse" && record.event === "sse_opened")
	assert.equal(opened.streamableSseSessions, 1)
	sse.close()
	await waitFor(() => lifecycle.streamableSseCount === 0, "closed Streamable SSE did not leave the manager")
})

test("旧 HTTP+SSE 使用显式 /mcp/sse 会话入口并调用工具", async (t) => {
	const { module, logFile } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()

	assert.equal(
		(await request(port, { path: "/mcp", method: "GET", headers: { Accept: "text/event-stream" } })).status,
		401,
	)
	const sse = await openSse(port)
	t.after(sse.close)
	assert.match(sse.endpoint, /^\/mcp\/messages\?sessionId=/)
	const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }
	const initialize = await request(port, {
		path: sse.endpoint,
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "notion-sse", version: "1.0" } },
		}),
	})
	assert.equal(initialize.status, 202)
	await waitFor(() => sse.messages.some((message) => message.id === 1), "SSE initialize response did not arrive")
	assert.equal(sse.messages.find((message) => message.id === 1).result.serverInfo.name, "notionmcp")
	assert.equal(
		(
			await request(port, {
				path: sse.endpoint,
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
			})
		).status,
		202,
	)
	assert.equal(
		(
			await request(port, {
				path: sse.endpoint,
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
			})
		).status,
		202,
	)
	await waitFor(() => sse.messages.some((message) => message.id === 2), "SSE tools/list response did not arrive")
	assert.equal(sse.messages.find((message) => message.id === 2).result.tools.length, 6)
	const health = JSON.parse((await request(port, { path: "/healthz", method: "GET" })).body)
	assert.equal(health.connections.legacySse, 1)
	const log = await readFile(logFile, "utf8")
	const records = log.trimEnd().split("\n").map(JSON.parse)
	const opened = records.filter((record) => record.event === "sse_opened").at(-1)
	const completed = records.filter((record) => record.transport === "legacy_sse_message" && record.event === "completed").at(-1)
	assert.equal(opened.transport, "legacy_sse")
	assert.equal(opened.legacySseSessions, 1)
	assert.equal(completed.sseSession, opened.sseSession)
	assert.equal(completed.messageCount, 3)
	const sessionId = new URL(sse.endpoint, "http://localhost").searchParams.get("sessionId")
	assert.doesNotMatch(log, new RegExp(sessionId))
	assert.equal(
		(await request(port, { path: "/mcp/messages?sessionId=missing", headers, body: JSON.stringify({}) })).status,
		404,
	)
	sse.close()
	await waitFor(() => lifecycle.legacySseCount === 0, "closed SSE session did not leave the manager")
	assert.equal(JSON.parse((await request(port, { path: "/healthz", method: "GET" })).body).connections.legacySse, 0)
})

test("旧 HTTP+SSE 保留 Notion 打开的全部会话", async (t) => {
	const { module } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()
	const sessions = []
	t.after(() => sessions.forEach((session) => session.close()))
	for (let index = 0; index < 64; index += 1) sessions.push(await openSse(port))

	const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }
	assert.equal(
		(
			await request(port, {
				path: sessions[0].endpoint,
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			})
		).status,
		202,
	)
	assert.equal(
		(
			await request(port, {
				path: sessions.at(-1).endpoint,
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
			})
		).status,
		202,
	)
})

test("同一旧 SSE 会话的并发工具调用进入共享 FIFO", async (t) => {
	const { module, dir } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()
	const sse = await openSse(port)
	t.after(sse.close)
	const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }
	assert.equal(
		(
			await request(port, {
				path: sse.endpoint,
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "notion-sse", version: "1.0" } },
				}),
			})
		).status,
		202,
	)
	await waitFor(() => sse.messages.some((message) => message.id === 1), "SSE initialize response did not arrive")
	const helper = join(dir, "legacy-delay.cjs")
	await writeFile(helper, `setTimeout(()=>process.stdout.write("done"),100)\n`)
	const calls = [2, 3].map((id) =>
		request(port, {
			path: sse.endpoint,
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: { name: "run_command", arguments: { command: nodeCommand(process.execPath, helper) } },
			}),
		}),
	)
	assert.ok((await Promise.all(calls)).every((response) => response.status === 202))
	await waitFor(() => [2, 3].every((id) => sse.messages.some((message) => message.id === id)), "concurrent SSE responses did not arrive")
	for (const id of [2, 3]) assert.notEqual(sse.messages.find((message) => message.id === id).result.isError, true)
})

test("SSE 总容量只拒绝新流，不关闭既有 Streamable 或旧 SSE 连接", async (t) => {
	const { module } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()
	const sessions = []
	for (let index = 0; index < 255; index += 1) sessions.push(await openStreamableSse(port))
	t.after(() => sessions.forEach((session) => session.close()))
	const legacy = await openSse(port)
	t.after(legacy.close)
	assert.equal(lifecycle.streamableSseCount, 255)
	assert.equal(lifecycle.legacySseCount, 1)
	const denied = await request(port, {
		path: "/mcp",
		method: "GET",
		headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
	})
	assert.equal(denied.status, 503)
	assert.equal(denied.headers["retry-after"], "1")
	const health = JSON.parse((await request(port, { path: "/healthz", method: "GET" })).body)
	assert.equal(health.connections.streamableSse, 255)
	assert.equal(health.connections.legacySse, 1)
	assert.equal(health.sseHighWater, 256)
	assert.equal((await modernRequest(port, MODERN_TOOLS_LIST)).status, 200)
})

test("持有 SSE 时两轮十二条命令跨过并发阈值后恢复", async (t) => {
	const { module, dir } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()
	const streams = []
	for (let index = 0; index < 32; index += 1) streams.push(await openStreamableSse(port))
	t.after(() => streams.forEach((stream) => stream.close()))
	const helper = join(dir, "concurrency-delay.cjs")
	await writeFile(helper, `setTimeout(()=>process.stdout.write(process.argv[2]),300)\n`)
	const command = (id) =>
		modernRequest(
			port,
			{
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: {
					name: "run_command",
					arguments: { command: nodeCommand(process.execPath, helper, id) },
					_meta: MODERN_TOOLS_LIST.params._meta,
				},
			},
			{ "Mcp-Name": "run_command" },
		)
	for (const start of [100, 200]) {
		const batch = Array.from({ length: 12 }, (_, index) => command(start + index))
		await waitFor(
			() => lifecycle.activeRequestCount === 10 && lifecycle.queuedRequestCount === 2,
			"twelve commands did not cross the shared execution limit",
		)
		assert.ok((await Promise.all(batch)).every((response) => response.status === 200))
		const health = JSON.parse((await request(port, { path: "/healthz", method: "GET" })).body)
		assert.equal(health.activeRequests, 0)
		assert.equal(health.queuedRequests, 0)
		assert.equal(health.connections.streamableSse, 32)
	}
	streams.forEach((stream) => stream.close())
	await waitFor(
		() => lifecycle.streamableSseCount === 0 && lifecycle.activeRequestCount === 0 && lifecycle.queuedRequestCount === 0 && lifecycle.connectionCount === 0,
		"combined stress test leaked an SSE stream, request, or socket",
	)
})

test("旧 SSE message 与现代 POST 共享 FIFO 背压", async (t) => {
	const { module, dir } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()
	const sse = await openSse(port)
	t.after(sse.close)
	const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }
	assert.equal(
		(
			await request(port, {
				path: sse.endpoint,
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "notion-sse", version: "1.0" } },
				}),
			})
		).status,
		202,
	)
	await waitFor(() => sse.messages.some((message) => message.id === 1), "SSE initialize response did not arrive")
	assert.equal(
		(
			await request(port, {
				path: sse.endpoint,
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
			})
		).status,
		202,
	)

	const helper = join(dir, "queue-delay.cjs")
	await writeFile(helper, `setTimeout(()=>process.stdout.write("done"),500)\n`)
	const active = Array.from({ length: 10 }, (_, index) =>
		modernRequest(
			port,
			{
				jsonrpc: "2.0",
				id: index + 10,
				method: "tools/call",
				params: {
					name: "run_command",
					arguments: { command: nodeCommand(process.execPath, helper) },
					_meta: MODERN_TOOLS_LIST.params._meta,
				},
			},
			{ "Mcp-Name": "run_command" },
		),
	)
	await waitFor(() => lifecycle.activeRequestCount === 10, "modern requests did not fill execution slots")
	const legacy = request(port, {
		path: sse.endpoint,
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
	})
	await waitFor(() => lifecycle.queuedRequestCount === 1, "legacy message did not enter the shared queue")
	assert.equal(JSON.parse((await request(port, { path: "/healthz", method: "GET" })).body).queuedRequests, 1)
	assert.ok((await Promise.all(active)).every((response) => response.status === 200))
	assert.equal((await legacy).status, 202)
	await waitFor(() => sse.messages.some((message) => message.id === 2), "queued SSE tools/list response did not arrive")
	assert.equal(lifecycle.queuedRequestCount, 0)
})
