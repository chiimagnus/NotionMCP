import assert from "node:assert/strict"
import test from "node:test"

import { runCommand, startService, stopService } from "../lib/service-manager.mjs"
import { createTailscaleManager } from "../lib/tailscale.mjs"

const PORT = 8123
const TARGET = `http://127.0.0.1:${PORT}/mcp`
const LEGACY_TARGET = `http://127.0.0.1:${PORT}`

function status({ path = "/mcp", target = TARGET, allowed = true } = {}) {
	return {
		status: 0,
		stdout: JSON.stringify({
			Web: { "host.example.ts.net:443": { Handlers: path ? { [path]: { Proxy: target } } : {} } },
			AllowFunnel: { "host.example.ts.net:443": allowed },
		}),
		stderr: "",
	}
}

function fakeRunner(results) {
	const calls = []
	return {
		calls,
		run: async (path, args) => {
			calls.push({ path, args })
			return results.shift() || { status: 0, stdout: "", stderr: "" }
		},
	}
}

test("外部命令 runner 有界地收集输出并在超时时结束子进程", async () => {
	const completed = await runCommand(process.execPath, ["-e", 'process.stdout.write("ok")'])
	assert.equal(completed.status, 0)
	assert.equal(completed.stdout, "ok")
	const timedOut = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 20 })
	assert.equal(timedOut.timedOut, true)
})

test("Tailscale 状态区分正常、未登录、缺失、错误目标和超时", async () => {
	for (const [result, expected] of [
		[status(), "ready"],
		[{ status: 1, stdout: "", stderr: "not logged in" }, "not_logged_in"],
		[status({ path: null }), "missing"],
		[status({ target: "http://127.0.0.1:9999" }), "wrong_target"],
		[{ status: null, stdout: "", stderr: "", timedOut: true }, "timeout"],
	]) {
		const runner = fakeRunner([result])
		const manager = createTailscaleManager({ path: "tailscale", run: runner.run, now: () => 0 })
		assert.equal((await manager.status(PORT)).state, expected)
		assert.deepEqual(runner.calls[0], { path: "tailscale", args: ["funnel", "status", "--json"] })
	}
})

test("Funnel 只配置并精确关闭 /mcp", async () => {
	const runner = fakeRunner([
		status({ path: "/", target: TARGET }),
		{ status: 0, stdout: "", stderr: "" },
		status(),
		{ status: 0, stdout: "", stderr: "" },
	])
	const manager = createTailscaleManager({ path: "tailscale", run: runner.run })
	const configured = await manager.ensureMcpFunnel(PORT)
	assert.equal(configured.changed, true)
	assert.equal(configured.status.publicUrl, "https://host.example.ts.net:443/mcp")
	assert.deepEqual(runner.calls.map((call) => call.args), [
		["funnel", "status", "--json"],
		["funnel", "--bg", "--set-path=/mcp", TARGET],
		["funnel", "status", "--json"],
	])
	await manager.disableMcpFunnel()
	assert.deepEqual(runner.calls[3].args, ["funnel", "--set-path=/mcp", "off"])
})

test("历史 NotionMCP 目标会迁移到保留 /mcp 前缀的代理目标", async () => {
	const runner = fakeRunner([
		status({ target: LEGACY_TARGET }),
		{ status: 0, stdout: "", stderr: "" },
		status(),
	])
	const manager = createTailscaleManager({ path: "tailscale", run: runner.run })
	const configured = await manager.ensureMcpFunnel(PORT)
	assert.equal(configured.changed, true)
	assert.equal(configured.status.publicUrl, "https://host.example.ts.net:443/mcp")
	assert.deepEqual(runner.calls.map((call) => call.args), [
		["funnel", "status", "--json"],
		["funnel", "--bg", "--set-path=/mcp", TARGET],
		["funnel", "status", "--json"],
	])
})

test("已正确配置不改 Funnel；错误目标中止且不覆盖用户配置", async () => {
	for (const [result, pattern] of [
		[status(), null],
		[status({ target: "http://127.0.0.1:9999" }), /已指向其他目标/],
	]) {
		const runner = fakeRunner([result])
		const manager = createTailscaleManager({ path: "tailscale", run: runner.run })
		if (pattern) await assert.rejects(() => manager.ensureMcpFunnel(PORT), pattern)
		else assert.equal((await manager.ensureMcpFunnel(PORT)).changed, false)
		assert.equal(runner.calls.length, 1)
	}
})

test("服务启动失败会回收监听器，停止时只禁用本项目 Funnel", async () => {
	const calls = []
	const lifecycle = { listen: async () => calls.push("listen"), shutdown: async (reason) => calls.push(`shutdown:${reason}`) }
	await assert.rejects(
		() => startService({ sandboxDir: "/tmp/sandbox", port: PORT, token: "token", createServer: () => lifecycle, ensureFunnel: async () => { throw new Error("funnel") }, mkdirImpl: async () => calls.push("mkdir") }),
		/funnel/,
	)
	assert.deepEqual(calls, ["mkdir", "listen", "shutdown:startup_failed"])

	const stopped = []
	await stopService({ lifecycle: { shutdown: async (reason) => stopped.push(`shutdown:${reason}`) }, disableFunnel: async () => stopped.push("disable:/mcp"), reason: "test" })
	assert.deepEqual(stopped, ["disable:/mcp", "shutdown:test"])
})
