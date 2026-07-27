#!/usr/bin/env node
// test/epipe-selftest.mjs
// 回归自检：客户端断开（stdout 管道被关掉）之后，exec-server 绝不能自杀。
//
// 背景：stdout 是 JSON-RPC 传输通道。以前它上面没有 "error" 监听器，客户端一取消请求，
// write 抛出的 EPIPE 就会被 Node 升级成 uncaughtException → fatal() 主动 process.exit(1)
// → supergateway 作为父进程跟着退 → up.mjs 重启风暴 → 8 次后熔断 → 只能人工重启。
// exec.log 里留下过两次 "timedOut=true" 紧跟 "FATAL uncaughtException: EPIPE" 的记录。
//
// 跑法：node test/epipe-selftest.mjs   （通过时 exit 0）

import { spawn } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const LOG_FILE = join(ROOT, "exec.log")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(msg, extra) {
	console.error(`\u274c 自检失败：${msg}`)
	if (extra) console.error(extra)
	process.exit(1)
}

// 只看本次新增的日志，避免误读历史记录
const logBytesBefore = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0

const child = spawn(process.execPath, [join(ROOT, "lib", "exec-server.mjs")], {
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, MCP_SANDBOX_DIR: process.env.MCP_SANDBOX_DIR || ROOT },
})

let stderrText = ""
let stdoutText = ""
child.stderr.on("data", (d) => (stderrText += d))
child.stdout.on("data", (d) => (stdoutText += d))

const send = (msg) => {
	try {
		child.stdin.write(JSON.stringify(msg) + "\n")
	} catch {}
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
await sleep(1000)

if (child.exitCode !== null) fail(`initialize 之后进程就退出了（code=${child.exitCode}）`, stderrText)
if (!stdoutText.includes("exec-server")) fail("initialize 没拿到正常响应", `实际收到：${stdoutText.slice(0, 300)}\n${stderrText}`)

// 关掉读端 —— 等价于客户端取消请求 / supergateway 断开。之后每次 send() 都会撞上 EPIPE。
child.stdout.destroy()
await sleep(200)

// tools/list 的响应体较大，多发几条，确保真的写进管道而不是停在缓冲区里
for (let i = 2; i <= 6; i += 1) send({ jsonrpc: "2.0", id: i, method: "tools/list" })
await sleep(2000)

if (child.exitCode !== null) {
	fail(`stdout 关闭后进程自杀了（code=${child.exitCode}）—— EPIPE 又变回致命错误了`, stderrText)
}

const newLog = existsSync(LOG_FILE) ? readFileSync(LOG_FILE).subarray(logBytesBefore).toString("utf8") : ""
const evidence = newLog
	.split("\n")
	.filter((l) => /stdout 已关闭|CLIENT_GONE|send 失败/.test(l))

if (/FATAL uncaughtException/.test(newLog)) {
	child.kill()
	fail("日志里出现了 FATAL uncaughtException —— 兜底没生效", newLog.slice(-800))
}

child.kill()

// 进程活着还不够 —— 得确认真的触发过写入失败，否则这一跑什么也没验证到。
if (evidence.length === 0) {
	console.error("\u26a0\ufe0f 进程确实活着，但日志里没看到 EPIPE 降级记录。")
	console.error("   本次没能真正触发写入失败（可能是平台管道语义差异），不能算通过。")
	console.error(`   本次新增日志：\n${newLog.slice(-800)}`)
	process.exit(1)
}

console.log("\u2705 自检通过：stdout 被关闭后 exec-server 仍存活，EPIPE 已降级为日志，未升级为致命错误")
for (const line of evidence.slice(0, 3)) console.log(`   证据：${line.trim()}`)
process.exit(0)
