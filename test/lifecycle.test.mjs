import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test, { after } from "node:test"

const ROOT = join(import.meta.dirname, "..")
const PLATFORM_TOKEN = "a".repeat(64)

function waitForExit(child, timeoutMs = 5_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("等待子进程退出超时")), timeoutMs)
		child.once("exit", (code) => {
			clearTimeout(timer)
			resolve(code)
		})
	})
}

async function configFile(dir) {
	const file = join(dir, ".env")
	await writeFile(
		file,
		[
			"MCP_PORT=8000",
			`MCP_SANDBOX_DIR_MACOS=${dir}`,
			`MCP_SKILLS_DIR_MACOS=${dir}`,
			`MCP_SANDBOX_DIR_LINUX=${dir}`,
			`MCP_SKILLS_DIR_LINUX=${dir}`,
			`MCP_TOKEN_LINUX=${PLATFORM_TOKEN}`,
			`MCP_SANDBOX_DIR_WINDOWS=${dir}`,
			`MCP_SKILLS_DIR_WINDOWS=${dir}`,
			`MCP_TOKEN_WINDOWS=${PLATFORM_TOKEN}`,
		].join("\n"),
	)
	return file
}

test("平台 Token 只接受 64 位十六进制字符串", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-config-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const previousConfig = process.env.MCP_CONFIG_FILE
	const previousTokens = {
		MCP_TOKEN_LINUX: process.env.MCP_TOKEN_LINUX,
		MCP_TOKEN_WINDOWS: process.env.MCP_TOKEN_WINDOWS,
	}
	t.after(() => {
		if (previousConfig === undefined) delete process.env.MCP_CONFIG_FILE
		else process.env.MCP_CONFIG_FILE = previousConfig
		for (const [key, value] of Object.entries(previousTokens)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	})

	process.env.MCP_CONFIG_FILE = config
	delete process.env.MCP_TOKEN_LINUX
	delete process.env.MCP_TOKEN_WINDOWS
	const { getLauncherConfig, validateToken } = await import(`../lib/config.mjs?platform-token=${Date.now()}`)
	assert.equal(validateToken("A".repeat(64)), "A".repeat(64))
	for (const weak of ["", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
		assert.throws(() => validateToken(weak), /64 位十六进制字符串/)
	}
	for (const platform of ["linux", "windows"]) {
		const key = `MCP_TOKEN_${platform.toUpperCase()}`
		const platformConfig = getLauncherConfig(platform)
		assert.equal(platformConfig.port, 8000)
		assert.equal(platformConfig.token, PLATFORM_TOKEN)
		process.env[key] = "请替换为随机生成的64位十六进制字符串"
		assert.throws(() => getLauncherConfig(platform), new RegExp(`${key} 必须是 64 位十六进制字符串`))
		delete process.env[key]
	}
})

test("审计日志轮转有界、单行有效且忽略敏感字段", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-log-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const logFile = join(dir, "mcp.log")
	const backupFile = `${logFile}.1`
	const handle = await open(logFile, "w")
	await handle.write("active")
	await handle.truncate(10 * 1024 * 1024)
	await handle.close()
	await writeFile(backupFile, "stale backup")

	const auditModule = pathToFileURL(join(ROOT, "lib", "audit-log.mjs")).href
	const secret = "SECRET_TOKEN_AUTH_COMMAND_ARGS"
	const source = `
		const { auditLog } = await import(${JSON.stringify(auditModule)})
		auditLog("test", "rotate", {
			outcome: "ok",
			token: ${JSON.stringify(secret)},
			authorization: ${JSON.stringify(secret)},
			command: ${JSON.stringify(secret)},
			args: ${JSON.stringify(secret)}
		})
		auditLog("test", "truncate", { errorType: ${JSON.stringify("中文\n".repeat(5_000))} })
	`
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
		stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env, MCP_CONFIG_FILE: config, MCP_LOG_FILE: logFile },
	})
	assert.equal(await waitForExit(child), 0)

	const text = await readFile(logFile, "utf8")
	const lines = text.trimEnd().split("\n")
	assert.equal(lines.length, 2)
	assert.doesNotMatch(text, /\uFFFD/)
	assert.doesNotMatch(text, new RegExp(secret))
	for (const line of lines) assert.ok(Buffer.byteLength(`${line}\n`) <= 8 * 1024)
	assert.equal((await stat(backupFile)).size, 10 * 1024 * 1024)
	assert.ok((await stat(logFile)).size <= 10 * 1024 * 1024)

	const oversizedBackup = await open(backupFile, "w")
	await oversizedBackup.truncate(10 * 1024 * 1024 + 1)
	await oversizedBackup.close()
	const prune = spawn(
		process.execPath,
		["--input-type=module", "-e", `const{auditLog}=await import(${JSON.stringify(auditModule)});auditLog("test","prune")`],
		{
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, MCP_CONFIG_FILE: config, MCP_LOG_FILE: logFile },
		},
	)
	assert.equal(await waitForExit(prune), 0)
	await assert.rejects(stat(backupFile), { code: "ENOENT" })
})

