import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
	assert.match((await call({ path: "text.txt", startLine: 99 })).content[0].text, /beyond end of file/)
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

	const rulesRoot = join(dir, "rules")
	const nested = join(rulesRoot, "nested")
	const globalDir = join(dir, "global")
	await mkdir(globalDir, { recursive: true })
	await mkdir(nested, { recursive: true })
	await writeFile(join(globalDir, "AGENTS.md"), "global rule")
	await writeFile(join(rulesRoot, "AGENTS.md"), "outer rule")
	await writeFile(join(nested, "AGENTS.md"), "inner rule")
	await writeFile(join(nested, "CLAUDE.md"), "inner claude rule")
	const agents = await import(`../lib/agentsMd.mjs?test=${Date.now()}-${Math.random()}`)
	const hierarchy = await agents.getAgentsMdContext(nested, { globalDir })
	assert.deepEqual(hierarchy.sources.map((source) => source.content), ["global rule", "outer rule", "inner rule", "inner claude rule"])
	assert.match(agents.formatAgentsMdContext(hierarchy), /digest: sha256:/)
	await mkdir(join(rulesRoot, "invalid"), { recursive: true })
	await writeFile(join(rulesRoot, "invalid", "AGENTS.md"), Buffer.from([0xc3, 0x28]))
	const invalid = await agents.getAgentsMdContext(join(rulesRoot, "invalid"), { globalDir })
	assert.equal(invalid.warnings.some((warning) => warning.reason === "unreadable"), true)
	await mkdir(join(rulesRoot, "oversized"), { recursive: true })
	await writeFile(join(rulesRoot, "oversized", "AGENTS.md"), "x".repeat(128 * 1024 + 1))
	const oversized = await agents.getAgentsMdContext(join(rulesRoot, "oversized"), { globalDir })
	assert.equal(oversized.warnings.some((warning) => warning.reason === "too_large"), true)
	const cancelled = new AbortController()
	cancelled.abort()
	assert.equal((await agents.getAgentsMdContext(nested, { globalDir, signal: cancelled.signal })).cancelled, true)

	const readRules = await import(`../tools/read_rules.mjs?test=${Date.now()}-${Math.random()}`)
	assert.equal((await readRules.call({ cwd: 1 })).isError, true)
	assert.match((await readRules.call({ cwd: nested })).content[0].text, /inner rule/)
	const runCommand = await import(`../tools/run_command.mjs?test=${Date.now()}-${Math.random()}`)
	const applyPatch = await import(`../tools/apply_patch.mjs?test=${Date.now()}-${Math.random()}`)
	assert.equal((await runCommand.call({ command: "printf context", cwd: 1 })).isError, true)
	await writeFile(join(nested, "AGENTS.md"), "RULE_AUTO_APPLY_PATCH_MUST_NOT_APPEAR")
	const patchedWithoutRules = await applyPatch.call({
		operations: [{ type: "create_file", path: join(nested, "apply-patch-proof.txt"), content: "proof" }],
	})
	assert.doesNotMatch(patchedWithoutRules.content[0].text, /RULE_AUTO_APPLY_PATCH_MUST_NOT_APPEAR/)
	await writeFile(join(nested, "AGENTS.md"), "RULE_AUTO_RUN_COMMAND_MUST_NOT_APPEAR")
	const commandWithoutRules = await runCommand.call({ command: "printf context", cwd: nested })
	assert.doesNotMatch(commandWithoutRules.content[0].text, /RULE_AUTO_RUN_COMMAND_MUST_NOT_APPEAR/)
	assert.match((await readRules.call({ cwd: nested })).content[0].text, /RULE_AUTO_RUN_COMMAND_MUST_NOT_APPEAR/)
	assert.doesNotMatch(await readFile(join(dir, "mcp.log"), "utf8"), /RULE_AUTO_RUN_COMMAND_MUST_NOT_APPEAR/)

	const alpha = join(dir, "skills", "alpha")
	const beta = join(dir, "skills", "nested", "beta")
	await mkdir(alpha, { recursive: true })
	await mkdir(beta, { recursive: true })
	await writeFile(join(alpha, "SKILL.md"), "---\nname: Alpha\ndescription: alpha development workflow\n---\nALPHA_BODY_MUST_NOT_BE_DISCOVERED")
	await writeFile(join(beta, "SKILL.md"), "---\nname: Beta\ndescription: nested review workflow\n---\nBETA_BODY")
	const registry = await import("../tools/index.mjs")
	assert.equal(registry.definitions.some((tool) => tool.name === "load_skills"), false)
	const cancelledDir = join(dir, "cancelled-patch")
	let signalChecks = 0
	const cancelledPatch = await applyPatch.call(
		{
			operations: [
				{ type: "create_file", path: join(cancelledDir, "first.txt"), content: "first" },
				{ type: "create_file", path: join(cancelledDir, "second.txt"), content: "second" },
			],
		},
		{ signal: { get aborted() { return signalChecks++ > 0 } } },
	)
	assert.equal(cancelledPatch.isError, true)
	assert.equal(await readFile(join(cancelledDir, "first.txt"), "utf8"), "first")
	await assert.rejects(readFile(join(cancelledDir, "second.txt")), { code: "ENOENT" })
	const projectWithSkills = await readRules.call({ cwd: nested })
	assert.match(projectWithSkills.content[0].text, /key: skills\/alpha\n  path: .*skills\/alpha\/SKILL\.md\n  name: Alpha\n  description: alpha development workflow/)
	assert.match(projectWithSkills.content[0].text, /key: skills\/nested\/beta\n  path: .*skills\/nested\/beta\/SKILL\.md\n  name: Beta\n  description: nested review workflow/)
	assert.doesNotMatch(projectWithSkills.content[0].text, /ALPHA_BODY_MUST_NOT_BE_DISCOVERED/)
	assert.match((await module.call({ path: join(alpha, "SKILL.md") })).content[0].text, /ALPHA_BODY_MUST_NOT_BE_DISCOVERED/)
	const gamma = join(dir, "skills", "gamma")
	await mkdir(gamma)
	await writeFile(join(gamma, "SKILL.md"), "---\nname: Gamma\ndescription: refreshed catalog\n---\nGAMMA_BODY")
	assert.match((await readRules.call({ cwd: nested })).content[0].text, /key: skills\/gamma\n  path: .*skills\/gamma\/SKILL\.md\n  name: Gamma\n  description: refreshed catalog/)
})
