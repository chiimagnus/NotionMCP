#!/usr/bin/env node

import { readFileSync, statSync, existsSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, appendFile } from "node:fs/promises"
import { request } from "node:http"
import { createConnection } from "node:net"
import { dirname, join } from "node:path"

import { getLauncherConfig, MCP_ROOT } from "./config.mjs"

const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
const config = getLauncherConfig(platform)
const UP_LOG_FILE = join(MCP_ROOT, "up.log")

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

// 崩溃重启策略：短时间内反复崩溃视为无法自愈的致命故障，停止重试并退出整条
// 链路（避免无限重启刷屏/刷日志）；长时间健康运行后会重置计数，避免偶发的
// 一次抖动被累计计入“崩溃循环”。
const MAX_CONSECUTIVE_RESTARTS = 8
const RESTART_BACKOFF_BASE_MS = 1_000
const RESTART_BACKOFF_MAX_MS = 30_000
const HEALTHY_RESET_AFTER_MS = 5 * 60_000

let funnelStarted = false
let cleaned = false
let shuttingDown = false
let fatalError = null
let requestStop = () => {}
let recycleTimer = null
let recycling = false

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
	const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
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

// ---------------------------------------------------------------------------
// SupervisedService：管理一个子进程的完整生命周期——启动、健康检查、以及在它
// 意外退出后按退避策略自动重启。取代旧版“任何子进程一死，整条链路立刻退出，
// 需要用户手动重新执行 up.ps1/up.sh”的策略。
// ---------------------------------------------------------------------------
class SupervisedService {
	constructor({ name, factory, healthUrl, verify }) {
		this.name = name
		this.factory = factory
		this.healthUrl = healthUrl
		this.verify = verify
		this.child = null
		this.stopped = false
		this.restartCount = 0
		this.healthyTimer = null
	}

	async start() {
		const [command, args] = this.factory()
		this.child = spawnRaw(this.name, command, args)
		this._watchExit()
		const healthy = await waitForHealthy(this.child, this.healthUrl)
		if (!healthy) throw new Error(`${this.name} 未通过健康检查`)
		if (this.verify) await this.verify()
		this._armHealthyResetTimer()
	}

	_armHealthyResetTimer() {
		clearTimeout(this.healthyTimer)
		this.healthyTimer = setTimeout(() => {
			if (this.restartCount > 0) logLine(`ℹ️ ${this.name} 已稳定运行 5 分钟，重置崩溃计数`)
			this.restartCount = 0
		}, HEALTHY_RESET_AFTER_MS)
		this.healthyTimer.unref?.()
	}

	_watchExit() {
		const child = this.child
		child.once("exit", (code, signal) => {
			if (child.intentionalStop || shuttingDown) return
			logError(`⚠️ ${this.name} 意外退出（code=${code} signal=${signal}）`)
			this._scheduleRestart()
		})
	}

	async _scheduleRestart() {
		clearTimeout(this.healthyTimer)
		this.restartCount += 1
		if (this.restartCount > MAX_CONSECUTIVE_RESTARTS) {
			fatalError = new Error(`${this.name} 在短时间内反复崩溃（超过 ${MAX_CONSECUTIVE_RESTARTS} 次），停止自动重启`)
			logError(`❌ ${fatalError.message}`)
			requestStop()
			return
		}
		const backoffMs = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_BASE_MS * 2 ** (this.restartCount - 1))
		logLine(`${this.name} 将在 ${backoffMs}ms 后自动重启（第 ${this.restartCount} 次）`)
		await sleep(backoffMs)
		if (this.stopped || shuttingDown) return
		try {
			await this.start()
			logLine(`✅ ${this.name} 已自动恢复`)
		} catch (err) {
			logError(`❌ ${this.name} 重启失败：${err.message || err}`)
			await this._scheduleRestart()
		}
	}

	// 用于定期回收：主动停掉旧进程再重新拉起一个新的，规避长时间运行后可能
	// 出现的会话/孤儿子进程积累（对应 supergateway 上游 issue #141）。
	async restartForRecycle() {
		clearTimeout(this.healthyTimer)
		killChild(this.child)
		await sleep(500)
		await this.start()
	}

	stop() {
		this.stopped = true
		clearTimeout(this.healthyTimer)
		killChild(this.child)
	}
}

const services = []

async function cleanup() {
	if (cleaned) return
	cleaned = true
	if (recycleTimer) clearInterval(recycleTimer)
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
		requestStop = finish
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
	const execServer = join(MCP_ROOT, "lib", "exec-server.mjs")
	const stdioCommand = `node "${execServer.replaceAll('"', '\\"')}"`
	const hasLocalSupergateway = existsSync(join(MCP_ROOT, "node_modules", "supergateway"))
	if (!hasLocalSupergateway) {
		logError(
			"⚠️ 未检测到本地安装的 supergateway（node_modules 里没有），将通过 `npx -y` 联网拉取，更慢也更容易受网络波动影响。建议在仓库根目录执行一次 `npm install` 固定版本。",
		)
	}
	const npxArgs = [
		hasLocalSupergateway ? "--no-install" : "-y",
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
	]
	const npx = platform === "windows" ? process.env.ComSpec || "cmd.exe" : "npx"
	const args = platform === "windows" ? ["/d", "/c", "npx.cmd", ...npxArgs] : npxArgs
	return [npx, args]
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

async function recycleServices(gatewayService, proxyService) {
	if (recycling || shuttingDown) return
	recycling = true
	try {
		logLine("⏱ 定期回收 supergateway / auth-proxy，规避长时间运行后的会话/孤儿进程积累（上游 supergateway 已知问题）")
		await proxyService.restartForRecycle()
		await gatewayService.restartForRecycle()
		logLine("✅ 定期回收完成")
	} catch (err) {
		logError(`❌ 定期回收失败：${err.message || err}，将由崩溃自动重启逻辑接管`)
	} finally {
		recycling = false
	}
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

	if (config.recycleIntervalMs > 0) {
		recycleTimer = setInterval(() => {
			recycleServices(gatewayService, proxyService)
		}, config.recycleIntervalMs)
		recycleTimer.unref?.()
		logLine(`ℹ️ 已启用定期回收（每 ${Math.round(config.recycleIntervalMs / 60_000)} 分钟一次），可用 MCP_RECYCLE_INTERVAL_MS=0 关闭`)
	}

	logLine("ℹ️ supergateway 与 auth-proxy 已启用自动重启监督：任意一个意外退出都会按退避策略自动恢复，不再需要手动重新执行 up.ps1/up.sh")
	console.log("\n保持此终端运行，按 Ctrl+C 停止")
	await waitUntilStopped()
	if (fatalError) throw fatalError
}

try {
	await main()
} catch (err) {
	logError(`❌ ${err.message || err}`)
	process.exitCode = 1
} finally {
	await cleanup()
}
