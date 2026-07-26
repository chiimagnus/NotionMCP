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

// ponytail: shell 以前硬编码 powershell.exe，装了 PS 7 也永远用不上。这里在模块加载时解析
// 一次：先在 PATH 里找 pwsh.exe，再兜底查 MSI 的固定安装目录（刚装完 PS 7 时本进程的 PATH
// 还是旧的，只靠 PATH 会漏）。PS 7 默认全程 UTF-8 无 BOM，读写两侧的编码问题整类消失。
function resolveWindowsShell() {
	const candidates = (process.env.PATH || "")
		.split(delimiter)
		.filter(Boolean)
		.map((dir) => join(dir, "pwsh.exe"))
	candidates.push("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { path: candidate, label: "PowerShell 7" }
	}
	return { path: "powershell.exe", label: "Windows PowerShell 5.1" }
}

const SHELL = process.platform === "win32" ? resolveWindowsShell() : { path: "/bin/sh", label: "/bin/sh" }

export const name = "run_command"

export const definition = {
	name,
	title: "执行命令",
	description:
		`在这台机器上通过 ${SHELL.label} 执行一条命令。默认工作目录是 ` +
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
		const workDir = cwd ? resolvePath(cwd) : SANDBOX_DIR
		const timeout = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
		let child
		try {
			const shell = SHELL.path
			// Windows PowerShell 5.1 非交互模式下默认按系统 ANSI 代码页（如 936/GBK）编码输出，
			// 而我们这边用 StringDecoder("utf8") 硬解，导致中文等多字节字符乱码。这里强制该子
			// 进程的控制台输出、以及发给原生程序的编码都用 UTF-8，从根上解决乱码问题。
			// ponytail: 光设 [Console]::OutputEncoding 不够——它只管“写出去”那一侧。PS 5.1 里
			// Get-Content 这类读文件的 cmdlet 默认按系统 ANSI 代码页（中文机器是 936/GBK）去解码
			// 无 BOM 的 UTF-8 文件，字符串进内存时就已经是乱码了，之后再怎么正确输出也救不回来。
			// 所以这里必须额外把读取类 cmdlet 的默认 -Encoding 也钉成 utf8。
			// PS 7 起 '*:Encoding' 连写文件都是无 BOM UTF-8，可以一把全设；5.1 若给写入类 cmdlet
			// 设 utf8 反而会写出 BOM，所以 5.1 只设读取类。
			// 另：Encoding::UTF8 自带 BOM preamble，用它当 $OutputEncoding 会给管道传给原生程序的
			// 输入多塞 EF BB BF，必须用 UTF8Encoding::new($false)。
			const winCommand =
				process.platform === "win32"
					? `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; if ($PSVersionTable.PSVersion.Major -ge 6) { $PSDefaultParameterValues['*:Encoding'] = 'utf8' } else { $PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'; $PSDefaultParameterValues['Select-String:Encoding'] = 'utf8'; $PSDefaultParameterValues['Import-Csv:Encoding'] = 'utf8' }; ${command}`
					: command
			const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", winCommand] : ["-c", command]
			// ponytail: 同一类编码问题的另一半——Python 在 ACP=936 的机器上往管道打印中文会直接
			// 抛 UnicodeEncodeError，这两个环境变量一次性免掉，比每条命令自己 set 靠得住。
			child = spawn(shell, args, { cwd: workDir, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } })
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
