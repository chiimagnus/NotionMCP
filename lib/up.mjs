#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { request } from "node:http"
import { createConnection } from "node:net"
import { dirname, join } from "node:path"

import { getLauncherConfig, MCP_ROOT } from "./config.mjs"

const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
const config = getLauncherConfig(platform)
const children = []
const MCP_INIT = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "up.mjs", version: "1" },
	},
})

let funnelStarted = false
let cleaned = false

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function hardenWindowsTokenFile() {
	let identity
	try {
		const result = spawnSync("whoami.exe", [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
		if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || "whoami.exe failed")
		identity = result.stdout.trim()
	} catch (err) {
		throw new Error(`无法确定当前 Windows 用户，不能收紧 token ACL：${err.message}`)
	}

	const targets = [
		[dirname(config.tokenFile), [`${identity}:(OI)(CI)(F)`, "SYSTEM:(OI)(CI)(F)"]],
		[config.tokenFile, [`${identity}:(F)`, "SYSTEM:(F)"]],
	]
	for (const [target, grants] of targets) {
		const result = spawnSync("icacls.exe", [target, "/inheritance:r", "/grant:r", ...grants], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
		if (result.status !== 0) {
			const detail = (result.stderr || result.stdout || "").trim()
			throw new Error(`无法收紧 Windows token ACL：${target}${detail ? `（${detail}）` : ""}`)
		}
	}
}

function readToken() {
	if (process.env.MCP_TOKEN?.trim()) return process.env.MCP_TOKEN.trim()

	if (platform === "macos") {
		const result = spawnSync(
			"security",
			["find-generic-password", "-a", process.env.USER || "", "-s", config.tokenService, "-w"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		)
		if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
		throw new Error("读不到 macOS 钥匙串 token")
	}

	if (platform === "linux") {
		let mode
		try {
			mode = statSync(config.tokenFile).mode & 0o777
		} catch (err) {
			throw new Error(`无法读取 Linux token 文件 ${config.tokenFile}：${err.message}`)
		}
		if ((mode & 0o077) !== 0) {
			throw new Error(`Linux token 文件权限过宽：${config.tokenFile}（需要 chmod 600）`)
		}
		const token = readFileSync(config.tokenFile, "utf8").trim()
		if (token) return token
		throw new Error(`Linux token 文件为空：${config.tokenFile}`)
	}

	hardenWindowsTokenFile()
	const script = [
		"$secure = Get-Content -LiteralPath $env:MCP_TOKEN_FILE | ConvertTo-SecureString",
		"$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
		"try { [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
	].join("; ")
	const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		env: { ...process.env, MCP_TOKEN_FILE: config.tokenFile },
		stdio: ["ignore", "pipe", "ignore"],
	})
	if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
	throw new Error(`无法读取 Windows DPAPI token 文件：${config.tokenFile}`)
}

function portInUse(port) {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port })
		socket.once("connect", () => {
			socket.destroy()
			resolve(true)
		})
		socket.once("error", (err) => {
			socket.destroy()
			if (err.code === "ECONNREFUSED") resolve(false)
			else reject(err)
		})
	})
}

function requestStatus(url, { method = "GET", headers = {}, body = "" } = {}) {
	return new Promise((resolve) => {
		let settled = false
		const finish = (status) => {
			if (settled) return
			settled = true
			resolve(status)
		}
		const req = request(url, { method, headers }, (res) => {
			const status = res.statusCode || 0
			res.once("end", () => finish(status))
			res.once("aborted", () => finish(0))
			res.once("error", () => finish(0))
			res.resume()
		})
		req.setTimeout(2_000, () => {
			req.destroy()
			finish(0)
		})
		req.once("error", () => finish(0))
		if (body) req.write(body)
		req.end()
	})
}

async function waitForService(child, url) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (child.spawnError || child.exitCode !== null) return false
		if ((await requestStatus(url)) !== 0) return true
		await sleep(500)
	}
	return false
}

function startChild(name, command, args) {
	const child = spawn(command, args, {
		stdio: "inherit",
		env: process.env,
		windowsHide: true,
		detached: platform !== "windows",
	})
	child.serviceName = name
	child.spawnError = null
	child.once("error", (err) => {
		child.spawnError = err
		console.error(`❌ ${name} 启动失败：${err.message}`)
	})
	children.push(child)
	return child
}

function runTailscale(args, stdio = "ignore") {
	return spawnSync(config.tailscalePath, args, { encoding: "utf8", stdio })
}

function stopChild(child) {
	if (!child || child.spawnError || child.exitCode !== null || !child.pid) return
	if (platform === "windows") {
		spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
		return
	}
	try {
		process.kill(-child.pid, "SIGTERM")
	} catch {
		child.kill("SIGTERM")
	}
}