test("旧日志 writer 已从运行路径删除", async () => {
	const launcher = await readFile(join(ROOT, "lib", "up.mjs"), "utf8")
	assert.doesNotMatch(launcher, /UP_LOG_FILE|appendFile\(/)
	await assert.rejects(readFile(join(ROOT, "lib", "rpc.mjs")), { code: "ENOENT" })
})

async function waitForPid(file) {
	for (let i = 0; i < 40; i += 1) {
		try {
			return Number(await readFile(file, "utf8"))
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	}
	throw new Error("命令子进程没有写入 PID")
}

function isAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function quoteShellArg(value) {
	const text = String(value)
	if (process.platform === "win32") return `'${text.replaceAll("'", "''")}'`
	return `'${text.replaceAll("'", "'\"'\"'")}'`
}

function nodeCommand(script, ...args) {
	return [process.execPath, script, ...args].map(quoteShellArg).join(" ")
}

async function runCommandTool(config, args, abortAfterMs) {
	const moduleUrl = pathToFileURL(join(ROOT, "tools", "run_command.mjs")).href
	const source = `
		const { call } = await import(${JSON.stringify(moduleUrl)})
		const controller = new AbortController()
		const abortAfter = ${JSON.stringify(abortAfterMs)}
		if (abortAfter === 0) controller.abort()
		else if (abortAfter) setTimeout(() => controller.abort(), abortAfter)
		const result = await call(${JSON.stringify(args)}, { signal: controller.signal })
		process.stdout.write(JSON.stringify(result))
	`
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			MCP_CONFIG_FILE: config,
			MCP_LOG_FILE: join(config, "..", "command.log"),
			MCP_MAX_OUTPUT_CHARS: "32",
		},
	})
	let stdout = ""
	let stderr = ""
	child.stdout.on("data", (chunk) => (stdout += chunk))
	child.stderr.on("data", (chunk) => (stderr += chunk))
	const code = await waitForExit(child, 10_000)
	assert.equal(code, 0, stderr)
	return JSON.parse(stdout)
}

async function assertDead(...pids) {
	for (let i = 0; i < 100 && pids.some(isAlive); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	for (const pid of pids) assert.equal(isAlive(pid), false, `进程 ${pid} 不应残留`)
}

function captureChild(child, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (chunk) => (stdout += chunk))
		child.stderr?.on("data", (chunk) => (stderr += chunk))
		const timer = setTimeout(() => {
			child.kill()
			reject(new Error("等待测试子进程超时"))
		}, timeoutMs)
		child.once("error", reject)
		child.once("close", (code) => {
			clearTimeout(timer)
			if (code === 0) resolve(stdout)
			else reject(new Error(stderr || `测试子进程退出：${code}`))
		})
	})
}

async function runImageTool(config, args, abortAfterMs) {
	const moduleUrl = pathToFileURL(join(ROOT, "tools", "read_image.mjs")).href
	const source = `
		const { call } = await import(${JSON.stringify(moduleUrl)})
		const controller = new AbortController()
		const abortAfter = ${JSON.stringify(abortAfterMs)}
		if (abortAfter === 0) controller.abort()
		else if (abortAfter) setTimeout(() => controller.abort(), abortAfter)
		try {
			const result = await call(${JSON.stringify(args)}, { signal: controller.signal })
			process.stdout.write(JSON.stringify({ result }))
		} catch (error) {
			process.stdout.write(JSON.stringify({ error: error.message, name: error.name }))
		}
	`
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			MCP_CONFIG_FILE: config,
			MCP_LOG_FILE: join(config, "..", "image.log"),
		},
	})
	return JSON.parse(await captureChild(child, 40_000))
}

