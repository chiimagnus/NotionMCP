import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, parse, resolve } from "node:path"

import { log } from "./log.mjs"

const MAX_LEVELS = 20
const MAX_AGENTS_BYTES = 128 * 1024
const DEFAULT_RULE_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"]
const fileCache = new Map()

function candidatesFor(workDir, globalDir, fileNames) {
	const levels = []
	let dir = resolve(workDir)
	const root = parse(dir).root
	for (let level = 0; level < MAX_LEVELS; level += 1) {
		levels.push(fileNames.map((fileName) => join(dir, fileName)))
		if (dir === root) break
		dir = dirname(dir)
	}
	const projectCandidates = levels.reverse().flat()
	const globalCandidates = fileNames.map((fileName) => join(resolve(globalDir), fileName))
	return [...new Set([...globalCandidates, ...projectCandidates])]
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

function digestFor(sources, warnings) {
	const hash = createHash("sha256")
	for (const source of sources) hash.update(source.path).update("\0").update(source.content).update("\0")
	for (const warning of warnings) hash.update(warning.path).update("\0").update(warning.reason).update("\0")
	return `sha256:${hash.digest("hex")}`
}

export async function getAgentsMdContext(
	workDir,
	{ signal, globalDir = join(homedir(), ".codex"), fileNames = DEFAULT_RULE_FILE_NAMES } = {},
) {
	const resolvedWorkDir = resolve(workDir)
	const sources = []
	const warnings = []
	for (const filePath of candidatesFor(resolvedWorkDir, globalDir, fileNames)) {
		const result = await readAgent(filePath, signal)
		if (result?.cancelled) return { workDir: resolvedWorkDir, sources: [], warnings: [], digest: null, cancelled: true }
		if (result?.warning) warnings.push(result.warning)
		else if (result) sources.push(result)
	}
	const context = { workDir: resolvedWorkDir, sources, warnings, digest: digestFor(sources, warnings), cancelled: false }
	log("info", "agentsMd", "loaded", { count: sources.length })
	return context
}

export function formatAgentsMdContext(context, heading = "read rules") {
	const lines = [`[${heading}]`, `digest: ${context.digest}`, `workdir: ${context.workDir}`]
	if (context.sources.length === 0) lines.push("(no AGENTS.md/CLAUDE.md rules found)")
	for (const source of context.sources) lines.push(`--- ${basename(source.path)}: ${source.path} ---\n${source.content}`)
	for (const warning of context.warnings) lines.push(`(${basename(warning.path)} unavailable: ${warning.path}; ${warning.reason})`)
	return `\n\n${lines.join("\n\n")}`
}
