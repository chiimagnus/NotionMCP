import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const ROOT = join(import.meta.dirname, "..")

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
			`MCP_SANDBOX_DIR_WINDOWS=${dir}`,
			`MCP_SKILLS_DIR_WINDOWS=${dir}`,
		].join("\n"),
	)
	return file
}

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