async function runRasterizerTool(config, command, args, { abortAfterMs, timeoutMs } = {}) {
	const moduleUrl = pathToFileURL(join(ROOT, "tools", "read_image.mjs")).href
	const source = `
		const { runRasterizer } = await import(${JSON.stringify(moduleUrl)})
		const controller = new AbortController()
		const abortAfter = ${JSON.stringify(abortAfterMs)}
		if (abortAfter === 0) controller.abort()
		else if (abortAfter) setTimeout(() => controller.abort(), abortAfter)
		const result = await runRasterizer(
			${JSON.stringify(command)},
			${JSON.stringify(args)},
			{ signal: controller.signal, timeoutMs: ${JSON.stringify(timeoutMs)} }
		)
		process.stdout.write(JSON.stringify(result))
	`
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			MCP_CONFIG_FILE: config,
			MCP_LOG_FILE: join(config, "..", "rasterizer.log"),
		},
	})
	return JSON.parse(await captureChild(child))
}

test("read_image 只读取普通文件并对输入输出施加 10 MiB 上限", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-image-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const small = join(dir, "small.png")
	await writeFile(small, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
	const ok = await runImageTool(config, { path: small })
	assert.equal(ok.result.content[0].mimeType, "image/png")
	assert.equal(ok.result.content[0].data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"))

	for (const extension of ["png", "svg"]) {
		const large = join(dir, `large.${extension}`)
		const handle = await open(large, "w")
		await handle.truncate(10 * 1024 * 1024 + 1)
		await handle.close()
		const result = await runImageTool(config, { path: large })
		assert.match(result.error, /observed \d+ bytes, limit 10485760/)
	}

	const directoryImage = join(dir, "directory.png")
	await mkdir(directoryImage)
	const special = await runImageTool(config, { path: directoryImage })
	assert.match(special.error, /regular file/)
})

test("read_image 严格校验 maxSize，预取消不读取文件", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-image-input-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const image = join(dir, "small.png")
	await writeFile(image, "image")
	for (const maxSize of [0, -1, 1.5, "1", 2_001]) {
		const result = await runImageTool(config, { path: image, maxSize })
		assert.match(result.error, /maxSize must be an integer/)
	}
	const cancelled = await runImageTool(config, { path: join(dir, "missing.png") }, 0)
	assert.equal(cancelled.name, "AbortError")
})

test("rasterizer 的 stderr、timeout 与 Abort 均有界且清理进程树", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-rasterizer-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const helper = join(dir, "rasterizer.cjs")
	await writeFile(
		helper,
		`const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");const mode=process.argv[2];if(mode==="stderr"){process.stderr.write(Buffer.alloc(9000,255));process.exit(1)}else if(mode==="grand"){writeFileSync(process.argv[3],String(process.pid));setInterval(()=>{},1000)}else{writeFileSync(process.argv[3],String(process.pid));spawn(process.execPath,[__filename,"grand",process.argv[4]],{stdio:"ignore"});setInterval(()=>{},1000)}\n`,
	)

	const bounded = await runRasterizerTool(config, process.execPath, [helper, "stderr"], { timeoutMs: 5_000 })
	assert.equal(bounded.code, 1)
	assert.ok(Buffer.byteLength(bounded.stderr) <= 8 * 1024)
	assert.match(bounded.stderr, /truncated/)

	for (const [kind, options] of [
		["abort", { abortAfterMs: 200, timeoutMs: 5_000 }],
		["timeout", { timeoutMs: 200 }],
	]) {
		const parentFile = join(dir, `${kind}-parent.pid`)
		const grandFile = join(dir, `${kind}-grand.pid`)
		const pending = runRasterizerTool(
			config,
			process.execPath,
			[helper, "tree", parentFile, grandFile],
			options,
		)
		const parentPid = await waitForPid(parentFile)
		const grandPid = await waitForPid(grandFile)
		const result = await pending
		assert.equal(result[kind === "abort" ? "cancelled" : "timedOut"], true)
		await assertDead(parentPid, grandPid)
	}
})

