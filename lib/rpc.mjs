// lib/rpc.mjs
// Shared stdio JSON-RPC helpers: send a message, append to the audit log,
// and truncate long command output.

import { appendFileSync } from "node:fs"
import { LOG_FILE, MAX_OUTPUT_CHARS } from "./config.mjs"

export function send(msg) {
	if (!process.stdout.writable || process.stdout.destroyed) return false
	return process.stdout.write(JSON.stringify(msg) + "\n")
}

// 进程退出路径也要留下最后一条审计记录；失败不能反过来打死服务。
export function log(line) {
	try {
		appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
	} catch {}
}

export function truncate(s) {
	if (s.length <= MAX_OUTPUT_CHARS) return s
	return (
		s.slice(0, MAX_OUTPUT_CHARS) +
		`\n...[truncated, ${s.length - MAX_OUTPUT_CHARS} more chars]`
	)
}
