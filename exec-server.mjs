#!/usr/bin/env node
// exec-server.mjs
// Zero-dependency MCP server (stdio transport). Tool implementations live in
// ./tools/*.mjs (one file per tool) and shared helpers live in ./lib/*.mjs —
// see README.md for the full file layout.
//
// Currently exposes:
//   1. run_command  — run arbitrary shell commands on this Mac.
//   2. read_image   — read an image file back as viewable image content.
//   3. apply_patch  — batch create/update/delete files via structured ops.
//
// SECURITY NOTE (read this before exposing it to the internet):
// - This is NOT a hard sandbox. `cwd` is only a *default* working directory,
//   not an enforced boundary. A command like `cd / && rm -rf ...` or any
//   absolute path will still execute outside the sandbox folder. Same goes
//   for read_image's `path` — it can point anywhere on disk.
// - The only thing standing between "anyone on the internet" and "arbitrary
//   code execution on this Mac" is the bearer token checked by auth-proxy.mjs
//   in front of this server. Keep that token secret (keychain only, never in
//   Notion pages, repos, or chat logs).
// - Every run_command call is appended to exec.log in this repo's root (timestamp +
//   command + exit code) purely for your own audit/debugging. This is NOT a
//   safety gate; it does not block or slow down execution.

import { send } from "./lib/rpc.mjs"
import { definitions, handlers } from "./tools/index.mjs"

let buffer = ""
process.stdin.on("data", (chunk) => {
	buffer += chunk
	let idx
	while ((idx = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, idx)
		buffer = buffer.slice(idx + 1)
		if (line.trim()) handleLine(line)
	}
})

async function handleLine(line) {
	let msg
	try {
		msg = JSON.parse(line)
	} catch {
		return
	}
	const { id, method, params } = msg

	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "exec-server", version: "1.3.0" },
			},
		})
		return
	}
	if (method === "notifications/initialized" || method === "ping") {
		if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} })
		return
	}
	if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools: definitions } })
		return
	}
	if (method === "tools/call") {
		const { name, arguments: args } = params || {}
		const handler = handlers[name]
		if (!handler) {
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } })
			return
		}
		try {
			const result = await handler(args)
			send({ jsonrpc: "2.0", id, result })
		} catch (err) {
			send({
				jsonrpc: "2.0",
				id,
				result: { content: [{ type: "text", text: `Error: ${err}` }], isError: true },
			})
		}
		return
	}
	if (id !== undefined) {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } })
	}
}

process.stdin.resume()
