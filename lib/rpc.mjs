// lib/rpc.mjs
// Shared stdio JSON-RPC helpers: send a message, append to the audit log,
// and truncate long command output.

import { appendFile } from "node:fs/promises"
import { LOG_FILE, MAX_OUTPUT_CHARS } from "./config.mjs"

export function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n")
}

export function log(line) {
	appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`).catch(() => {})
}

export function truncate(s) {
	if (s.length <= MAX_OUTPUT_CHARS) return s
	return (
		s.slice(0, MAX_OUTPUT_CHARS) +
		`\n...[truncated, ${s.length - MAX_OUTPUT_CHARS} more chars]`
	)
}