test("SVG 栅格化无论成功失败都删除临时目录", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-svg-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const svg = join(dir, "small.svg")
	await writeFile(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`)
	const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("svg-thumb-")))
	await runImageTool(config, { path: svg })
	const leaked = (await readdir(tmpdir())).filter((name) => name.startsWith("svg-thumb-") && !before.has(name))
	assert.deepEqual(leaked, [])
})

test("run_command 在 data 阶段限制输出并保留拆分的 UTF-8", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-output-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const helper = join(dir, "output.cjs")
	await writeFile(
		helper,
		`const bytes=Buffer.from("中");process.stdout.write(bytes.subarray(0,1));setTimeout(()=>{process.stdout.write(bytes.subarray(1));process.stdout.write("x".repeat(200));process.stderr.write("y".repeat(201))},10)\n`,
	)

	const result = await runCommandTool(config, { command: nodeCommand(helper) })
	const text = result.content[0].text
	assert.match(text, /中x+/)
	assert.doesNotMatch(text, /\uFFFD/)
	assert.equal(text.match(/\.\.\.\[truncated, 169 more chars\]/g)?.length, 2)
})

test("run_command 的 Abort、timeout 和退出兜底都清理整棵进程树", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-tree-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const helper = join(dir, "tree.cjs")
	await writeFile(
		helper,
		`const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");const mode=process.argv[2];if(mode==="grand"){writeFileSync(process.argv[3],String(process.pid));setInterval(()=>{},1000)}else{writeFileSync(process.argv[3],String(process.pid));spawn(process.execPath,[__filename,"grand",process.argv[4]],{stdio:mode==="inherit"?["ignore","inherit","inherit"]:"ignore"});if(mode==="inherit")process.exit(0);setInterval(()=>{},1000)}\n`,
	)

	for (const [kind, abortAfterMs, timeoutMs] of [
		["abort", 200, 5_000],
		["timeout", undefined, 200],
	]) {
		const parentFile = join(dir, `${kind}-parent.pid`)
		const grandFile = join(dir, `${kind}-grand.pid`)
		const pending = runCommandTool(
			config,
			{ command: nodeCommand(helper, "tree", parentFile, grandFile), timeoutMs },
			abortAfterMs,
		)
		const parentPid = await waitForPid(parentFile)
		const grandPid = await waitForPid(grandFile)
		const result = await pending
		assert.match(result.content[0].text, kind === "abort" ? /cancelled/ : /timed out/)
		await assertDead(parentPid, grandPid)
	}

	const inheritedPidFile = join(dir, "inherit-grand.pid")
	const startedAt = Date.now()
	const inherited = await runCommandTool(config, {
		command: nodeCommand(helper, "inherit", join(dir, "inherit-parent.pid"), inheritedPidFile),
		timeoutMs: 8_000,
	})
	const inheritedPid = await waitForPid(inheritedPidFile)
	assert.match(inherited.content[0].text, /exit code: 0/)
	assert.ok(Date.now() - startedAt < 5_000, "继承管道不应一直挂到命令 timeout")
	await assertDead(inheritedPid)
})

test("run_command 严格校验 timeout，预取消时不创建进程", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-command-input-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	for (const timeoutMs of [0, -1, 1.5, "1"]) {
		const result = await runCommandTool(config, { command: "ignored", timeoutMs })
		assert.match(result.content[0].text, /timeoutMs must be an integer/)
	}
	const marker = join(dir, "should-not-exist")
	const helper = join(dir, "touch.cjs")
	await writeFile(helper, `require("node:fs").writeFileSync(process.argv[2],"created")\n`)
	const result = await runCommandTool(config, { command: nodeCommand(helper, marker) }, 0)
	assert.match(result.content[0].text, /cancelled/)
	await assert.rejects(readFile(marker))
})

test("Node 退出兜底会清理正在运行的命令树", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-command-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir)
	const helper = join(dir, "long-running.cjs")
	const pidFile = join(dir, "pid")
	await writeFile(helper, `require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)\n`)
	const toolUrl = pathToFileURL(join(ROOT, "tools", "run_command.mjs")).href
	const source = `
		const { call } = await import(${JSON.stringify(toolUrl)})
		void call({ command: ${JSON.stringify(nodeCommand(helper, pidFile))} })
		setTimeout(() => process.exit(0), 200)
	`
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
		stdio: "ignore",
		env: {
			...process.env,
			MCP_CONFIG_FILE: config,
			MCP_LOG_FILE: join(dir, "exit.log"),
		},
	})
	t.after(() => child.kill())

	const commandPid = await waitForPid(pidFile)
	assert.equal(await waitForExit(child), 0)
	await assertDead(commandPid)
})

let httpFixture

async function getHttpFixture() {
	if (httpFixture) return httpFixture
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-http-"))
	const config = await configFile(dir)
	const previous = {
		config: process.env.MCP_CONFIG_FILE,
		log: process.env.MCP_LOG_FILE,
	}
	process.env.MCP_CONFIG_FILE = config
	process.env.MCP_LOG_FILE = join(dir, "http.log")
	const module = await import(`../lib/mcp-http.mjs?test=${Date.now()}`)
	httpFixture = { dir, module, previous }
	return httpFixture
}

