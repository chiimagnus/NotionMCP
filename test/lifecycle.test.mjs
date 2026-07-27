import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

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

function request(port, token) {
	return new Promise((resolve) => {
		const req = http.get(
			{ host: "127.0.0.1", port, path: "/mcp", headers: token ? { Authorization: `Bearer ${token}` } : {} },
			(res) => {
				res.resume()
				res.once("end", () => resolve(res.statusCode))
				res.once("error", () => resolve(0))
			},
		)
		req.once("error", () => resolve(0))
	})
}

async function freePort() {
	const server = http.createServer()
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address()
	await new Promise((resolve) => server.close(resolve))
	return port
}

async function configFile(dir, proxyPort, upstreamPort) {
	const file = join(dir, ".env")
	await writeFile(
		file,
		[
			`MCP_PROXY_PORT=${proxyPort}`,
			`MCP_UPSTREAM_PORT=${upstreamPort}`,
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

test("Linux 和 Windows 直接从 .env 读取 Token，并拒绝示例占位符", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-config-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir, await freePort(), await freePort())
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
	const { getLauncherConfig } = await import(`../lib/config.mjs?platform-token=${Date.now()}`)
	for (const platform of ["linux", "windows"]) {
		const key = `MCP_TOKEN_${platform.toUpperCase()}`
		assert.equal(getLauncherConfig(platform).token, PLATFORM_TOKEN)
		process.env[key] = "请替换为随机生成的64位十六进制字符串"
		assert.throws(() => getLauncherConfig(platform), new RegExp(`请先替换 ${key}`))
		delete process.env[key]
	}
})

test("审计日志轮转有界、单行有效且忽略敏感字段", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-log-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir, await freePort(), await freePort())
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
})

test("旧日志 writer 已从运行路径删除", async () => {
	const launcher = await readFile(join(ROOT, "lib", "up.mjs"), "utf8")
	const rpc = await readFile(join(ROOT, "lib", "rpc.mjs"), "utf8")
	assert.doesNotMatch(launcher, /UP_LOG_FILE|appendFile\(/)
	assert.doesNotMatch(rpc, /appendFileSync|export function log/)
})

test("网关使用无状态 HTTP，不保留会过期的 Session", async () => {
	const launcher = await readFile(join(ROOT, "lib", "up.mjs"), "utf8")
	const config = await readFile(join(ROOT, "lib", "config.mjs"), "utf8")
	assert.doesNotMatch(launcher, /--stateful|--sessionTimeout/)
	assert.doesNotMatch(config, /MCP_SESSION_TIMEOUT_MS|sessionTimeoutMs/)
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
	const config = await configFile(dir, await freePort(), await freePort())
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
	const config = await configFile(dir, await freePort(), await freePort())
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
	const config = await configFile(dir, await freePort(), await freePort())
	const helper = join(dir, "rasterizer.cjs")
	await writeFile(
		helper,
		`const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");const mode=process.argv[2];if(mode==="stderr"){process.stderr.write("中".repeat(5000));process.exit(1)}else if(mode==="grand"){writeFileSync(process.argv[3],String(process.pid));setInterval(()=>{},1000)}else{writeFileSync(process.argv[3],String(process.pid));spawn(process.execPath,[__filename,"grand",process.argv[4]],{stdio:"ignore"});setInterval(()=>{},1000)}\n`,
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
	const config = await configFile(dir, await freePort(), await freePort())
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
	const config = await configFile(dir, await freePort(), await freePort())
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
	const config = await configFile(dir, await freePort(), await freePort())
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
	const config = await configFile(dir, await freePort(), await freePort())
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

test("stdio 任一方向关闭都会结束 exec-server 会话", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-lifecycle-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir, await freePort(), await freePort())

	for (const closedSide of ["stdin", "stdout"]) {
		const child = spawn(process.execPath, [join(ROOT, "lib", "exec-server.mjs")], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, MCP_CONFIG_FILE: config },
		})
		t.after(() => child.kill())

		if (closedSide === "stdin") {
			child.stdin.end()
		} else {
			child.stdout.destroy()
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`)
		}

		assert.equal(await waitForExit(child), 0, `${closedSide} 关闭应当正常结束会话`)
	}
})

test("exec-server 退出会清理正在运行的命令树", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-command-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const config = await configFile(dir, await freePort(), await freePort())
	const helper = join(dir, "long-running.cjs")
	const pidFile = join(dir, "pid")
	await writeFile(helper, `require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)\n`)

	const child = spawn(process.execPath, [join(ROOT, "lib", "exec-server.mjs")], {
		stdio: ["pipe", "ignore", "ignore"],
		env: { ...process.env, MCP_CONFIG_FILE: config },
	})
	t.after(() => child.kill())
	child.stdin.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "run_command", arguments: { command: `node ${JSON.stringify(helper)} ${JSON.stringify(pidFile)}` } },
		})}\n`,
	)

	const commandPid = await waitForPid(pidFile)
	child.stdin.end()
	assert.equal(await waitForExit(child), 0)
	for (let i = 0; i < 20 && isAlive(commandPid); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	assert.equal(isAlive(commandPid), false, `命令子进程 ${commandPid} 不应残留`)
})

test("上游连接中断不会打死 auth-proxy", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-proxy-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const upstreamPort = await freePort()
	const proxyPort = await freePort()
	const config = await configFile(dir, proxyPort, upstreamPort)
	const upstream = http.createServer((_req, res) => {
		res.writeHead(200)
		res.write("partial")
		res.socket.destroy()
	})
	await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve))
	t.after(() => upstream.close())

	const proxy = spawn(process.execPath, [join(ROOT, "lib", "auth-proxy.mjs")], {
		stdio: "ignore",
		env: { ...process.env, MCP_CONFIG_FILE: config, MCP_TOKEN: "test-token" },
	})
	t.after(() => proxy.kill())

	for (let i = 0; i < 20 && (await request(proxyPort)) !== 401; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	assert.equal(await request(proxyPort), 401, "代理应已启动")
	await request(proxyPort, "test-token")
	assert.equal(proxy.exitCode, null, "上游中断后代理仍应存活")
	assert.equal(await request(proxyPort), 401, "代理中断后仍应继续服务")
})
