import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

async function readTool(dir) {
	const config = join(dir, ".env")
	const logFile = join(dir, "mcp.log")
	const token = "0123456789abcdef".repeat(4)
	await writeFile(config, [`MCP_PORT=8000`, `MCP_SANDBOX_DIR_MACOS=${dir}`, `MCP_SKILLS_DIR_MACOS=${dir}`, `MCP_SANDBOX_DIR_LINUX=${dir}`, `MCP_SKILLS_DIR_LINUX=${dir}`, `MCP_TOKEN_LINUX=${token}`, `MCP_SANDBOX_DIR_WINDOWS=${dir}`, `MCP_SKILLS_DIR_WINDOWS=${dir}`, `MCP_TOKEN_WINDOWS=${token}`].join("\n"))
	const previous = { config: process.env.MCP_CONFIG_FILE, log: process.env.MCP_LOG_FILE }
	process.env.MCP_CONFIG_FILE = config
	process.env.MCP_LOG_FILE = logFile
	return {
		module: await import(`../tools/read_file.mjs?test=${Date.now()}-${Math.random()}`),
		restore() {
			if (previous.config === undefined) delete process.env.MCP_CONFIG_FILE
			else process.env.MCP_CONFIG_FILE = previous.config
			if (previous.log === undefined) delete process.env.MCP_LOG_FILE
			else process.env.MCP_LOG_FILE = previous.log
		},
	}
}

test("read_file 只读 UTF-8 普通文件，并校验范围、大小、二进制与取消", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "notionmcp-tools-"))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const { module, restore } = await readTool(dir)
	t.after(restore)
	const { call } = module
	await writeFile(join(dir, "text.txt"), "one\ntwo\nthree\n")
	assert.match((await call({ path: "text.txt", startLine: 2, endLine: 3 })).content[0].text, /text.txt:2-3\ntwo\nthree/)
	assert.match((await call({ path: join(dir, "text.txt") })).content[0].text, /one\ntwo\nthree/)
	assert.equal((await call({ path: "missing.txt" })).isError, true)
	assert.equal((await call({ path: "text.txt", startLine: 3, endLine: 2 })).isError, true)
	await mkdir(join(dir, "folder"))
	assert.match((await call({ path: "folder" })).content[0].text, /regular file/)
	await writeFile(join(dir, "binary.bin"), Buffer.from([1, 0, 2]))
	assert.match((await call({ path: "binary.bin" })).content[0].text, /Binary/)
	await writeFile(join(dir, "invalid.txt"), Buffer.from([0xc3, 0x28]))
	assert.match((await call({ path: "invalid.txt" })).content[0].text, /valid UTF-8/)
	await writeFile(join(dir, "large.txt"), "x".repeat(1024 * 1024 + 1))
	assert.match((await call({ path: "large.txt" })).content[0].text, /limit/)
	const controller = new AbortController()
	controller.abort()
	assert.match((await call({ path: "text.txt" }, { signal: controller.signal })).content[0].text, /cancelled/)
})
