import { readFileSync, readdirSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { SKILLS_ROOT } from "../lib/config.mjs"
import { log } from "../lib/log.mjs"

const MAX_SKILL_BYTES = 256 * 1024
let cachedCatalog = { signature: null, entries: [] }

function parseFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
	if (!match) return {}
	const result = {}
	let currentKey = null
	for (const line of match[1].split(/\r?\n/)) {
		const isIndented = /^[ \t]/.test(line)
		const kv = !isIndented && line.match(/^([a-zA-Z0-9_]+):[ \t]?(.*)$/)
		if (kv) {
			currentKey = kv[1]
			let value = kv[2].trim()
			if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
			result[currentKey] = value
		} else if (currentKey && isIndented && line.trim()) {
			result[currentKey] = `${result[currentKey] || ""} ${line.trim()}`.trim()
		}
	}
	return result
}

function skillLocations(dir, relPath = "", signature = []) {
	let dirInfo
	try {
		dirInfo = statSync(dir)
	} catch (error) {
		if (error?.code !== "ENOENT") log("warning", "load_skills", "catalog_scan_failed", { errorType: error?.name || "Error" })
		return []
	}
	signature.push(`${relPath}:${dirInfo.mtimeMs}`)
	const skillFile = join(dir, "SKILL.md")
	try {
		const skillInfo = statSync(skillFile)
		if (skillInfo.isFile()) {
			signature.push(`${relPath}/SKILL.md:${skillInfo.mtimeMs}:${skillInfo.size}`)
			return [{ key: relPath || basename(dir), dir, file: skillFile }]
		}
	} catch (error) {
		if (error?.code !== "ENOENT") log("warning", "load_skills", "catalog_scan_failed", { errorType: error?.name || "Error" })
	}
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
	} catch (error) {
		log("warning", "load_skills", "catalog_scan_failed", { errorType: error?.name || "Error" })
		return []
	}
	return entries.flatMap((entry) => {
		if (!entry.isDirectory() || entry.name.startsWith(".")) return []
		return skillLocations(join(dir, entry.name), relPath ? `${relPath}/${entry.name}` : entry.name, signature)
	})
}

function catalogEntry(location) {
	let front = {}
	try {
		front = parseFrontmatter(readFileSync(location.file, "utf8"))
	} catch (error) {
		log("warning", "load_skills", "frontmatter_read_failed", { errorType: error?.name || "Error" })
	}
	const description = front.description || "(无 description)"
	return { ...location, name: front.name || basename(location.dir), description: description.slice(0, 300) }
}

export function getSkillsCatalog() {
	const signature = []
	const locations = skillLocations(SKILLS_ROOT, "", signature)
	const fingerprint = signature.join("\n")
	if (cachedCatalog.signature === fingerprint) return cachedCatalog.entries
	const entries = locations.map(catalogEntry).sort((a, b) => a.key.localeCompare(b.key))
	cachedCatalog = { signature: fingerprint, entries }
	return entries
}

export const name = "load_skills"
export const definition = {
	name,
	title: "加载技能",
	description: "按 project_context 返回的精确 key 读取一个技能的完整 SKILL.md。tools/list 不会展开整个技能目录。",
	inputSchema: {
		type: "object",
		properties: { name: { type: "string", description: "技能 key，例如 apple-docs 或 designs/screenshot。" } },
		required: ["name"],
	},
}

function failure(message, outcome = "failed") {
	log("warning", "load_skills", "finished", { outcome, message })
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true }
}

export async function call(args, { signal } = {}) {
	const key = args?.name
	if (!key || typeof key !== "string") return failure("Missing required name string", "invalid_input")
	if (signal?.aborted) return failure("Skill read cancelled", "cancelled")
	const skill = getSkillsCatalog().find((entry) => entry.key === key)
	if (!skill) return failure(`Skill not found: ${key}. Call project_context to refresh the catalog.`, "not_found")
	try {
		const info = statSync(skill.file)
		if (info.size > MAX_SKILL_BYTES) return failure(`Skill exceeds ${MAX_SKILL_BYTES} byte limit`, "too_large")
		const bytes = await readFile(skill.file, { signal })
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		log("info", "load_skills", "finished", { outcome: "ok" })
		return { content: [{ type: "text", text: `目录：${skill.dir}\n\n${content}` }] }
	} catch (error) {
		if (signal?.aborted || error?.name === "AbortError") return failure("Skill read cancelled", "cancelled")
		log("warning", "load_skills", "finished", { outcome: "read_failed", errorType: error?.name || "Error" })
		return { content: [{ type: "text", text: "Error: Unable to read skill" }], isError: true }
	}
}
