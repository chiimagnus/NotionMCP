import { appendFileSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG_FILE = (() => {
	const configured = process.env.MCP_LOG_FILE || "mcp.log"
	return isAbsolute(configured) ? configured : resolve(ROOT, configured)
})()
const MAX_ENTRY_BYTES = 8 * 1024
const MAX_LOG_BYTES = 10 * 1024 * 1024
const BACKUP_FILE = `${LOG_FILE}.1`
const SECRETS = new Set(
	Object.entries(process.env)
		.filter(([key, value]) => /^MCP_TOKEN_/.test(key) && value)
		.map(([, value]) => value),
)
const FIELD_NAMES = new Set([
	"outcome",
	"code",
	"elapsedMs",
	"timedOut",
	"cancelled",
	"count",
	"errorType",
	"tool",
	"operation",
	"mimeType",
	"status",
	"port",
	"reason",
	"signal",
	"message",
	"stack",
	"stderr",
])

function truncateUtf8(text, maxBytes, fromEnd = false) {
	const encoded = Buffer.from(text)
	if (encoded.length <= maxBytes) return text
	const marker = "…[truncated]"
	const available = maxBytes - Buffer.byteLength(marker)
	const decoder = new TextDecoder("utf-8", { fatal: true })
	for (let length = available; length > 0; length -= 1) {
		const chunk = fromEnd ? encoded.subarray(encoded.length - length) : encoded.subarray(0, length)
		try {
			return fromEnd ? `${marker}${decoder.decode(chunk)}` : `${decoder.decode(chunk)}${marker}`
		} catch {}
	}
	return marker
}

function redact(value) {
	let text = String(value)
	for (const secret of SECRETS) text = text.replaceAll(secret, "[REDACTED]")
	return text.replace(/Bearer\s+[0-9a-fA-F]{64}/g, "Bearer [REDACTED]")
}

function safeString(value, field) {
	const limits = {
		message: 1536,
		stack: 3072,
		stderr: 1536,
		errorType: 128,
		tool: 128,
		operation: 128,
		mimeType: 128,
		outcome: 128,
		reason: 256,
		signal: 64,
	}
	return truncateUtf8(redact(value), limits[field] || 256, field === "stderr")
}

function entry(level, scope, event, fields) {
	const safeFields = {}
	for (const [key, value] of Object.entries(fields || {})) {
		if (!FIELD_NAMES.has(key) || !["string", "number", "boolean"].includes(typeof value)) continue
		safeFields[key] = typeof value === "string" ? safeString(value, key) : value
	}
	const error = fields?.error
	if (error) {
		safeFields.errorType = safeString(error.name || "Error", "errorType")
		safeFields.message = safeString(error.message || error, "message")
		if (error.stack) safeFields.stack = safeString(error.stack, "stack")
		if (error.stderr) safeFields.stderr = safeString(error.stderr, "stderr")
	}
	const record = {
		time: new Date().toISOString(),
		level,
		scope: safeString(scope, "scope"),
		event: safeString(event, "event"),
		...safeFields,
	}
	let serialized = JSON.stringify(record)
	if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES - 1) {
		record.message = record.message && truncateUtf8(record.message, 512)
		record.stack = record.stack && truncateUtf8(record.stack, 1024)
		record.stderr = record.stderr && truncateUtf8(record.stderr, 512, true)
		record.truncated = true
		serialized = JSON.stringify(record)
	}
	return `${serialized}\n`
}

function currentSize() {
	try {
		return statSync(LOG_FILE).size
	} catch (err) {
		if (err.code === "ENOENT") return 0
		throw err
	}
}

function removeBackup() {
	try {
		unlinkSync(BACKUP_FILE)
	} catch (err) {
		if (err.code !== "ENOENT") throw err
	}
}

function pruneOversizedBackup() {
	try {
		if (statSync(BACKUP_FILE).size > MAX_LOG_BYTES) unlinkSync(BACKUP_FILE)
	} catch (err) {
		if (err.code !== "ENOENT") throw err
	}
}

function rotate(size) {
	removeBackup()
	if (size > MAX_LOG_BYTES) {
		unlinkSync(LOG_FILE)
		return
	}
	renameSync(LOG_FILE, BACKUP_FILE)
}

export function registerLogSecret(value) {
	if (typeof value === "string" && value) SECRETS.add(value)
}

// ponytail: 单进程同步写入让轮转天然串行；出现多进程或集中日志需求时再换日志系统。
export function log(level, scope, event, fields = {}) {
	try {
		const line = entry(level, scope, event, fields)
		const size = currentSize()
		pruneOversizedBackup()
		if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) rotate(size)
		appendFileSync(LOG_FILE, line, "utf8")
	} catch {
		// 日志故障不能反过来终止 MCP。
		console.error("诊断日志写入失败")
	}
}
