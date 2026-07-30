import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, parse, resolve } from "node:path"

import { log } from "./log.mjs"

const MAX_LEVELS = 20
const MAX_AGENTS_BYTES = 128 * 1024
const fileCache = new Map()

function candidatesFor(workDir, globalFile) {
	const projectCandidates = []
	let dir = resolve(workDir)
	const root = parse(dir).root
	for (let level = 0; level < MAX_LEVELS; level += 1) {
		projectCandidates.push(join(dir, "AGENTS.md"))
		if (dir === root) break
		dir = dirname(dir)
	}
	return [...new Set([resolve(globalFile), ...projectCandidates.reverse()])]
}

async function readAgent(filePath, signal) {
	if (signal?.aborted) return { cancelled: true }
	let info
	try {
		info = await stat(filePath)
	} catch (error) {
		if (error?.code === "ENOENT") {
			fileCache.delete(filePath)
			return null
		}
		log("warning", "agentsMd", "discovery_failed", { errorType: error?.name || "Error" })
		return { warning: { path: filePath, reason: "unavailable" } }
	}
	if (!info.isFile()) return null
	if (info.size > MAX_AGENTS_BYTES) {
		log("warning", "agentsMd", "read_skipped", { outcome: "too_large", count: info.size })
		return { warning: { path: filePath, reason: "too_large" } }
	}
	const cached = fileCache.get(filePath)
	if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached
	try {
		const bytes = await readFile(filePath, { signal })
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		const snapshot = { path: filePath, content, mtimeMs: info.mtimeMs, size: info.size }
		fileCache.set(filePath, snapshot)
		return snapshot
	} catch (error) {
		if (signal?.aborted || error?.name === "AbortError") return { cancelled: true }
		log("warning", "agentsMd", "read_failed", { errorType: error?.name || "Error" })
		return { warning: { path: filePath, reason: "unreadable" } }
	}
}

export async function getAgentsMdContext(workDir, { signal, globalFile = join(homedir(), ".codex", "AGENTS.md") } = {}) {
	const resolvedWorkDir = resolve(workDir)
	const sources = []
	const warnings = []
	for (const filePath of candidatesFor(resolvedWorkDir, globalFile)) {
		const result = await readAgent(filePath, signal)
		if (result?.cancelled) return { workDir: resolvedWorkDir, sources: [], warnings: [], cancelled: true }
		if (result?.warning) warnings.push(result.warning)
		else if (result) sources.push(result)
	}
	const context = { workDir: resolvedWorkDir, sources, warnings, cancelled: false }
	log("info", "agentsMd", "loaded", { count: sources.length })
	return context
}

export function formatAgentsMdContext(context) {
	const lines = []
	if (context.sources.length === 0) lines.push("(no AGENTS.md rules found)")
	for (const source of context.sources) lines.push(`--- AGENTS.md: ${source.path} ---\n${source.content}`)
	for (const warning of context.warnings) lines.push(`(AGENTS.md unavailable: ${warning.path}; ${warning.reason})`)
	return `\n\n${lines.join("\n\n")}`
}
