#!/usr/bin/env node
// exec-server.mjs
// Zero-dependency MCP server (stdio transport) exposing ONE tool: run_command.
// It runs arbitrary shell commands on this Mac.
//
// SECURITY NOTE (read this before exposing it to the internet):
// - This is NOT a hard sandbox. `cwd` is only a *default* working directory,
//   not an enforced boundary. A command like `cd / && rm -rf ...` or any
//   absolute path will still execute outside the sandbox folder.
// - The only thing standing between "anyone on the internet" and "arbitrary
//   code execution on this Mac" is the bearer token checked by auth-proxy.mjs
//   in front of this server. Keep that token secret (keychain only, never in
//   Notion pages, repos, or chat logs).
// - Every command is appended to ~/.mcp/exec.log (timestamp + command + exit
//   code) purely for your own audit/debugging. This is NOT a safety gate; it
//   does not block or slow down execution.

import { spawn } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const SANDBOX_DIR =
	process.env.MCP_SANDBOX_DIR || join(homedir(), "Github_OpenSource", "AI-Share")
const LOG_FILE = join(homedir(), ".mcp", "exec.log")
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 3_600_000 // 1 hour ceiling; pass timeoutMs to raise up to this
const MAX_OUTPUT_CHARS = 100_000

function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n")
}

function log(line) {
	appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`).catch(() => {})
}

function truncate(s) {
	if (s.length <= MAX_OUTPUT_CHARS) return s
	return (
		s.slice(0, MAX_OUTPUT_CHARS) +
		`\n...[truncated, ${s.length - MAX_OUTPUT_CHARS} more chars]`
	)
}

function runCommand({ command, cwd, timeoutMs }) {
	return new Promise((resolve) => {
		if (!command || typeof command !== "string") {
			resolve({ code: -1, stdout: "", stderr: "Missing required 'command' string", timedOut: false })
			return
		}
		const workDir = cwd ? join(SANDBOX_DIR, cwd) : SANDBOX_DIR
		const timeout = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
		let child
		try {
			child = spawn("/bin/sh", ["-c", command], { cwd: workDir, env: process.env })
		} catch (err) {
			resolve({ code: -1, stdout: "", stderr: String(err), timedOut: false })
			return
		}
		let stdout = ""
		let stderr = ""
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeout)
		child.stdout.on("data", (d) => (stdout += d))
		child.stderr.on("data", (d) => (stderr += d))
		child.on("close", (code) => {
			clearTimeout(timer)
			log(`cmd=${JSON.stringify(command)} cwd=${JSON.stringify(workDir)} exit=${code} timedOut=${timedOut}`)
			resolve({ code, stdout: truncate(stdout), stderr: truncate(stderr), timedOut })
		})
		child.on("error", (err) => {
			clearTimeout(timer)
			resolve({ code: -1, stdout, stderr: String(err), timedOut: false })
		})
	})
}

const tools = [
	{
		name: "run_command",
		description:
			"Run a shell command on this Mac (executed via /bin/sh -c). Default working directory is " +
			SANDBOX_DIR +
			". This is NOT a hard sandbox \u2014 commands can still reach paths outside the working directory (absolute paths, `cd ..`, etc). Use for running python/pip, editing files, generating images/SVGs, training scripts, and any other command-line task.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run." },
				cwd: { type: "string", description: "Optional subdirectory relative to the sandbox folder." },
				timeoutMs: {
					type: "number",
					description: `Optional timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). Raise this for long-running jobs like model training.`,
				},
			},
			required: ["command"],
		},
	},
]

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
				serverInfo: { name: "exec-server", version: "1.0.0" },
			},
		})
		return
	}
	if (method === "notifications/initialized" || method === "ping") {
		if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} })
		return
	}
	if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools } })
		return
	}
	if (method === "tools/call") {
		const { name, arguments: args } = params || {}
		if (name !== "run_command") {
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } })
			return
		}
		try {
			const result = await runCommand(args || {})
			const text = `exit code: ${result.code}${result.timedOut ? " (timed out, process killed)" : ""}\n\n--- stdout ---\n${result.stdout}\n\n--- stderr ---\n${result.stderr}`
			send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })
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
