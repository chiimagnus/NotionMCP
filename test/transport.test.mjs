import assert from "node:assert/strict"
import http from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"

const TOKEN = "0123456789abcdef".repeat(4)
const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
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
		const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
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

function legacyRequest(port, message, authorization = `Bearer ${TOKEN}`) {
	return request(port, {
		headers: {
			Authorization: authorization,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Mcp-Protocol-Version": "2025-03-26",
		},
		body: JSON.stringify(message),
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

test("旧版 Streamable HTTP 探测、取消和后续请求互相隔离", async (t) => {
	const { module, logFile } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()

	const initial = await legacyRequest(port, TOOLS_LIST)
	assert.equal(initial.status, 200)
	assert.equal(JSON.parse(initial.body).result.tools.length, 5)
	assert.equal(initial.headers["mcp-session-id"], undefined)

	const getProbe = await request(port, { method: "GET" })
	assert.equal(getProbe.status, 405)
	assert.equal(getProbe.headers.allow, "POST")
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
	assert.equal((await legacyRequest(port, TOOLS_LIST)).status, 200)

	const bodyMarker = "REQUEST_BODY_MUST_NOT_BE_LOGGED"
	assert.equal((await legacyRequest(port, { marker: bodyMarker }, "Bearer wrong")).status, 401)
	const log = await readFile(logFile, "utf8")
	assert.doesNotMatch(log, new RegExp(TOKEN))
	assert.doesNotMatch(log, new RegExp(bodyMarker))
})

test("2026 Streamable HTTP 校验元数据且不破坏旧版 JSON 响应", async (t) => {
	const { module } = await getFixture()
	const lifecycle = module.createMcpHttpServer({ port: 0, token: TOKEN })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()

	const current = await modernRequest(port, MODERN_TOOLS_LIST)
	assert.equal(current.status, 200)
	assert.match(current.headers["content-type"], /^application\/json/)
	assert.equal(JSON.parse(current.body).result.tools.length, 5)
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
