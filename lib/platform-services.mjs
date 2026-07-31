import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, posix } from "node:path"
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

// ponytail: process.getuid 只在真实 macOS/Linux 上存在。kind 是参数化的（测试会在 Windows 主机上
// 也构造 kind: "macos" 来验证命令形状，实际 OS 命令由注入的 run 模拟，不会真执行），所以
// 不能直接调 process.getuid()；真实 macOS 上行为不变，其它平台上回退到占位值。
function currentUid() {
	return typeof process.getuid === "function" ? process.getuid() : 0
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
	// ponytail: Windows 任务定义里的 CLI 路径是写进 XML 文本的内容，不是真实文件系统调用；
	// 固定用 posix.join 拼接，让结果不受“渲染这份服务定义的实际运行平台”影响（比如在 macOS/Linux
	// 上为 Windows 目标生成服务定义，或反过来）；正斜杠在 Windows 路径里也能正常被识别。
	const values = kind === "windows"
		? { NODE: xml(nodePath), CLI: xml(posix.join(root, "bin", "notionmcp.mjs")), ROOT: xml(root), LOG: xml(logPath) }
		: kind === "linux"
			? { NODE: quoteSystemd(nodePath), CLI: quoteSystemd(join(root, "bin", "notionmcp.mjs")), ROOT: quoteSystemd(root), LOG: quoteSystemd(logPath) }
			: { NODE: xml(nodePath), CLI: xml(join(root, "bin", "notionmcp.mjs")), ROOT: xml(root), LOG: xml(logPath) }
	return { file: paths.file, content: source.replace(/{{(NODE|CLI|ROOT|LOG)}}/g, (_, key) => values[key]) }
}

export function serviceBytes(kind, content) {
	return kind === "windows" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]) : content
}

async function serviceDefinitionExists(path) {
	try {
		await stat(path)
		return true
	} catch (error) {
		if (error?.code === "ENOENT") return false
		throw error
	}
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
	if (kind === "macos") await run("launchctl", ["bootout", `gui/${currentUid()}`, service.file])
	const args = kind === "macos" ? ["bootstrap", `gui/${currentUid()}`, service.file] : kind === "windows" ? ["/Create", "/TN", "NotionMCP", "/XML", service.file, "/F"] : ["--user", "enable", "--now", "notionmcp.service"]
	const command = kind === "macos" ? "launchctl" : kind === "windows" ? "schtasks.exe" : "systemctl"
	const result = await run(command, args)
	if (result.status !== 0) throw new Error(`安装服务失败：${result.stderr || result.error?.message || result.status}`)
	return { action: "installed", file: service.file, platform: kind, port: config.port }
}

export async function uninstallPlatformService(config, { kind = platform(), home, root, run = runCommand, dryRun = false } = {}) {
	const service = servicePaths(kind, home, root)
	if (dryRun) return { action: "uninstall", dryRun: true, file: service.file, platform: kind, port: config.port }
	if (!(await serviceDefinitionExists(service.file))) {
		return { action: "uninstalled", file: service.file, platform: kind, port: config.port }
	}
	const args = kind === "macos" ? ["bootout", `gui/${currentUid()}`, service.file] : kind === "windows" ? ["/Delete", "/TN", "NotionMCP", "/F"] : ["--user", "disable", "--now", "notionmcp.service"]
	const command = kind === "macos" ? "launchctl" : kind === "windows" ? "schtasks.exe" : "systemctl"
	const result = await run(command, args)
	if (result.status !== 0) throw new Error(`卸载服务失败：${result.stderr || result.error?.message || result.status}`)
	await rm(service.file, { force: true })
	if (kind === "linux") await run("systemctl", ["--user", "daemon-reload"])
	return { action: "uninstalled", file: service.file, platform: kind, port: config.port }
}
