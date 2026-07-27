#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, appendFile } from "node:fs/promises"
import { request } from "node:http"
import { createRequire } from "node:module"
import { createConnection } from "node:net"
import { dirname, join } from "node:path"

import { getLauncherConfig, MCP_ROOT } from "./config.mjs"

const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
const config = getLauncherConfig(platform)
const UP_LOG_FILE = join(MCP_ROOT, "up.log")
const require = createRequire(import.meta.url)

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

// ponytail: 固定 5 秒重试足够抑制刷屏，也不会永久放弃服务；真有大规模部署再做退避。
const RESTART_DELAY_MS = 5_000

let funnelStarted = false
let cleaned = false
let shuttingDown = false

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function logLine(line) {
	const stamped = `[${new Date().toISOString()}] ${line}`
	console.log(stamped)
	appendFile(UP_LOG_FILE, stamped + "\n").catch(() => {})
}

function logError(line) {
	const stamped = `[${new Date().toISOString()}] ${line}`
	console.error(stamped)
	appendFile(UP_LOG_FILE, stamped + "\n").catch(() => {})
}

function readToken() {
	if (platform === "macos") {
		const result = spawnSync(
			"security",
			["find-generic-password", "-a", process.env.USER || "", "-s", config.tokenService, "-w"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		)
		if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
		throw new Error("读不到 macOS 钥匙串 token")
	}

	return config.token
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

async function waitForHealthy(child, url, attempts = 30) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (child.spawnError || child.exitCode !== null) return false
		if ((await requestStatus(url)) !== 0) return true
		await sleep(500)
	}
	return false
}

function spawnRaw(name, command, args) {
	const child = spawn(command, args, {
		stdio: "inherit",
		env: process.env,
		windowsHide: true,
		detached: platform !== "windows",
	})
	child.serviceName = name
	child.spawnError = null
	child.intentionalStop = false
	child.once("error", (err) => {
		child.spawnError = err
		logError(`❌ ${name} 启动失败：${err.message}`)
	})
	return child
}

function runTailscale(args, stdio = "ignore") {
	return spawnSync(config.tailscalePath, args, { encoding: "utf8", stdio })
}

function killChild(child) {
	if (!child || child.spawnError || child.exitCode !== null || !child.pid) return
	child.intentionalStop = true
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

class SupervisedService {
	constructor({ name, factory, healthUrl, verify }) {
		this.name = name
		this.factory = factory
		this.healthUrl = healthUrl
		this.verify = verify
		this.child = null
		this.stopped = false
		this.restarting = false
	}

	async start() {
		const [command, args] = this.factory()
		this.child = spawnRaw(this.name, command, args)
		this._watchExit()
		const healthy = await waitForHealthy(this.child, this.healthUrl)
		if (!healthy) throw new Error(`${this.name} 未通过健康检查`)
		if (this.verify) await this.verify()
		this.child.ready = true
	}

	_watchExit() {
		const child = this.child
		child.once("exit", (code, signal) => {
			if (!child.ready || child.intentionalStop || shuttingDown) return
			logError(`⚠️ ${this.name} 意外退出（code=${code} signal=${signal}）`)
			this._restart()
		})
	}

	async _restart() {
		if (this.restarting) return
		this.restarting = true
		while (!this.stopped && !shuttingDown) {
			logLine(`${this.name} 将在 ${RESTART_DELAY_MS}ms 后自动重启`)
			await sleep(RESTART_DELAY_MS)
			if (this.stopped || shuttingDown) return
			try {
				await this.start()
				logLine(`✅ ${this.name} 已自动恢复`)
				this.restarting = false
				return
			} catch (err) {
				killChild(this.child)
				logError(`❌ ${this.name} 重启失败：${err.message || err}`)
			}
		}
		this.restarting = false
	}

	stop() {
		this.stopped = true
		killChild(this.child)
	}
}

const services = []

async function cleanup() {
	if (cleaned) return
	cleaned = true
	if (services.length || funnelStarted) logLine("关闭中…")
	for (const service of services.slice().reverse()) service.stop()
	if (funnelStarted) {
		try {
			runTailscale(["funnel", "reset"])
		} catch {}
	}
}

function waitUntilStopped() {
	return new Promise((resolve) => {
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			process.off("SIGINT", onInterrupt)
			process.off("SIGTERM", onTerminate)
			resolve()
		}
			const onInterrupt = () => {
			shuttingDown = true
			finish()
		}
		const onTerminate = () => {
			shuttingDown = true
			finish()
		}
		process.once("SIGINT", onInterrupt)
		process.once("SIGTERM", onTerminate)
	})
}

