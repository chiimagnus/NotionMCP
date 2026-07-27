import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const TOKEN = "0123456789abcdef".repeat(4)
const WARMUP_REQUESTS = 500
const MEASURED_REQUESTS = 1_000
const MAX_HEAP_DELTA = 16 * 1024 * 1024
const MAX_RSS_DELTA = 64 * 1024 * 1024

function quoted(value) {
	if (process.platform === "win32") return `'${value.replaceAll("'", "''")}'`
	return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function nodeCommand(script, ...args) {
	const command = [process.execPath, script, ...args].map(quoted).join(" ")
	if (process.platform === "win32") return `& ${command}`
	// ponytail: 保留 /bin/sh 进程，避免它把末尾唯一命令 exec 后让 helper 误报 runner PID。
	return `${command}; exit $?`
}

function projectNodeProcessCount() {
	if (process.platform === "win32") {
		const root = ROOT.replaceAll("'", "''")
		const output = execFileSync(
			"pwsh.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${root}') }).Count`,
			],
			{ encoding: "utf8" },
		)
		const count = Number(output.trim())
		if (!Number.isSafeInteger(count) || count < 0) throw new Error("无法解析 Windows 项目进程数")
		return count
	}
	const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
	return output
		.split("\n")
		.filter((line) => {
			const [pid] = line.trim().split(/\s+/, 1)
			return Number(pid) !== process.pid && line.includes(ROOT) && /\bnode\b/.test(line)
		})
		.length
}

function request(port, agent, message) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: "/mcp",
				method: "POST",
				agent,
				headers: {
					Authorization: `Bearer ${TOKEN}`,
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
					"Mcp-Protocol-Version": "2025-03-26",
				},
			},
			(res) => {
				res.resume()
				res.once("end", () => {
					try {
						assert.equal(res.statusCode, 200)
						assert.equal(res.headers["mcp-session-id"], undefined)
						resolve()
					} catch (error) {
						reject(error)
					}
				})
			},
		)
		req.once("error", reject)
		req.end(JSON.stringify(message))
	})
}

function openToolRequest(port, agent, message) {
	let req
	const response = new Promise((resolve, reject) => {
		req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: "/mcp",
				method: "POST",
				agent,
				headers: {
					Authorization: `Bearer ${TOKEN}`,
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
					"Mcp-Protocol-Version": "2025-03-26",
				},
			},
			(res) => {
				res.resume()
				res.once("end", () => resolve(res.statusCode))
			},
		)
		req.once("error", reject)
		req.end(JSON.stringify(message))
	})
	return { req, response }
}

function headersOnlyRequest(port, agent, contentLength) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: "/mcp",
				method: "POST",
				agent,
				headers: {
					Authorization: `Bearer ${TOKEN}`,
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
					"Content-Length": String(contentLength),
				},
			},
			(res) => {
				res.resume()
				res.once("end", () => resolve(res.statusCode))
			},
		)
		req.once("error", reject)
		req.flushHeaders()
	})
}

async function stableMemory() {
	for (let i = 0; i < 3; i += 1) {
		await global.gc({ type: "major", execution: "async" })
		await new Promise((resolve) => setImmediate(resolve))
	}
	return process.memoryUsage()
}

async function waitForPid(file, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = Number(await readFile(file, "utf8").catch(() => ""))
		if (Number.isInteger(value) && value > 0) return value
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("等待测试进程 PID 超时")
}

async function waitForCondition(predicate, message, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(message)
}

function processAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function waitForDead(pids, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (pids.every((pid) => !processAlive(pid))) return
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	assert.fail(`取消后仍有测试进程存活：${pids.filter(processAlive).join(",")}`)
}

async function bindAndClose(port) {
	const server = http.createServer()
	await new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, "127.0.0.1", resolve)
	})
	await new Promise((resolve) => server.close(resolve))
}

if (typeof global.gc !== "function") throw new Error("soak 必须通过 node --expose-gc 运行")

const temp = await mkdtemp(join(tmpdir(), "notionmcp-soak-"))
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 })
const openRequests = []
let lifecycle
let port
let summary
let failure
const previousConfig = process.env.MCP_CONFIG_FILE
const previousLog = process.env.MCP_LOG_FILE

