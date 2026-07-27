// lib/rpc.mjs
// Shared stdio JSON-RPC helpers: send a message, append to the audit log,
// and truncate long command output.

import { appendFile } from "node:fs/promises"
import { LOG_FILE, MAX_OUTPUT_CHARS } from "./config.mjs"

// stdout 是 JSON-RPC 的传输通道。客户端（supergateway）取消请求或断开时管道会被关闭，
// 此后任何 write 都会异步抛出 EPIPE。Node 在流没有 "error" 监听器时会把它升级成
// uncaughtException，于是 exec-server 的 fatal() 会主动 process.exit(1)，supergateway
// 作为父进程跟着退出，up.mjs 进入重启风暴，8 次后熔断，最终只能人工重启整条链路。
//
// 「客户端不听了」是完全可预期的正常情况，绝不应该打死服务端。这里把它降级成一行日志。
// 这个监听器必须在模块加载时就装上（而不是等第一次 send），否则中间窗口期的
// EPIPE 依旧会变成 uncaughtException。
process.stdout.on("error", (err) => {
	const code = err && err.code
	if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
		log(`stdout 已关闭（${code}），客户端可能已取消请求或断开；忽略，进程继续运行`)
		return
	}
	log(`stdout 写入失败：${err && err.stack ? err.stack : err}`)
})

export function send(msg) {
	// 流已销毁时 write 也可能同步抛出，上面的 "error" 监听器接不到，所以这里再包一层。
	try {
		process.stdout.write(JSON.stringify(msg) + "\n")
	} catch (err) {
		log(`send 失败（客户端可能已断开）：${err && err.code ? err.code : err}`)
	}
}

export function log(line) {
	appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`).catch(() => {})
}

export function truncate(s) {
	if (s.length <= MAX_OUTPUT_CHARS) return s
	return (
		s.slice(0, MAX_OUTPUT_CHARS) +
		`\n...[truncated, ${s.length - MAX_OUTPUT_CHARS} more chars]`
	)
}
