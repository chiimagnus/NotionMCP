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
//   钥匙串，绝不要写进 Notion 页面、代码仓库或聊天记录）。
// - 每次 run_command 调用都会追加写入仓库根目录下的 exec.log（时间戳 +
//   命令 + 退出码），纯粹用于自己审计/排查问题，不是安全防线，不会
//   阻止或拖慢执行。

import { send } from "./rpc.mjs"
import { SANDBOX_DIR, SKILLS_ROOT } from "./config.mjs"
import { definitions, handlers } from "../tools/index.mjs"

// 全局提示词：随 initialize 响应一次性交给客户端模型，让它不用每次都重新探索这个 server 的使用方式。
const SERVER_INSTRUCTIONS = `这个 MCP 提供 4 个工具：run_command（执行命令）、apply_patch（编辑文件）、read_image（读图片）、load_skills（加载技能）。

- 这不是严格沙盒：cwd/path 只是默认工作目录，绝对路径、cd 切换等仍可越界访问沙盒目录（${SANDBOX_DIR}）之外的文件。
- run_command 和 apply_patch 会自动检测目标目录及其所有上级目录里的 AGENTS.md 开发规范文件，首次访问某个目录时会把找到的内容追加在工具返回结果末尾（同一目录几小时内不会重复提示）。遇到项目时留意这部分内容，不需要再手动查找、读取 AGENTS.md。
- 可用技能已经列在 load_skills 工具自身的 description 里（技能根目录：${SKILLS_ROOT}），按技能 key 调用 load_skills 即可获取某个技能完整的 SKILL.md 内容与所在目录。
- 执行模型训练等长耗时命令时，记得调大 run_command 的 timeoutMs 参数。`

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
				serverInfo: { name: "exec-server", version: "1.5.0" },
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