try {
	const sandbox = join(temp, "sandbox")
	const skills = join(temp, "skills")
	const config = join(temp, ".env")
	await mkdir(sandbox)
	await mkdir(skills)
	await writeFile(
		config,
		[
			"MCP_PORT=8000",
			`MCP_SANDBOX_DIR_MACOS=${JSON.stringify(sandbox)}`,
			`MCP_SKILLS_DIR_MACOS=${JSON.stringify(skills)}`,
			`MCP_SANDBOX_DIR_LINUX=${JSON.stringify(sandbox)}`,
			`MCP_SKILLS_DIR_LINUX=${JSON.stringify(skills)}`,
			`MCP_TOKEN_LINUX=${TOKEN}`,
			`MCP_SANDBOX_DIR_WINDOWS=${JSON.stringify(sandbox)}`,
			`MCP_SKILLS_DIR_WINDOWS=${JSON.stringify(skills)}`,
			`MCP_TOKEN_WINDOWS=${TOKEN}`,
		].join("\n"),
	)
	process.env.MCP_CONFIG_FILE = config
	process.env.MCP_LOG_FILE = join(temp, "mcp.log")
	const { createMcpHttpServer } = await import(`../lib/mcp-http.mjs?soak=${Date.now()}`)
	lifecycle = createMcpHttpServer({ port: 0, token: TOKEN })
	;({ port } = await lifecycle.listen())

	const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
	const processBaseline = projectNodeProcessCount()
	for (let i = 0; i < WARMUP_REQUESTS; i += 1) await request(port, agent, list)
	const baseline = await stableMemory()
	for (let i = 0; i < MEASURED_REQUESTS; i += 1) await request(port, agent, list)
	const after = await stableMemory()
	const processAfter = projectNodeProcessCount()
	const heapDelta = after.heapUsed - baseline.heapUsed
	const rssDelta = after.rss - baseline.rss
	assert.ok(heapDelta <= MAX_HEAP_DELTA, `heap 增长 ${heapDelta} bytes，超过 16 MiB`)
	assert.ok(
		rssDelta <= MAX_RSS_DELTA,
		`RSS 增长 ${rssDelta} bytes，超过 64 MiB；heapTotal ${baseline.heapTotal}->${after.heapTotal}，external delta ${after.external - baseline.external}，arrayBuffers delta ${after.arrayBuffers - baseline.arrayBuffers}`,
	)
	assert.equal(processAfter, processBaseline)

	const helper = join(temp, "tree.cjs")
	await writeFile(
		helper,
		`const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");if(process.argv[2]==="grand"){writeFileSync(process.argv[3],String(process.pid));setInterval(()=>{},1000)}else{writeFileSync(process.argv[2],String(process.ppid));writeFileSync(process.argv[3],String(process.pid));spawn(process.execPath,[__filename,"grand",process.argv[4]],{stdio:"ignore"});setInterval(()=>{},1000)}\n`,
	)
	const pids = []
	for (let i = 0; i < 4; i += 1) {
		const shellFile = join(temp, `shell-${i}.pid`)
		const parentFile = join(temp, `parent-${i}.pid`)
		const grandFile = join(temp, `grand-${i}.pid`)
		const pending = openToolRequest(port, agent, {
			jsonrpc: "2.0",
			id: i + 10,
			method: "tools/call",
			params: {
				name: "run_command",
				arguments: {
					command: nodeCommand(helper, shellFile, parentFile, grandFile),
					timeoutMs: 30_000,
				},
			},
		})
		openRequests.push({ ...pending, settled: pending.response.catch(() => null) })
		pids.push(
			await waitForPid(shellFile),
			await waitForPid(parentFile),
			await waitForPid(grandFile),
		)
	}
	const fifthBody = JSON.stringify({
		jsonrpc: "2.0",
		id: 20,
		method: "tools/call",
		params: { name: "run_command", arguments: { command: "unused" } },
	})
	assert.equal(await headersOnlyRequest(port, agent, Buffer.byteLength(fifthBody)), 429)
	for (const pending of openRequests) pending.req.destroy()
	await Promise.all(openRequests.map((pending) => pending.settled))
	await waitForDead(pids)
	await waitForCondition(() => lifecycle.activeRequestCount === 0, "取消后 active request 未释放")
	assert.equal(lifecycle.activeRequestCount, 0)
	await request(port, agent, list)

	summary = {
		platform: process.platform,
		node: process.version,
		requests: WARMUP_REQUESTS + MEASURED_REQUESTS,
		heap: { baseline: baseline.heapUsed, after: after.heapUsed, delta: heapDelta },
		rss: { baseline: baseline.rss, after: after.rss, delta: rssDelta },
		processes: { baseline: processBaseline, after: processAfter, delta: processAfter - processBaseline },
		cancel: true,
	}
} catch (error) {
	failure = error
} finally {
	for (const pending of openRequests) pending.req.destroy()
	await Promise.allSettled(openRequests.map((pending) => pending.settled))
	agent.destroy()
	if (lifecycle) {
		try {
			await lifecycle.shutdown()
		} catch (error) {
			failure ||= error
		}
	}
	if (port) {
		try {
			await bindAndClose(port)
		} catch (error) {
			failure ||= error
		}
	}
	if (previousConfig === undefined) delete process.env.MCP_CONFIG_FILE
	else process.env.MCP_CONFIG_FILE = previousConfig
	if (previousLog === undefined) delete process.env.MCP_LOG_FILE
	else process.env.MCP_LOG_FILE = previousLog
	try {
		await rm(temp, { recursive: true, force: true })
	} catch (error) {
		failure ||= error
	}
}

if (failure) throw failure
console.log(JSON.stringify(summary))
