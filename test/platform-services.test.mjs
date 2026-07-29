import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { installPlatformService, renderPlatformService, serviceBytes, servicePaths, uninstallPlatformService } from "../lib/platform-services.mjs"

test("三平台服务定义保留重启策略、绝对路径和安全转义", async () => {
	for (const kind of ["macos", "linux", "windows"]) {
		const service = await renderPlatformService({ kind, home: "/home/test user", nodePath: "/node path/node", root: "/repo & test" })
		assert.equal(service.file, servicePaths(kind, "/home/test user", "/repo & test").file)
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

test("三平台安装卸载使用精确命令，Windows XML 含 UTF-16LE BOM", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "notionmcp-service-"))
	t.after(() => rm(root, { recursive: true, force: true }))
	for (const kind of ["macos", "linux", "windows"]) {
		const calls = []
		const run = async (command, args) => {
			calls.push([command, args])
			return { status: 0, stdout: "", stderr: "" }
		}
		const options = { kind, home: root, root, run }
		const installed = await installPlatformService({ port: 8000 }, options)
		const bytes = await readFile(installed.file)
		if (kind === "windows") assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe])
		else assert.match(bytes.toString("utf8"), /notionmcp/)
		await uninstallPlatformService({ port: 8000 }, options)
		assert.ok(calls.every(([command]) => !/sh|cmd/i.test(command)))
		if (kind === "linux") assert.deepEqual(calls.map(([, args]) => args), [["--user", "daemon-reload"], ["--user", "enable", "--now", "notionmcp.service"], ["--user", "disable", "--now", "notionmcp.service"], ["--user", "daemon-reload"]])
		if (kind === "windows") assert.deepEqual(calls.map(([, args]) => args), [["/Create", "/TN", "NotionMCP", "/XML", installed.file, "/F"], ["/Delete", "/TN", "NotionMCP", "/F"]])
	}
	assert.deepEqual([...serviceBytes("windows", "x")], [0xff, 0xfe, 0x78, 0x00])
})
