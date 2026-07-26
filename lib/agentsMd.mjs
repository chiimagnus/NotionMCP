// lib/agentsMd.mjs
// 自动加载项目开发规范：仿照 Codex CLI harness 的做法——从当前工作目录逐级
// 往上查找 AGENTS.md 文件，把找到的内容附加到工具的返回结果里。
//
// 去重状态落盘保存成一个小的 JSON 文件，而不是放在内存里的 Set 中：实测发现
// 这个 server 进程不一定能在两次工具调用之间保持存活（内存里的 Set 会被重置）。
// 同一个目录最多每隔 REFRESH_MS 才会再提示一次，这样规范更新后还能被重新看到，
// 又不会每次命令都刷屏。

import { readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import { MCP_ROOT } from "./config.mjs"
import { log } from "./rpc.mjs"

const MAX_LEVELS = 20
const STATE_FILE = join(MCP_ROOT, ".agents-md-state.json")
const REFRESH_MS = 4 * 60 * 60 * 1000 // 同一目录最多每 4 小时再提示一次

function loadState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf-8"))
	} catch {
		return {}
	}
}

function saveState(state) {
	try {
		writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8")
	} catch (err) {
		log(`agentsMd state write failed: ${err.message}`)
	}
}

function findAgentsMdFiles(startDir) {
	const found = []
	let dir = startDir
	const root = parse(dir).root
	for (let i = 0; i < MAX_LEVELS; i += 1) {
		const candidate = join(dir, "AGENTS.md")
		try {
			if (statSync(candidate).isFile()) found.push(candidate)
		} catch {}
		if (!root || dir === root) break
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	// 最外层（离盘符根最近）排最前，最具体的排最后，
	// 这样嵌套项目里的规范读起来像是对上层规范的“覆盖”。
	return found.reverse()
}

// 返回一段要附加到工具结果里的文本；如果没有新内容可展示——往上没找到
// AGENTS.md，或者这个目录在 REFRESH_MS 时间窗口内已经展示过——则返回空字符串。
export function getAgentsMdBlock(workDir) {
	if (!workDir) return ""
	const state = loadState()
	const lastShown = state[workDir]
	const now = Date.now()
	if (lastShown && now - lastShown < REFRESH_MS) return ""

	const files = findAgentsMdFiles(workDir)
	state[workDir] = now
	saveState(state)
	if (files.length === 0) return ""

	const sections = files.map((filePath) => {
		let content
		try {
			content = readFileSync(filePath, "utf-8")
		} catch (err) {
			content = `(read failed: ${err.message})`
		}
		return `--- AGENTS.md: ${filePath} ---\n${content}`
	})

	log(`agentsMd workDir=${JSON.stringify(workDir)} files=${files.length}`)
	return `\n\n[auto-loaded dev conventions - re-shown at most every ${REFRESH_MS / 3600000}h per directory]\n${sections.join("\n\n")}`
}

// 用于调试：清空已展示记录。
export function resetAgentsMdCache() {
	try {
		writeFileSync(STATE_FILE, "{}", "utf-8")
	} catch {}
}
