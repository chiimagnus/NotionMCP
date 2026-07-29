#!/usr/bin/env node

import { runCommand } from "../lib/service-manager.mjs"
import { createTailscaleManager } from "../lib/tailscale.mjs"
import { diagnose } from "../lib/doctor.mjs"

const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
const command = process.argv[2] || "help"
const publicUrlIndex = process.argv.indexOf("--public-url")
const publicUrl = publicUrlIndex < 0 ? undefined : process.argv[publicUrlIndex + 1]
const dryRun = process.argv.includes("--dry-run")

function print(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`)
}

function summary(result) {
	return `local=${result.local.state} funnel=${result.funnel.state} public=${result.public.state}`
}

async function configAndTailscale() {
	const { getLauncherConfig } = await import("../lib/config.mjs")
	const config = getLauncherConfig(platform)
	return { config, tailscale: createTailscaleManager({ path: config.tailscalePath, run: runCommand }) }
}

if (command === "start") {
	await import("../lib/up.mjs")
} else if (command === "status") {
	const { config, tailscale } = await configAndTailscale()
	const status = await tailscale.status(config.port)
	print(status)
	process.exitCode = status.state === "ready" ? 0 : 1
} else if (command === "doctor") {
	const { config, tailscale } = await configAndTailscale()
	const result = await diagnose({ port: config.port, tailscale, publicUrl })
	print(result)
	process.stderr.write(`${summary(result)}\n`)
	process.exitCode = result.ok ? 0 : 1
} else if (command === "install" || command === "uninstall") {
	const { config } = await configAndTailscale()
	const { installPlatformService, uninstallPlatformService } = await import("../lib/platform-services.mjs")
	print(await (command === "install" ? installPlatformService(config, { dryRun }) : uninstallPlatformService(config, { dryRun })))
} else {
	process.stdout.write("Usage: notionmcp <start|status|doctor [--public-url URL]|install|uninstall [--dry-run]>\n")
	process.exitCode = command === "help" ? 0 : 2
}
