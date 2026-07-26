// lib/agentsMd.mjs
// Auto-load project dev conventions, mirroring what Codex CLI's harness does
// automatically: walk upward from a working directory collecting any
// AGENTS.md files along the way, and surface their content in a tool's
// result.
//
// De-dup state is persisted to a small JSON file on disk rather than kept in
// an in-memory Set, because this server process does not reliably stay alive
// across separate tool calls (observed empirically: an in-memory Set reset
// between calls). A directory is re-surfaced at most once per REFRESH_MS so
// updated conventions eventually get picked back up without spamming every
// single command.

import { readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import { MCP_ROOT } from "./config.mjs"
import { log } from "./rpc.mjs"

const MAX_LEVELS = 20
const STATE_FILE = join(MCP_ROOT, ".agents-md-state.json")
const REFRESH_MS = 4 * 60 * 60 * 1000 // re-surface at most once every 4 hours per directory

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
	// Outermost (closest to the filesystem root) first, most specific last, so
	// a nested project's conventions read as an "override" of broader ones.
	return found.reverse()
}

// Returns a text block to append to a tool result, or "" when there is
// nothing new to show: either no AGENTS.md was found on the way up from
// `workDir`, or this exact directory was already surfaced within the last
// REFRESH_MS window.
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

// Exposed for debugging: forget what has been shown so far.
export function resetAgentsMdCache() {
	try {
		writeFileSync(STATE_FILE, "{}", "utf-8")
	} catch {}
}
