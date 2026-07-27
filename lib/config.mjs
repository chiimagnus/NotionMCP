// lib/config.mjs
// Shared configuration loaded from the repository's .env file.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
export const MCP_ROOT = dirname(MODULE_DIR)
export const CONFIG_FILE = resolve(process.env.MCP_CONFIG_FILE || join(MCP_ROOT, ".env"))

function currentPlatform() {
	if (process.platform === "win32") return "windows"
	if (process.platform === "darwin") return "macos"
	if (process.platform === "linux") return "linux"
	throw new Error(`不支持的平台：${process.platform}`)
}

function stripComment(line) {
	let quote = null
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i]
		if ((char === '"' || char === "'") && line[i - 1] !== "\\") {
			quote = quote === char ? null : quote || char
		} else if (char === "#" && !quote) {
			return line.slice(0, i)
		}
	}
	return line
}

// ponytail: 这里只支持本项目需要的 KEY=VALUE；配置语法变复杂时再引入 dotenv。
function parseValue(raw, lineNumber) {
	const value = raw.trim()
	if (!value) throw new Error(`配置文件第 ${lineNumber} 行缺少值`)
	if (value.startsWith('"') || value.endsWith('"')) {
		if (!(value.startsWith('"') && value.endsWith('"'))) {
			throw new Error(`配置文件第 ${lineNumber} 行的双引号值未闭合`)
		}
	}
	if (value.startsWith("'") || value.endsWith("'")) {
		if (!(value.startsWith("'") && value.endsWith("'"))) {
			throw new Error(`配置文件第 ${lineNumber} 行的单引号值未闭合`)
		}
	}
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			return JSON.parse(value)
		} catch {
			throw new Error(`配置文件第 ${lineNumber} 行的双引号值无效`)
		}
	}
	if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
	return value
}

function parseEnv(content) {
	const values = {}
	for (const [index, original] of content.split(/\r?\n/).entries()) {
		const line = stripComment(original).trim()
		if (!line) continue
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
		if (!match) throw new Error(`配置文件第 ${index + 1} 行不是 KEY=VALUE 格式`)
		const [, key, rawValue] = match
		if (key in values) throw new Error(`配置文件重复定义 ${key}`)
		values[key] = parseValue(rawValue, index + 1)
	}
	return values
}

function readConfig() {
	let content
	try {
		content = readFileSync(CONFIG_FILE, "utf8")
	} catch (err) {
		throw new Error(`无法读取配置文件 ${CONFIG_FILE}: ${err.message}`)
	}
	return parseEnv(content)
}

const values = readConfig()

// 内部默认值不暴露为 .env 选项，避免把开发者旋钮交给普通用户。
const INTERNAL_DEFAULTS = {
	MCP_TAILSCALE_PATH_LINUX: "tailscale",
	MCP_TAILSCALE_PATH_MACOS: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
	MCP_TAILSCALE_PATH_WINDOWS: "tailscale.exe",
	MCP_DEFAULT_TIMEOUT_MS: 120_000,
	MCP_MAX_TIMEOUT_MS: 3_600_000,
	MCP_MAX_OUTPUT_CHARS: 100_000,
	MCP_DEFAULT_IMAGE_MAX_SIZE: 1024,
	MCP_MAX_IMAGE_MAX_SIZE: 2000,
}

function rawValue(key) {
	return process.env[key] ?? values[key] ?? INTERNAL_DEFAULTS[key]
}

function stringValue(key) {
	const value = rawValue(key)
	if (typeof value !== "string" || !value.trim()) throw new Error(`配置缺少 ${key}`)
	return value.trim()
}

export function validateToken(token, source = "Token") {
	if (typeof token !== "string" || !/^[0-9a-fA-F]{64}$/.test(token)) {
		throw new Error(`${source} 必须是 64 位十六进制字符串`)
	}
	if (/^([0-9a-fA-F])\1{63}$/.test(token)) throw new Error(`${source} 不能全部使用同一字符`)
	return token
}

function platformTokenValue(platform) {
	const key = `MCP_TOKEN_${platform.toUpperCase()}`
	return validateToken(stringValue(key), key)
}

function numberValue(key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
	const raw = rawValue(key)
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`配置 ${key} 必须是 ${min} 到 ${max} 之间的整数`)
	}
	return value
}

function expandHome(value) {
	if (value === "~") return homedir()
	if (value.startsWith("~/")) return join(homedir(), value.slice(2))
	return value
}

function configuredPath(key) {
	return expandHome(stringValue(key))
}

function launcherConfig(platform) {
	if (platform !== "linux" && platform !== "macos" && platform !== "windows") {
		throw new Error(`不支持的平台配置：${platform}`)
	}
	return {
		sandboxDir: configuredPath(`MCP_SANDBOX_DIR_${platform.toUpperCase()}`),
		skillsDir: configuredPath(`MCP_SKILLS_DIR_${platform.toUpperCase()}`),
		port: numberValue("MCP_PORT", { max: 65535 }),
		tailscalePath: configuredPath(`MCP_TAILSCALE_PATH_${platform.toUpperCase()}`),
		...(platform === "macos" ? { tokenService: "mcp-token" } : { token: platformTokenValue(platform) }),
	}
}

export function getLauncherConfig(platform = currentPlatform()) {
	return launcherConfig(platform)
}

const activeConfig = launcherConfig(currentPlatform())

export const SANDBOX_DIR = activeConfig.sandboxDir
export const SKILLS_ROOT = activeConfig.skillsDir
export const DEFAULT_TIMEOUT_MS = numberValue("MCP_DEFAULT_TIMEOUT_MS")
export const MAX_TIMEOUT_MS = numberValue("MCP_MAX_TIMEOUT_MS")
export const MAX_OUTPUT_CHARS = numberValue("MCP_MAX_OUTPUT_CHARS")
export const DEFAULT_IMAGE_MAX_SIZE = numberValue("MCP_DEFAULT_IMAGE_MAX_SIZE")
export const MAX_IMAGE_MAX_SIZE = numberValue("MCP_MAX_IMAGE_MAX_SIZE")

export const RASTER_MIME_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
}
