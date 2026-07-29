import assert from "node:assert/strict"
import test from "node:test"

import { installPlatformService, renderPlatformService, servicePaths, uninstallPlatformService } from "../lib/platform-services.mjs"

test("三平台服务定义保留重启策略、绝对路径和安全转义", async () => {
	for (const kind of ["macos", "linux", "windows"]) {
		const service = await renderPlatformService({ kind, home: "/home/test user", nodePath: "/node path/node", root: "/repo & test" })
		assert.equal(service.file, servicePaths(kind, "/home/test user").file)
		assert.doesNotMatch(service.content, /{{/)
		assert.match(service.content, /notionmcp\.mjs/)
		if (kind === "macos") assert.match(service.content, /KeepAlive/)
		if (kind === "linux") assert.match(service.content, /Restart=always/)
		if (kind === "windows") assert.match(service.content, /RestartOnFailure/)
	}
})

test("安装与卸载支持无副作用 dry-run，真实命令由注入 runner 执行", async () => {
	const config = { port: 8000 }
	const dry = await installPlatformService(config, { kind: "linux", home: "/tmp/notionmcp-test", dryRun: true })
	assert.equal(dry.dryRun, true)
	assert.match(dry.content, /ExecStartPost/)
	const calls = []
	const run = async (command, args) => {
		calls.push([command, args])
		return { status: 0, stdout: "", stderr: "" }
	}
	const uninstall = await uninstallPlatformService(config, { kind: "windows", home: "/tmp/notionmcp-test", dryRun: true, run })
	assert.equal(uninstall.dryRun, true)
	assert.deepEqual(calls, [])
})
