// lib/rpc.mjs
// Shared stdio JSON-RPC helper.

export function send(msg) {
	if (!process.stdout.writable || process.stdout.destroyed) return false
	return process.stdout.write(JSON.stringify(msg) + "\n")
}
