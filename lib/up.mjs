#!/usr/bin/env node

import { log, registerLogSecret } from "./log.mjs"
import { runCommand, startService, stopService } from "./service-manager.mjs"
import { createTailscaleManager } from "./tailscale.mjs"

const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
let lifecycle
let tailscale
let cleanupPromise
let stopReason

async function readMacToken(config) {
	const result = await runCommand(
		"security",
		["find-generic-password", "-a", process.env.USER || "", "-s", config.tokenService, "-w"],
	)
	if (result.status !== 0 || !result.stdout.trim()) throw new Error("读不到 macOS 钥匙串 token")
	return result.stdout.trim()
}

function waitForSignal() {
	let dispose
	const promise = new Promise((resolve) => {
		const finish = (signal) => {
			dispose()
			resolve({ signal })
		}
		const onInterrupt = () => finish("SIGINT")
		const onTerminate = () => finish("SIGTERM")
		dispose = () => {
			process.off("SIGINT", onInterrupt)
			process.off("SIGTERM", onTerminate)
		}
		process.once("SIGINT", onInterrupt)
		process.once("SIGTERM", onTerminate)
	})
	return { promise, dispose: () => dispose?.() }
}

function cleanup() {
	if (cleanupPromise) return cleanupPromise
	cleanupPromise = (async () => {
		if (!lifecycle) return
		try {
			await stopService({
				lifecycle,
				disableFunnel: () => tailscale.disableMcpFunnel(),
				reason: stopReason || "cleanup",
			})
		} catch (error) {
			console.error(`服务关闭失败：${error?.message || error}`)
			log("error", "launcher", "service_shutdown_failed", { error })
		}
	})()
	return cleanupPromise
}

async function main() {
	if (typeof AbortSignal.any !== "function") throw new Error("需要 Node.js 20.11 或更高版本")
	const configModule = await import("./config.mjs")
	const config = configModule.getLauncherConfig(platform)
	const token = configModule.validateToken(
		platform === "macos" ? await readMacToken(config) : config.token,
		platform === "macos" ? "macOS Keychain token" : `MCP_TOKEN_${platform.toUpperCase()}`,
	)
	registerLogSecret(token)
	const { createMcpHttpServer } = await import("./mcp-http.mjs")
	tailscale = createTailscaleManager({ path: config.tailscalePath, run: runCommand })

	const service = await startService({
		sandboxDir: config.sandboxDir,
		port: config.port,
		token,
		createServer: createMcpHttpServer,
		ensureFunnel: (port) => tailscale.ensureMcpFunnel(port),
	})
	lifecycle = service.lifecycle
	console.log(`✅ MCP 已在 127.0.0.1:${config.port}/mcp 启动`)
	console.log("✅ Funnel 仅暴露 MCP 路径：/mcp、/mcp/sse、/mcp/messages")
	if (service.funnel.status.publicUrl) console.log(`✅ Notion MCP URL：${service.funnel.status.publicUrl}`)
	else console.log("⚠️ Funnel 已配置但 URL 尚未就绪；运行 npm run status 获取地址")
	console.log("\n保持此终端运行，按 Ctrl+C 停止")
	log("info", "launcher", "funnel_ready", { outcome: service.funnel.status.state })

	const signal = waitForSignal()
	const outcome = await Promise.race([signal.promise, lifecycle.unexpected.then((error) => ({ error }))])
	signal.dispose()
	if (outcome.error) {
		stopReason = "http_server_failed"
		throw outcome.error
	}
	stopReason = outcome.signal
	log("info", "launcher", "stopping", { reason: stopReason, signal: outcome.signal })
}

process.on("uncaughtExceptionMonitor", (error, origin) => {
	log("error", "process", "uncaught_exception", { error, reason: origin })
})

try {
	await main()
} catch (error) {
	stopReason ||= lifecycle ? "runtime_failed" : "startup_failed"
	console.error(`❌ ${error?.message || error}`)
	log("error", "launcher", "failed", { error, reason: stopReason })
	process.exitCode = 1
} finally {
	await cleanup()
	log("info", "launcher", "stopped", { reason: stopReason || "completed" })
}
