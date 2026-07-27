import { appendFileSync, renameSync, statSync, unlinkSync } from "node:fs"
import { LOG_FILE } from "./config.mjs"

const MAX_ENTRY_BYTES = 8 * 1024
const MAX_LOG_BYTES = 10 * 1024 * 1024
const BACKUP_FILE = `${LOG_FILE}.1`
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
])

function truncateUtf8(text, maxBytes) {
	const encoded = Buffer.from(text)
	if (encoded.length <= maxBytes) return text
	const marker = "…[truncated]"
	let end = maxBytes - Buffer.byteLength(marker)
	const decoder = new TextDecoder("utf-8", { fatal: true })
	while (end > 0) {
		try {
			return decoder.decode(encoded.subarray(0, end)) + marker
		} catch {
			end -= 1
		}
	}
	return marker
}

function entry(scope, event, fields) {
	const safeFields = {}
	for (const [key, value] of Object.entries(fields || {})) {
		if (!FIELD_NAMES.has(key) || !["string", "number", "boolean"].includes(typeof value)) continue
		safeFields[key] = value
	}
	const record = {
		time: new Date().toISOString(),
		scope: String(scope),
		event: String(event),
		...safeFields,
	}
	let serialized = JSON.stringify(record)
	if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES - 1) {
		for (const [key, value] of Object.entries(safeFields)) {
			if (typeof value === "string") record[key] = "…[truncated]"
		}
		record.scope = truncateUtf8(record.scope, 256)
		record.event = truncateUtf8(record.event, 256)
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

// ponytail: 单进程同步写入让轮转天然串行；出现多进程或集中日志需求时再换日志系统。
export function auditLog(scope, event, fields = {}) {
	const line = entry(scope, event, fields)
	try {
		const size = currentSize()
		pruneOversizedBackup()
		if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) rotate(size)
		appendFileSync(LOG_FILE, line, "utf8")
	} catch {
		// 文件异常时宁可丢一条审计记录，也不能让日志反过来打死服务或无界增长。
		console.error("审计日志写入失败")
	}
}
