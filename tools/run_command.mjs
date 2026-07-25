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
	title: "执行命令",
	description:
		"在这台 Mac 上执行一条 shell 命令（通过 /bin/sh -c 执行）。默认工作目录是 " +
		SANDBOX_DIR +
		"。注意：这不是一个严格的沙盒环境——命令仍然可以访问工作目录之外的路径（例如绝对路径、`cd ..` 等）。可用于运行 python/pip、编辑文件、生成图片/SVG、跑训练脚本，以及其他任意命令行任务。",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", description: "要执行的 shell 命令。" },
			cwd: { type: "string", description: "可选，相对于沙盒文件夹的子目录。" },
			timeoutMs: {
				type: "number",
				description: `可选，超时时间（毫秒，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}）。执行模型训练等长耗时任务时可以调大这个值。`,
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