after(async () => {
	if (!httpFixture) return
	await rm(httpFixture.dir, { recursive: true, force: true })
	if (httpFixture.previous.config === undefined) delete process.env.MCP_CONFIG_FILE
	else process.env.MCP_CONFIG_FILE = httpFixture.previous.config
	if (httpFixture.previous.log === undefined) delete process.env.MCP_LOG_FILE
	else process.env.MCP_LOG_FILE = httpFixture.previous.log
})

function httpRequest(port, { path = "/mcp", method = "POST", headers = {}, body = "" } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
			const chunks = []
			res.on("data", (chunk) => chunks.push(chunk))
			res.once("end", () => {
				resolve({
					status: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				})
			})
		})
		req.once("error", reject)
		req.end(body)
	})
}

function mcpRequest(port, token, message, extraHeaders = {}) {
	return httpRequest(port, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Mcp-Protocol-Version": "2025-03-26",
			...extraHeaders,
		},
		body: JSON.stringify(message),
	})
}

function headersOnlyRequest(port, headers, timeoutMs = 500) {
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (error, response) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			req.destroy()
			if (error) reject(error)
			else resolve(response)
		}
		const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
			const chunks = []
			res.on("data", (chunk) => chunks.push(chunk))
			res.once("end", () =>
				finish(null, {
					status: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				}),
			)
		})
		const timer = setTimeout(() => finish(new Error("响应超时")), timeoutMs)
		req.once("error", (error) => {
			if (!settled) finish(error)
		})
		req.flushHeaders()
	})
}

async function startMcpServer(t) {
	const { module } = await getHttpFixture()
	const token = "b".repeat(64)
	const lifecycle = module.createMcpHttpServer({ port: 0, token })
	t.after(() => lifecycle.shutdown())
	const { port } = await lifecycle.listen()
	return { lifecycle, port, token }
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }

async function assertHttpHealthy(lifecycle, port, token) {
	const response = await mcpRequest(port, token, TOOLS_LIST)
	assert.equal(response.status, 200)
	assert.equal(JSON.parse(response.body).result.tools.length, 4)
	assert.equal(response.headers["mcp-session-id"], undefined)
	assert.equal(lifecycle.activeRequestCount, 0)
}

test("原生无状态 HTTP 完成基础 MCP 协议且可确定关闭", async (t) => {
	const { lifecycle, port, token } = await startMcpServer(t)

	const unauthorized = await httpRequest(port, {
		headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
		body: "{}",
	})
	assert.equal(unauthorized.status, 401)

	const messages = [
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			},
		},
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 2, method: "ping" },
		{ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
		{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "missing", arguments: {} } },
	]
	const responses = []
	for (const message of messages) {
		const response = await mcpRequest(port, token, message)
		responses.push(response)
		assert.equal(response.headers["mcp-session-id"], undefined)
	}
	assert.equal(responses[0].status, 200)
	assert.equal(JSON.parse(responses[0].body).result.serverInfo.name, "notionmcp")
	assert.equal(responses[1].status, 202)
	assert.equal(JSON.parse(responses[2].body).result !== undefined, true)
	assert.equal(JSON.parse(responses[3].body).result.tools.length, 4)
	assert.equal(JSON.parse(responses[4].body).error.code, -32602)
	assert.equal(lifecycle.activeRequestCount, 0)

	await lifecycle.shutdown()
	const rebound = http.createServer()
	await new Promise((resolve) => rebound.listen(port, "127.0.0.1", resolve))
	await new Promise((resolve) => rebound.close(resolve))
})

test("鉴权早于 body、slot 和 SDK 创建", async (t) => {
	const { lifecycle, port, token } = await startMcpServer(t)
	for (const authorization of ["Bearer wrong", `Bearer ${"c".repeat(64)}`]) {
		const startedAt = Date.now()
		const response = await headersOnlyRequest(port, {
			Authorization: authorization,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Content-Length": String(2 * 1024 * 1024),
		})
		assert.equal(response.status, 401)
		assert.equal(response.headers["www-authenticate"], "Bearer")
		assert.equal(response.headers["cache-control"], "no-store")
		assert.ok(Date.now() - startedAt < 500)
		assert.equal(lifecycle.activeRequestCount, 0)
		await assertHttpHealthy(lifecycle, port, token)
	}
	const log = await readFile(join(httpFixture.dir, "http.log"), "utf8").catch(() => "")
	assert.doesNotMatch(log, /Bearer wrong/)
	assert.doesNotMatch(log, new RegExp("c".repeat(64)))
})

