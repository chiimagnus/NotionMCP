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
	const globalFile = join(dir, "global", "AGENTS.md")
	await mkdir(join(dir, "global"), { recursive: true })
	await mkdir(nested, { recursive: true })
	await writeFile(globalFile, "global rule")
	await writeFile(join(rulesRoot, "AGENTS.md"), "outer rule")
	await writeFile(join(nested, "AGENTS.md"), "inner rule")
	const agents = await import(`../lib/agentsMd.mjs?test=${Date.now()}-${Math.random()}`)
	const hierarchy = await agents.getAgentsMdContext(nested, { globalFile })
	assert.deepEqual(hierarchy.sources.map((source) => source.content), ["global rule", "outer rule", "inner rule"])
	assert.match(agents.formatAgentsMdContext(hierarchy), /digest: sha256:/)
	assert.match(await agents.getChangedAgentsMdBlock(nested, { globalFile }), /inner rule/)
	assert.equal(await agents.getChangedAgentsMdBlock(nested, { globalFile }), "")
	await writeFile(join(nested, "AGENTS.md"), "inner rule changed")
	assert.match(await agents.getChangedAgentsMdBlock(nested, { globalFile }), /inner rule changed/)
	await mkdir(join(rulesRoot, "invalid"), { recursive: true })
	await writeFile(join(rulesRoot, "invalid", "AGENTS.md"), Buffer.from([0xc3, 0x28]))
	const invalid = await agents.getAgentsMdContext(join(rulesRoot, "invalid"), { globalFile })
	assert.equal(invalid.warnings.some((warning) => warning.reason === "unreadable"), true)
	await mkdir(join(rulesRoot, "oversized"), { recursive: true })
	await writeFile(join(rulesRoot, "oversized", "AGENTS.md"), "x".repeat(128 * 1024 + 1))
	const oversized = await agents.getAgentsMdContext(join(rulesRoot, "oversized"), { globalFile })
	assert.equal(oversized.warnings.some((warning) => warning.reason === "too_large"), true)
	const cancelled = new AbortController()
	cancelled.abort()
	assert.equal((await agents.getAgentsMdContext(nested, { globalFile, signal: cancelled.signal })).cancelled, true)

	const projectContext = await import(`../tools/project_context.mjs?test=${Date.now()}-${Math.random()}`)
	assert.equal((await projectContext.call({ cwd: 1 })).isError, true)
	assert.match((await projectContext.call({ cwd: nested })).content[0].text, /inner rule changed/)
	const runCommand = await import(`../tools/run_command.mjs?test=${Date.now()}-${Math.random()}`)
	assert.equal((await runCommand.call({ command: "printf context", cwd: 1 })).isError, true)
	assert.doesNotMatch((await runCommand.call({ command: "printf context", cwd: nested })).content[0].text, /auto-loaded dev conventions/)
	await writeFile(join(nested, "AGENTS.md"), "inner rule changed again")
	assert.match((await runCommand.call({ command: "printf context", cwd: nested })).content[0].text, /inner rule changed again/)
	assert.doesNotMatch((await runCommand.call({ command: "printf context", cwd: nested })).content[0].text, /auto-loaded dev conventions/)
	assert.doesNotMatch(await readFile(join(dir, "mcp.log"), "utf8"), /inner rule changed again/)

	const alpha = join(dir, "skills", "alpha")
	const beta = join(dir, "skills", "nested", "beta")
	await mkdir(alpha, { recursive: true })
	await mkdir(beta, { recursive: true })
	await writeFile(join(alpha, "SKILL.md"), "---\nname: Alpha\ndescription: alpha development workflow\n---\nALPHA_BODY_MUST_NOT_BE_DISCOVERED")
	await writeFile(join(beta, "SKILL.md"), "---\nname: Beta\ndescription: nested review workflow\n---\nBETA_BODY")
	const loadSkills = await import("../tools/load_skills.mjs")
	const registry = await import("../tools/index.mjs")
	assert.match(registry.definitions.find((tool) => tool.name === "run_command").description, /始终询问/)
	assert.match(registry.definitions.find((tool) => tool.name === "apply_patch").description, /始终询问/)
	assert.match(registry.definitions.find((tool) => tool.name === "read_image").description, /自动运行/)
	assert.doesNotMatch(loadSkills.definition.description, /alpha development/)
	assert.equal(registry.definitions.some((tool) => tool.name === "search_skills"), false)
	const applyPatch = await import("../tools/apply_patch.mjs")
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
	const projectWithSkills = await projectContext.call({ cwd: nested })
	assert.match(projectWithSkills.content[0].text, /key: skills\/alpha\n  name: Alpha\n  description: alpha development workflow/)
	assert.match(projectWithSkills.content[0].text, /key: skills\/nested\/beta\n  name: Beta\n  description: nested review workflow/)
	assert.doesNotMatch(projectWithSkills.content[0].text, /ALPHA_BODY_MUST_NOT_BE_DISCOVERED/)
	assert.match((await loadSkills.call({ name: "skills/alpha" })).content[0].text, /ALPHA_BODY_MUST_NOT_BE_DISCOVERED/)
	const skillAbort = new AbortController()
	skillAbort.abort()
	assert.match((await loadSkills.call({ name: "skills/alpha" }, { signal: skillAbort.signal })).content[0].text, /cancelled/)
	const gamma = join(dir, "skills", "gamma")
	await mkdir(gamma)
	await writeFile(join(gamma, "SKILL.md"), "---\nname: Gamma\ndescription: refreshed catalog\n---\nGAMMA_BODY")
	assert.match((await projectContext.call({ cwd: nested })).content[0].text, /key: skills\/gamma\n  name: Gamma\n  description: refreshed catalog/)
})