function buildGatewayCommand() {
	let packageFile
	try {
		packageFile = require.resolve("supergateway/package.json")
	} catch {
		throw new Error("缺少 supergateway，请先在仓库根目录执行 npm install")
	}
	const packageConfig = JSON.parse(readFileSync(packageFile, "utf8"))
	const supergatewayBin = join(dirname(packageFile), packageConfig.bin.supergateway)
	const execServer = join(MCP_ROOT, "lib", "exec-server.mjs")
	const stdioCommand = `node "${execServer.replaceAll('"', '\\"')}"`
	const args = [
		supergatewayBin,
		"--stdio",
		stdioCommand,
		"--outputTransport",
		"streamableHttp",
		"--port",
		String(config.upstreamPort),
	]
	return [process.execPath, args]
}

async function verifyGatewayFunctional() {
	const status = await requestStatus(`http://127.0.0.1:${config.upstreamPort}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: MCP_INIT,
	})
	if (status !== 200) throw new Error(`${config.upstreamPort} 的 MCP initialize 失败（HTTP ${status}）`)
}

async function verifyProxyFunctional(token) {
	const unauthorized = await requestStatus(`http://127.0.0.1:${config.proxyPort}/mcp`)
	if (unauthorized !== 401) throw new Error(`鉴权检查失败（无 token 返回 HTTP ${unauthorized}）`)
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
}

async function main() {
	if (config.proxyPort === config.upstreamPort) throw new Error("代理端口和后端端口不能相同")
	if (await portInUse(config.upstreamPort)) throw new Error(`端口 ${config.upstreamPort} 已被占用，停止启动以避免复用旧进程`)
	if (await portInUse(config.proxyPort)) throw new Error(`端口 ${config.proxyPort} 已被占用，停止启动以避免复用旧进程`)

	const token = readToken()
	await mkdir(config.sandboxDir, { recursive: true })
	process.env.MCP_TOKEN = token
	process.env.MCP_SANDBOX_DIR = config.sandboxDir

	const gatewayService = new SupervisedService({
		name: "supergateway",
		factory: buildGatewayCommand,
		healthUrl: `http://127.0.0.1:${config.upstreamPort}/mcp`,
		verify: verifyGatewayFunctional,
	})
	services.push(gatewayService)
	await gatewayService.start()
	logLine(`✅ ${config.upstreamPort} 起来了`)

	const proxyService = new SupervisedService({
		name: "auth-proxy",
		factory: () => [process.execPath, [join(MCP_ROOT, "lib", "auth-proxy.mjs")]],
		healthUrl: `http://127.0.0.1:${config.proxyPort}/mcp`,
		verify: () => verifyProxyFunctional(token),
	})
	services.push(proxyService)
	await proxyService.start()
	logLine(`✅ ${config.proxyPort} 起来了`)
	logLine("✅ 鉴权生效（无 token → 401）")

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
	logLine(`✅ Funnel 已指向 ${config.proxyPort}`)

	logLine("ℹ️ supergateway 与 auth-proxy 意外退出后会自动重启")
	console.log("\n保持此终端运行，按 Ctrl+C 停止")
	await waitUntilStopped()
}

try {
	await main()
} catch (err) {
	logError(`❌ ${err.message || err}`)
	process.exitCode = 1
} finally {
	await cleanup()
}
