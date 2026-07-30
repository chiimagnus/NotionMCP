import assert from "node:assert/strict"
import test from "node:test"

import { runCommand, startService, stopService } from "../lib/service-manager.mjs"
import { MCP_FUNNEL_PATHS, createTailscaleManager } from "../lib/tailscale.mjs"

const PORT = 8123
const TARGET = `http://127.0.0.1:${PORT}/mcp`
const LEGACY_TARGET = `http://127.0.0.1:${PORT}`
const TARGETS = Object.fromEntries(MCP_FUNNEL_PATHS.map((path) => [path, `http://127.0.0.1:${PORT}${path}`]))

function status({ paths = MCP_FUNNEL_PATHS, targets = {}, allowed = true } = {}) {
	return {
		status: 0,
		stdout: JSON.stringify({
			Web: {
			"host.example.ts.net:443": {
				Handlers: Object.fromEntries(paths.map((path) => [path, { Proxy: targets[path] || (path === "/" ? LEGACY_TARGET : TARGETS[path] || TARGET) }])),
				},
			},
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
		[status({ paths: [] }), "missing"],
		[status({ targets: { "/mcp": "http://127.0.0.1:9999" } }), "wrong_target"],
		[{ status: null, stdout: "", stderr: "", timedOut: true }, "timeout"],
	]) {
		const runner = fakeRunner([result])
		const manager = createTailscaleManager({ path: "tailscale", run: runner.run, now: () => 0 })
		assert.equal((await manager.status(PORT)).state, expected)
		assert.deepEqual(runner.calls[0], { path: "tailscale", args: ["funnel", "status", "--json"] })
	}
})

test("Funnel 只配置并精确关闭 MCP 的三条传输路径", async () => {
	const runner = fakeRunner([
		status({ paths: [] }),
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
		status(),
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
	])
	const manager = createTailscaleManager({ path: "tailscale", run: runner.run })
	const configured = await manager.ensureMcpFunnel(PORT)
	assert.equal(configured.changed, true)
	assert.equal(configured.status.publicUrl, "https://host.example.ts.net:443/mcp")
	assert.deepEqual(runner.calls.map((call) => call.args), [
		["funnel", "status", "--json"],
		["funnel", "--bg", "--set-path=/mcp", TARGET],
		["funnel", "--bg", "--set-path=/mcp/sse", TARGETS["/mcp/sse"]],
		["funnel", "--bg", "--set-path=/mcp/messages", TARGETS["/mcp/messages"]],
		["funnel", "status", "--json"],
	])
	await manager.disableMcpFunnel()
	assert.deepEqual(runner.calls.slice(5).map((call) => call.args), [
		["funnel", "--set-path=/mcp/messages", "off"],
		["funnel", "--set-path=/mcp/sse", "off"],
		["funnel", "--set-path=/mcp", "off"],
	])
})

test("仅清理指向本项目端口的旧 Funnel 根路径", async () => {
	const runner = fakeRunner([
		status({ paths: ["/", ...MCP_FUNNEL_PATHS] }),
		{ status: 0, stdout: "", stderr: "" },
		status({ paths: MCP_FUNNEL_PATHS }),
	])
	const manager = createTailscaleManager({ path: "tailscale", run: runner.run })
	const configured = await manager.ensureMcpFunnel(PORT)
	assert.equal(configured.changed, true)
	assert.equal(configured.status.publicUrl, "https://host.example.ts.net:443/mcp")
	assert.deepEqual(runner.calls.map((call) => call.args), [
		["funnel", "status", "--json"],
		["funnel", "--set-path=/", "off"],
		["funnel", "status", "--json"],
	])
})

test("历史 NotionMCP 目标会迁移到保留 /mcp 前缀的代理目标", async () => {
	const runner = fakeRunner([
		status({ targets: { "/mcp": LEGACY_TARGET } }),
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
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
		["funnel", "--bg", "--set-path=/mcp/sse", TARGETS["/mcp/sse"]],
		["funnel", "--bg", "--set-path=/mcp/messages", TARGETS["/mcp/messages"]],
		["funnel", "status", "--json"],
	])
})

test("迁移旧 /mcp 目标前也会清理同属本项目的根路径", async () => {
	const runner = fakeRunner([
		status({ paths: ["/", ...MCP_FUNNEL_PATHS], targets: { "/mcp": LEGACY_TARGET } }),
		{ status: 0, stdout: "", stderr: "" },
		status({ paths: MCP_FUNNEL_PATHS, targets: { "/mcp": LEGACY_TARGET } }),
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
		status({ paths: MCP_FUNNEL_PATHS }),
	])
	const manager = createTailscaleManager({ path: "tailscale", run: runner.run })
	const configured = await manager.ensureMcpFunnel(PORT)
	assert.equal(configured.changed, true)
	assert.equal(configured.status.publicUrl, "https://host.example.ts.net:443/mcp")
	assert.deepEqual(runner.calls.map((call) => call.args), [
		["funnel", "status", "--json"],
		["funnel", "--set-path=/", "off"],
		["funnel", "status", "--json"],
		["funnel", "--bg", "--set-path=/mcp", TARGET],
		["funnel", "--bg", "--set-path=/mcp/sse", TARGETS["/mcp/sse"]],
		["funnel", "--bg", "--set-path=/mcp/messages", TARGETS["/mcp/messages"]],
		["funnel", "status", "--json"],
	])
})

test("Funnel 配置后未就绪会中止启动", async () => {
	const runner = fakeRunner([
		status({ paths: [] }),
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "", stderr: "" },
		status({ paths: [] }),
	])
	const manager = createTailscaleManager({ path: "tailscale", run: runner.run })
	await assert.rejects(() => manager.ensureMcpFunnel(PORT), /配置后仍未就绪：missing/)
	assert.deepEqual(runner.calls.map((call) => call.args), [
		["funnel", "status", "--json"],
		["funnel", "--bg", "--set-path=/mcp", TARGET],
		["funnel", "--bg", "--set-path=/mcp/sse", TARGETS["/mcp/sse"]],
		["funnel", "--bg", "--set-path=/mcp/messages", TARGETS["/mcp/messages"]],
		["funnel", "status", "--json"],
	])
})

test("已正确配置不改 Funnel；错误目标中止且不覆盖用户配置", async () => {
	for (const [result, pattern] of [
		[status(), null],
		[status({ targets: { "/mcp": "http://127.0.0.1:9999" } }), /已指向其他目标/],
		[status({ targets: { "/mcp/sse": "http://127.0.0.1:9999" } }), /已指向其他目标/],
		[status({ paths: ["/", ...MCP_FUNNEL_PATHS], targets: { "/": "http://127.0.0.1:9999" } }), /根路径已指向其他目标/],
		[
			status({ paths: ["/", ...MCP_FUNNEL_PATHS], targets: { "/": "http://127.0.0.1:9999", "/mcp": LEGACY_TARGET } }),
			/根路径已指向其他目标/,
		],
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
