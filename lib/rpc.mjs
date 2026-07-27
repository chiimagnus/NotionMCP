// lib/rpc.mjs
// Shared stdio JSON-RPC helpers: send a message and truncate long command output.

import { MAX_OUTPUT_CHARS } from "./config.mjs"

export function send(msg) {
	if (!process.stdout.writable || process.stdout.destroyed) return false
	return process.stdout.write(JSON.stringify(msg) + "\n")
}

export function truncate(s) {
	if (s.length <= MAX_OUTPUT_CHARS) return s
	return (
		s.slice(0, MAX_OUTPUT_CHARS) +
		`\n...[truncated, ${s.length - MAX_OUTPUT_CHARS} more chars]`
	)
}
