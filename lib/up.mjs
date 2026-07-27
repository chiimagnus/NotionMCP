#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { log, registerLogSecret } from "./log.mjs"

const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
let lifecycle
let config
let funnelOwned = false
let cleanupPromise = null
let stopReason = null

function tailscale(args) {
	return spawnSync(config.tailscalePath, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	})
}

function forwardTailscaleOutput(result) {
	if (result.stdout) process.stdout.write(result.stdout)
	if (result.stderr) process.stderr.write(result.stderr)
}

function tailscaleError(action, result) {
	const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status ?? "unknown"}`
	const error = new Error(`${action}：${detail}`)
	error.stderr = result.stderr || ""
	return error
}

function readMacToken() {
	const result = spawnSync(
		"security",
		["find-generic-password", "-a", process.env.USER || "", "-s", config.tokenService, "-w"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
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
		if (lifecycle) {
			try {
				await lifecycle.shutdown(stopReason || "cleanup")
			} catch (error) {
				console.error(`HTTP 关闭失败：${error?.message || error}`)
				log("error", "launcher", "http_shutdown_failed", { error })
			}
		}
		if (funnelOwned) {
			const reset = tailscale(["funnel", "reset"])
			forwardTailscaleOutput(reset)
			if (reset.status !== 0) {
				const error = tailscaleError("Tailscale Funnel reset 失败，请手动执行 tailscale funnel reset", reset)
				console.error(error.message)
				log("error", "launcher", "funnel_reset_failed", { error })
			}
			funnelOwned = false
		}
	})()
	return cleanupPromise
}

async function main() {
	if (typeof AbortSignal.any !== "function") throw new Error("需要 Node.js 20.11 或更高版本")
	const configModule = await import("./config.mjs")
	config = configModule.getLauncherConfig(platform)
	const token = configModule.validateToken(
		platform === "macos" ? readMacToken() : config.token,
		platform === "macos" ? "macOS Keychain token" : `MCP_TOKEN_${platform.toUpperCase()}`,
	)
	registerLogSecret(token)
	const { createMcpHttpServer } = await import("./mcp-http.mjs")

	await mkdir(config.sandboxDir, { recursive: true })
	lifecycle = createMcpHttpServer({ port: config.port, token })
	await lifecycle.listen()
	console.log(`✅ MCP 已在 127.0.0.1:${config.port}/mcp 启动`)

	const funnel = tailscale(["funnel", "--bg", String(config.port)])
	forwardTailscaleOutput(funnel)
	if (funnel.status !== 0) throw tailscaleError("Tailscale Funnel 启动失败", funnel)
	funnelOwned = true
	log("info", "launcher", "funnel_started")
	console.log(`✅ Funnel 已指向 ${config.port}`)
	console.log("\n保持此终端运行，按 Ctrl+C 停止")

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
