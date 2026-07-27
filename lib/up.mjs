#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { mkdir } from "node:fs/promises"

const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
let lifecycle
let config
let log
let funnelOwned = false
let cleanupPromise = null

function tailscale(args, stdio = "ignore") {
	return spawnSync(config.tailscalePath, args, {
		encoding: "utf8",
		stdio,
		windowsHide: true,
	})
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
				await lifecycle.shutdown()
			} catch (error) {
				console.error(`HTTP 关闭失败：${error?.message || error}`)
			}
		}
		if (funnelOwned) {
			const reset = tailscale(["funnel", "reset"], "inherit")
			if (reset.status !== 0) console.error("Tailscale Funnel reset 失败，请手动执行 tailscale funnel reset")
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
	const logModule = await import("./log.mjs")
	log = logModule.log
	logModule.registerLogSecret(token)
	const { createMcpHttpServer } = await import("./mcp-http.mjs")

	await mkdir(config.sandboxDir, { recursive: true })
	lifecycle = createMcpHttpServer({ port: config.port, token })
	await lifecycle.listen()
	log("info", "launcher", "http_started")
	console.log(`✅ MCP 已在 127.0.0.1:${config.port}/mcp 启动`)

	const funnel = tailscale(["funnel", "--bg", String(config.port)], "inherit")
	if (funnel.status !== 0) throw new Error("Tailscale Funnel 启动失败")
	funnelOwned = true
	log("info", "launcher", "funnel_started")
	console.log(`✅ Funnel 已指向 ${config.port}`)
	console.log("\n保持此终端运行，按 Ctrl+C 停止")

	const signal = waitForSignal()
	const outcome = await Promise.race([signal.promise, lifecycle.unexpected.then((error) => ({ error }))])
	signal.dispose()
	if (outcome.error) throw outcome.error
}

try {
	await main()
} catch (error) {
	console.error(`❌ ${error?.message || error}`)
	log?.("error", "launcher", "failed", { error })
	process.exitCode = 1
} finally {
	await cleanup()
}