test("HTTP 路由、媒体类型和 body 上限失败后 server 仍可复用", async (t) => {
	const { lifecycle, port, token } = await startMcpServer(t)
	assert.equal(lifecycle.httpServer.headersTimeout, 10_000)
	assert.equal(lifecycle.httpServer.requestTimeout, 15_000)
	assert.equal(lifecycle.httpServer.maxConnections, 32)

	const route = await httpRequest(port, { path: "/other", method: "POST" })
	assert.equal(route.status, 404)
	await assertHttpHealthy(lifecycle, port, token)
	for (const method of ["GET", "PUT"]) {
		const response = await httpRequest(port, { method })
		assert.equal(response.status, 405)
		assert.equal(response.headers.allow, "POST")
		await assertHttpHealthy(lifecycle, port, token)
	}

	const baseHeaders = { Authorization: `Bearer ${token}` }
	const unsupported = await httpRequest(port, {
		headers: { ...baseHeaders, Accept: "application/json, text/event-stream" },
		body: "{}",
	})
	assert.equal(unsupported.status, 415)
	await assertHttpHealthy(lifecycle, port, token)
	const unacceptable = await httpRequest(port, {
		headers: { ...baseHeaders, Accept: "application/json", "Content-Type": "application/json" },
		body: "{}",
	})
	assert.equal(unacceptable.status, 406)
	await assertHttpHealthy(lifecycle, port, token)

	const tooLarge = await headersOnlyRequest(port, {
		...baseHeaders,
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
		"Content-Length": String(1024 * 1024 + 1),
	})
	assert.equal(tooLarge.status, 413)
	await assertHttpHealthy(lifecycle, port, token)
	const chunked = await httpRequest(port, {
		headers: {
			...baseHeaders,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Transfer-Encoding": "chunked",
		},
		body: "x".repeat(1024 * 1024 + 1),
	})
	assert.equal(chunked.status, 413)
	await assertHttpHealthy(lifecycle, port, token)

	const pending = http.request({
		host: "127.0.0.1",
		port,
		path: "/mcp",
		method: "POST",
		headers: {
			...baseHeaders,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Content-Length": "10",
		},
	})
	pending.on("error", () => {})
	pending.flushHeaders()
	for (let i = 0; i < 20 && lifecycle.activeRequestCount !== 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	assert.equal(lifecycle.activeRequestCount, 1)
	pending.destroy()
	for (let i = 0; i < 20 && lifecycle.activeRequestCount !== 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	await assertHttpHealthy(lifecycle, port, token)
})

test("JSON-RPC 和协议版本错误互不污染后续请求", async (t) => {
	const { lifecycle, port, token } = await startMcpServer(t)
	const invalidJson = await httpRequest(port, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
		},
		body: "{",
	})
	assert.equal(invalidJson.status, 400)
	assert.equal(JSON.parse(invalidJson.body).error.code, -32700)
	await assertHttpHealthy(lifecycle, port, token)

	for (const message of [{ nope: true }, [TOOLS_LIST, TOOLS_LIST]]) {
		const response = await mcpRequest(port, token, message)
		assert.equal(response.status, 400)
		assert.equal(response.headers["mcp-session-id"], undefined)
		await assertHttpHealthy(lifecycle, port, token)
	}

	const unknown = await mcpRequest(port, token, { jsonrpc: "2.0", id: 5, method: "unknown" })
	assert.equal(unknown.status, 200)
	assert.equal(JSON.parse(unknown.body).error.code, -32601)
	await assertHttpHealthy(lifecycle, port, token)
	const badVersion = await mcpRequest(port, token, TOOLS_LIST, { "Mcp-Protocol-Version": "1900-01-01" })
	assert.equal(badVersion.status, 400)
	await assertHttpHealthy(lifecycle, port, token)
	const initialized = await mcpRequest(port, token, { jsonrpc: "2.0", method: "notifications/initialized" })
	assert.equal(initialized.status, 202)
	assert.equal(initialized.headers["mcp-session-id"], undefined)

	const requestListeners = lifecycle.httpServer.listenerCount("request")
	for (let i = 0; i < 20; i += 1) {
		assert.equal((await mcpRequest(port, token, [])).status, 400)
	}
	assert.equal(lifecycle.httpServer.listenerCount("request"), requestListeners)
	await assertHttpHealthy(lifecycle, port, token)
})
