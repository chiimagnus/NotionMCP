#!/usr/bin/env node
// exec-server.mjs
// 零依赖 MCP 服务器（stdio 传输）。工具实现放在 ../tools/*.mjs（一个工具一个文件），
// 公共辅助函数放在当前目录的 *.mjs —— 完整文件结构说明见 README.md。
//
// 当前暴露的工具：
//   1. run_command  — 在这台机器上执行任意平台命令。
//   2. read_image   — 读取图片文件，返回可查看的图像内容。
//   3. apply_patch  — 通过结构化操作批量新建/修改/删除文件。
//   4. load_skills  — 按 key 加载 codex skills 目录下某个技能的完整内容。
//
// 安全提示（暴露到公网之前务必先读这段）：
// - 这不是一个严格的沙盒。`cwd` 只是*默认*工作目录，不是强制边界；
//   类似 `cd / && rm -rf ...` 这样的命令，或任何绝对路径，仍然可以在
//   沙盒目录之外执行。read_image 的 `path` 同理，可以指向磁盘上任意位置。
// - “公网上的任何人”和“在这台机器上任意执行代码”之间，唯一的屏障
//   就是 auth-proxy.mjs 校验的那个 bearer token。请把它保管好（只放
//   macOS 钥匙串或本机 .env，绝不要写进 Notion 页面、代码仓库或聊天记录）。
// - 每次 run_command / apply_patch / load_skills / read_image 调用都会追加写入仓库
//   根目录下的 exec.log；任何工具抛出未被自己处理的异常时，也会在这里记录完整
//   堆栈（tool=... -> ERROR: ...）。纯粹用于自己审计/排查问题，不是安全防线，
//   不会阻止或拖慢执行。
//
// 健壮性提示：
// - 顶层意外错误会留下日志并结束当前 stdio 会话；supergateway 后续会话会创建
//   新进程。tools/call 内的普通工具错误仍只返回给调用方，不会结束会话。

import { send, log } from "./rpc.mjs"
import {
	SANDBOX_DIR,
	SKILLS_ROOT,
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	MAX_OUTPUT_CHARS,
	DEFAULT_IMAGE_MAX_SIZE,
	MAX_IMAGE_MAX_SIZE,
} from "./config.mjs"
import { definitions, handlers } from "../tools/index.mjs"

// 全局提示词：随 initialize 响应一次性交给客户端模型，让它不用每次都重新探索这个 server 的使用方式。
const SERVER_INSTRUCTIONS = `这个 MCP 提供 4 个工具：run_command（执行命令）、apply_patch（编辑文件）、read_image（读图片）、load_skills（加载技能）。

- 这不是严格沙盒：cwd/path 只是默认工作目录，绝对路径、cd 切换等仍可越界访问沙盒目录（${SANDBOX_DIR}）之外的文件。
- ⚠️ 绝对不要用宽口径的进程操作批量杀进程——即任何按进程名一刀切的做法，macOS/Linux 上的 \`pkill -f node\`、\`killall node\`，Windows 上的 \`taskkill /IM node.exe\`、\`Get-Process node | Stop-Process\` 都算。这个 MCP 自身就跑在本机的 node 进程上（up.mjs / supergateway / auth-proxy / exec-server），误杀会当场掐断正在使用的连接。确实要清理某个进程时：先用完整命令行（而不是进程名）精确匹配到具体 PID，显式排除命令行里含 up.mjs / supergateway / auth-proxy / exec-server 的进程，再逐个结束。
- 会长时间运行的后台服务（本地代理、调试浏览器等）要在后台启动，并把 stdout/stderr 重定向到文件；否则继承的管道会让 run_command 一直等不到 EOF。
- 改文件优先用 apply_patch 的 oldStr/newStr 精确替换，不要在 run_command 里靠 shell 拼接内容写文件（bash/zsh 的 heredoc、echo/printf 重定向，PowerShell 的 here-string、Set-Content 都算）——后者容易因为引号转义、变量展开、换行符与编码差异写出乱码甚至写坏文件。
- run_command 的 stdout/stderr 超过约 ${MAX_OUTPUT_CHARS} 字符会被截断；长输出（如大量日志）建议自己重定向到文件后再分段读取，不要指望一次性拿到完整内容。
- read_image 默认按最长边 ${DEFAULT_IMAGE_MAX_SIZE}px 缩放，最大不超过 ${MAX_IMAGE_MAX_SIZE}px。
- run_command 和 apply_patch 会自动检测目标目录及其所有上级目录里的 AGENTS.md 开发规范文件，首次访问某个目录时会把找到的内容追加在工具返回结果末尾（同一目录几小时内不会重复提示）；多份 AGENTS.md 同时命中时，越靠近目标目录的排在越后面，可视为对上层规范的覆盖/细化。遇到项目时留意这部分内容，不需要再手动查找、读取 AGENTS.md。
- 可用技能已经列在 load_skills 工具自身的 description 里（技能根目录：${SKILLS_ROOT}），按技能 key 调用 load_skills 即可获取某个技能完整的 SKILL.md 内容与所在目录。
- 执行模型训练等长耗时命令时，记得调大 run_command 的 timeoutMs 参数（默认 ${DEFAULT_TIMEOUT_MS}ms，最大 ${MAX_TIMEOUT_MS}ms）。`

// 顶层异常兜底：记录清晰日志后退出当前 stdio 会话。
// 绝不能往 stdout 写任何东西（stdout 是 JSON-RPC 传输通道），只能用 stderr/日志文件。
function fatal(kind, err) {
	const detail = err && err.stack ? err.stack : String(err)
	console.error(`❌ exec-server ${kind}：\n${detail}`)
	log(`FATAL ${kind}: ${detail}`)
	setTimeout(() => process.exit(1), 50)
}
process.on("uncaughtException", (err) => fatal("uncaughtException", err))
process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason))

// stdout 断开表示这个 stdio 客户端已经无法接收任何后续结果。结束当前会话，
// 让 supergateway 按会话重新创建；继续运行只会制造一个永远写不出去的孤儿进程。
process.stdout.on("error", (err) => {
	if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") {
		fatal("stdout error", err)
		return
	}
	process.exit(0)
})

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
				serverInfo: { name: "exec-server", version: "1.6.0" },
				instructions: SERVER_INSTRUCTIONS,
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
			const detail = err && err.stack ? err.stack : String(err)
			log(`tool=${name} args=${JSON.stringify(args)} -> ERROR: ${detail}`)
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

// ponytail: 无状态网关每个 HTTP 请求创建一个 stdio 进程；EOF 就是正常请求结束。
process.stdin.once("end", () => process.exit(0))
process.stdin.resume()
