import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { runCommand } from "./service-manager.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LABEL = "com.notionmcp"

function platform() {
	return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
}

function quoteSystemd(value) {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function xml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
}

export function servicePaths(kind, home = homedir(), root = ROOT) {
	if (kind === "macos") return { template: "launchd.plist", file: join(home, "Library", "LaunchAgents", `${LABEL}.plist`) }
	if (kind === "windows") return { template: "windows-task.xml", file: join(root, ".notionmcp", "notionmcp-task.xml") }
	return { template: "systemd-user.service", file: join(home, ".config", "systemd", "user", "notionmcp.service") }
}

export async function renderPlatformService({ kind = platform(), home, nodePath = process.execPath, root = ROOT, logPath = join(ROOT, "mcp-service.log") } = {}) {
	const paths = servicePaths(kind, home, root)
	const source = await readFile(join(ROOT, "templates", paths.template), "utf8")
	const values = kind === "windows"
		? { NODE: xml(nodePath), CLI: xml(join(root, "bin", "notionmcp.mjs")), ROOT: xml(root), LOG: xml(logPath) }
		: kind === "linux"
			? { NODE: quoteSystemd(nodePath), CLI: quoteSystemd(join(root, "bin", "notionmcp.mjs")), ROOT: quoteSystemd(root), LOG: quoteSystemd(logPath) }
			: { NODE: xml(nodePath), CLI: xml(join(root, "bin", "notionmcp.mjs")), ROOT: xml(root), LOG: xml(logPath) }
	return { file: paths.file, content: source.replace(/{{(NODE|CLI|ROOT|LOG)}}/g, (_, key) => values[key]) }
}

export function serviceBytes(kind, content) {
	return kind === "windows" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]) : content
}

export async function installPlatformService(config, { kind = platform(), home, root, run = runCommand, dryRun = false } = {}) {
	const service = await renderPlatformService({ kind, home, root })
	if (dryRun) return { action: "install", dryRun: true, file: service.file, content: service.content, platform: kind, port: config.port }
	await mkdir(dirname(service.file), { recursive: true })
	await writeFile(service.file, serviceBytes(kind, service.content))
	if (kind === "linux") {
		const reload = await run("systemctl", ["--user", "daemon-reload"])
		if (reload.status !== 0) throw new Error(`重载 systemd 失败：${reload.stderr || reload.error?.message || reload.status}`)
	}
	if (kind === "macos") await run("launchctl", ["bootout", `gui/${process.getuid()}`, service.file])
	const args = kind === "macos" ? ["bootstrap", `gui/${process.getuid()}`, service.file] : kind === "windows" ? ["/Create", "/TN", "NotionMCP", "/XML", service.file, "/F"] : ["--user", "enable", "--now", "notionmcp.service"]
	const command = kind === "macos" ? "launchctl" : kind === "windows" ? "schtasks.exe" : "systemctl"
	const result = await run(command, args)
	if (result.status !== 0) throw new Error(`安装服务失败：${result.stderr || result.error?.message || result.status}`)
	return { action: "installed", file: service.file, platform: kind, port: config.port }
}

export async function uninstallPlatformService(config, { kind = platform(), home, root, run = runCommand, dryRun = false } = {}) {
	const service = servicePaths(kind, home, root)
	if (dryRun) return { action: "uninstall", dryRun: true, file: service.file, platform: kind, port: config.port }
	const args = kind === "macos" ? ["bootout", `gui/${process.getuid()}`, service.file] : kind === "windows" ? ["/Delete", "/TN", "NotionMCP", "/F"] : ["--user", "disable", "--now", "notionmcp.service"]
	const command = kind === "macos" ? "launchctl" : kind === "windows" ? "schtasks.exe" : "systemctl"
	const result = await run(command, args)
	if (result.status !== 0) throw new Error(`卸载服务失败：${result.stderr || result.error?.message || result.status}`)
	await rm(service.file, { force: true })
	if (kind === "linux") await run("systemctl", ["--user", "daemon-reload"])
	return { action: "uninstalled", file: service.file, platform: kind, port: config.port }
}
