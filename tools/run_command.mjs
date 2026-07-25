// tools/run_command.mjs
// The `run_command` tool: run an arbitrary shell command on this Mac.
//
// SECURITY NOTE: this is NOT a hard sandbox. `cwd` is only a *default*
// working directory, not an enforced boundary. Absolute paths, `cd ..`, etc.
// can still reach outside SANDBOX_DIR. The only real gate is the bearer
// token checked by auth-proxy.mjs in front of this server.

import { spawn } from "node:child_process"
import { join } from "node:path"
import { SANDBOX_DIR, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../lib/config.mjs"
import { log, truncate } from "../lib/rpc.mjs"

export const name = "run_command"

export const definition = {
	name,
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

export async function call(args) {
	const result = await runCommand(args || {})
	const text = `exit code: ${result.code}${result.timedOut ? " (timed out, process killed)" : ""}\n\n--- stdout ---\n${result.stdout}\n\n--- stderr ---\n${result.stderr}`
	return { content: [{ type: "text", text }] }
}
