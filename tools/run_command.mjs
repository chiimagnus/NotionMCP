// tools/run_command.mjs
// The `run_command` tool: run an arbitrary command in the local platform shell.
//
// SECURITY NOTE: this is NOT a hard sandbox. `cwd` is only a *default*
// working directory, not an enforced boundary. Absolute paths, `cd ..`, etc.
// can still reach outside SANDBOX_DIR. The only real gate is the bearer
// token checked by auth-proxy.mjs in front of this server.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { SANDBOX_DIR, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../lib/config.mjs"
import { log, truncate } from "../lib/rpc.mjs"
import { resolvePath } from "../lib/paths.mjs"
import { getAgentsMdBlock } from "../lib/agentsMd.mjs"

// ponytail: 查一次 pwsh.exe 的位置：先查 PATH，再查 PowerShell 7 MSI 的固定安装目录。
// 这个函数本身只做“查找”，不在模块加载时（import 阶段）调用——找不到 pwsh 时
// 只应该让 run_command 这一次调用报错，不应该炸掉整个 exec-server 进程，否则
// read_image / apply_patch / load_skills 这三个跟 pwsh 毫无关系的工具也会全部
// 跟着不可用。
function resolveWindowsShell() {
	const candidates = (process.env.PATH || "")
		.split(delimiter)
		.filter(Boolean)
		.map((dir) => join(dir, "pwsh.exe"))
	candidates.push("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { path: candidate, label: "PowerShell 7" }
	}
	throw new Error("Windows requires PowerShell 7 (pwsh.exe); install it and retry the command")
}

let cachedShell = null

// 懒解析 + 缓存：第一次成功后复用结果；找不到时每次调用都重新尝试（用户可能
// 在两次调用之间装好了 PowerShell 7），但绝不抛出到调用方之外。
function getShell() {
	if (process.platform !== "win32") return { path: "/bin/sh", label: "/bin/sh" }
	if (cachedShell) return cachedShell
	cachedShell = resolveWindowsShell()
	return cachedShell
}

function describeShellForHumans() {
	if (process.platform !== "win32") return "/bin/sh"
	try {
		return resolveWindowsShell().label
	} catch {
		return "PowerShell 7（当前未检测到，调用 run_command 时会报错，不影响其他工具）"
	}
}

const SHELL_LABEL = describeShellForHumans()

export const name = "run_command"

export const definition = {
	name,
	title: "执行命令",
	description:
		`在这台机器上通过 ${SHELL_LABEL} 执行一条命令。默认工作目录是 ` +
		SANDBOX_DIR +
		"。注意：这不是一个严格的沙盒环境——命令仍然可以访问工作目录之外的路径（例如绝对路径、切换目录等）。可用于运行 python/pip、编辑文件、生成图片/SVG、跑训练脚本，以及其他任意命令行任务。",
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
		let shell
		try {
			shell = getShell()
		} catch (err) {
			resolve({ code: -1, stdout: "", stderr: String(err.message || err), timedOut: false })
			return
		}
		const workDir = cwd ? resolvePath(cwd) : SANDBOX_DIR
		const timeout = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
		let child
		try {
			const winCommand =
				process.platform === "win32"
					? `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $PSDefaultParameterValues['*:Encoding'] = 'utf8'; ${command}`
					: command
			const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", winCommand] : ["-c", command]
			// ponytail: 同一类编码问题的另一半——Python 在 ACP=936 的机器上往管道打印中文会直接
			// 抛 UnicodeEncodeError，这两个环境变量一次性免掉，比每条命令自己 set 靠得住。
			child = spawn(shell.path, args, { cwd: workDir, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } })
		} catch (err) {
			resolve({ code: -1, stdout: "", stderr: String(err), timedOut: false })
			return
		}
		let stdout = ""
		let stderr = ""
		let timedOut = false
		// 用 StringDecoder 做增量解码，避免多字节 UTF-8 字符（比如中文）
		// 刚好被拆分在两个 data 分片之间时产生乱码。
		const stdoutDecoder = new StringDecoder("utf8")
		const stderrDecoder = new StringDecoder("utf8")
		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeout)
		child.stdout.on("data", (d) => (stdout += stdoutDecoder.write(d)))
		child.stderr.on("data", (d) => (stderr += stderrDecoder.write(d)))
		child.on("close", (code) => {
			clearTimeout(timer)
			stdout += stdoutDecoder.end()
			stderr += stderrDecoder.end()
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
	const cwdArg = args && args.cwd
	const workDir = cwdArg ? resolvePath(cwdArg) : SANDBOX_DIR
	const result = await runCommand(args || {})
	const agentsMdBlock = getAgentsMdBlock(workDir)
	const text = `exit code: ${result.code}${result.timedOut ? " (timed out, process killed)" : ""}\n\n--- stdout ---\n${result.stdout}\n\n--- stderr ---\n${result.stderr}${agentsMdBlock}`
	return { content: [{ type: "text", text }] }
}