async function cleanup() {
	if (cleaned) return
	cleaned = true
	if (children.length || funnelStarted) console.log("\n关闭中…")
	for (const child of children.reverse()) stopChild(child)
	if (funnelStarted) {
		try {
			runTailscale(["funnel", "reset"])
		} catch {}
	}
}

function waitUntilStopped() {
	return new Promise((resolve) => {
		let timer
		let settled = false
		const finish = (code) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			process.off("SIGINT", onInterrupt)
			process.off("SIGTERM", onTerminate)
			if (code !== undefined) process.exitCode = code
			resolve()
		}
		const onInterrupt = () => finish(130)
		const onTerminate = () => finish(143)
		process.once("SIGINT", onInterrupt)
		process.once("SIGTERM", onTerminate)
		const poll = () => {
			const failed = children.find((child) => child.spawnError || child.exitCode !== null)
			if (failed) {
				console.error(`❌ ${failed.serviceName} 意外退出`)
				finish(1)
				return
			}
			timer = setTimeout(poll, 1_000)
		}
		poll()
	})
}

async function main() {
	if (config.proxyPort === config.upstreamPort) throw new Error("代理端口和后端端口不能相同")
	if (await portInUse(config.upstreamPort)) throw new Error(`端口 ${config.upstreamPort} 已被占用，停止启动以避免复用旧进程`)
	if (await portInUse(config.proxyPort)) throw new Error(`端口 ${config.proxyPort} 已被占用，停止启动以避免复用旧进程`)

	const token = readToken()
	await mkdir(config.sandboxDir, { recursive: true })
	process.env.MCP_TOKEN = token
	process.env.MCP_SANDBOX_DIR = config.sandboxDir

	const npx = platform === "windows" ? "npx.cmd" : "npx"
	const execServer = join(MCP_ROOT, "lib", "exec-server.mjs")
	const stdioCommand = `node "${execServer.replaceAll('"', '\\"')}"`
	const gateway = startChild("supergateway", npx, [
		"-y",
		"supergateway",
		"--stdio",
		stdioCommand,
		"--outputTransport",
		"streamableHttp",
		"--port",
		String(config.upstreamPort),
		"--stateful",
		"--sessionTimeout",
		String(config.sessionTimeoutMs),
	])
	if (!(await waitForService(gateway, `http://127.0.0.1:${config.upstreamPort}/mcp`))) {
		throw new Error(`${config.upstreamPort} 没起来，请看上面 supergateway 的报错`)
	}
	const upstreamStatus = await requestStatus(`http://127.0.0.1:${config.upstreamPort}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: MCP_INIT,
	})
	if (upstreamStatus !== 200) throw new Error(`${config.upstreamPort} 的 MCP initialize 失败（HTTP ${upstreamStatus}）`)
	console.log(`✅ ${config.upstreamPort} 起来了`)

	const proxy = startChild("auth-proxy", process.execPath, [join(MCP_ROOT, "lib", "auth-proxy.mjs")])
	if (!(await waitForService(proxy, `http://127.0.0.1:${config.proxyPort}/mcp`))) {
		throw new Error(`${config.proxyPort} 没起来，请看上面 auth-proxy 的报错`)
	}
	console.log(`✅ ${config.proxyPort} 起来了`)

	const unauthorized = await requestStatus(`http://127.0.0.1:${config.proxyPort}/mcp`)
	if (unauthorized !== 401) throw new Error(`鉴权检查失败（无 token 返回 HTTP ${unauthorized}）`)
	console.log("✅ 鉴权生效（无 token → 401）")

	const authorized = await requestStatus(`http://127.0.0.1:${config.proxyPort}/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: MCP_INIT,
	})
	if (authorized !== 200) throw new Error(`鉴权后的 MCP initialize 失败（HTTP ${authorized}）`)

	const reset = runTailscale(["funnel", "reset"])
	if (reset.status !== 0) throw new Error("无法清理现有 Tailscale Funnel 配置")
	const funnel = runTailscale(["funnel", "--bg", String(config.proxyPort)], "inherit")
	if (funnel.status !== 0) throw new Error("Tailscale Funnel 启动失败；可能有旧的前台 Funnel 占用 443")
	funnelStarted = true

	const status = runTailscale(["funnel", "status", "--json"], "pipe")
	const statusText = status.stdout || ""
	if (status.status !== 0 || !statusText.includes(`http://127.0.0.1:${config.proxyPort}`)) {
		throw new Error(`Funnel 启动后未指向 127.0.0.1:${config.proxyPort}`)
	}
	console.log(`✅ Funnel 已指向 ${config.proxyPort}`)
	console.log("\n保持此终端运行，按 Ctrl+C 停止")
	await waitUntilStopped()
}

try {
	await main()
} catch (err) {
	console.error(`❌ ${err.message || err}`)
	process.exitCode = 1
} finally {
	await cleanup()
}
