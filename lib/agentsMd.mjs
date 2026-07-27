// lib/agentsMd.mjs
// 自动加载项目开发规范：仿照 Codex CLI harness 的做法——从当前工作目录逐级
// 往上查找 AGENTS.md 文件，把找到的内容附加到工具的返回结果里。
// 每次调用都会重新查找并展示，不做节流/去重。

import { readFileSync, statSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import { log } from "./log.mjs"

const MAX_LEVELS = 20

function findAgentsMdFiles(startDir) {
	const found = []
	let dir = startDir
	const root = parse(dir).root
	for (let i = 0; i < MAX_LEVELS; i += 1) {
		const candidate = join(dir, "AGENTS.md")
		try {
			if (statSync(candidate).isFile()) found.push(candidate)
		} catch (error) {
			if (error.code !== "ENOENT") log("warning", "agentsMd", "discovery_failed", { error })
		}
		if (!root || dir === root) break
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	// 最外层（离盘符根最近）排最前，最具体的排最后，
	// 这样嵌套项目里的规范读起来像是对上层规范的“覆盖”。
	return found.reverse()
}

// 返回一段要附加到工具结果里的文本；如果往上没找到 AGENTS.md，返回空字符串。
export function getAgentsMdBlock(workDir) {
	if (!workDir) return ""

	const files = findAgentsMdFiles(workDir)
	if (files.length === 0) return ""

	const sections = files.map((filePath) => {
		let content
		try {
			content = readFileSync(filePath, "utf-8")
		} catch (err) {
			log("warning", "agentsMd", "read_failed", { error: err })
			content = `(read failed: ${err.message})`
		}
		return `--- AGENTS.md: ${filePath} ---\n${content}`
	})

	log("info", "agentsMd", "loaded", { count: files.length })
	return `\n\n[auto-loaded dev conventions]\n${sections.join("\n\n")}`
}
