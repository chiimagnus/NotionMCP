import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"

import { SANDBOX_DIR, SKILLS_ROOT } from "../lib/config.mjs"
import { formatAgentsMdContext, getAgentsMdContext } from "../lib/agentsMd.mjs"
import { log } from "../lib/log.mjs"
import { resolvePath } from "../lib/paths.mjs"

let cachedCatalog = { signature: null, entries: [] }

export const name = "read_rules"
export const definition = {
	name,
	title: "Read Rules",
	description: "只读地加载全局 ~/.codex/AGENTS.md、当前项目从外到内的 AGENTS.md，以及所有可用 skills 的 key、SKILL.md 路径、name、description。开始开发任务时先调用，随后用 read_file 按需读取技能正文。",
	inputSchema: {
		type: "object",
		properties: {
			cwd: { type: "string", description: "可选，相对默认工作目录的子目录或绝对目录。" },
		},
	},
}

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
		if (error?.code !== "ENOENT") log("warning", "read_rules", "catalog_scan_failed", { errorType: error?.name || "Error" })
		return []
	}
	signature.push(`${relPath}:${dirInfo.mtimeMs}`)
	const file = join(dir, "SKILL.md")
	try {
		const skillInfo = statSync(file)
		if (skillInfo.isFile()) {
			signature.push(`${relPath}/SKILL.md:${skillInfo.mtimeMs}:${skillInfo.size}`)
			return [{ key: relPath || basename(dir), dir, file }]
		}
	} catch (error) {
		if (error?.code !== "ENOENT") log("warning", "read_rules", "catalog_scan_failed", { errorType: error?.name || "Error" })
	}
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
	} catch (error) {
		log("warning", "read_rules", "catalog_scan_failed", { errorType: error?.name || "Error" })
		return []
	}
	return entries.flatMap((entry) => {
		if (!entry.isDirectory() || entry.name.startsWith(".")) return []
		return skillLocations(join(dir, entry.name), relPath ? `${relPath}/${entry.name}` : entry.name, signature)
	})
}

function getSkillsCatalog() {
	const signature = []
	const locations = skillLocations(SKILLS_ROOT, "", signature)
	const fingerprint = signature.join("\n")
	if (cachedCatalog.signature === fingerprint) return cachedCatalog.entries
	const entries = locations
		.map((location) => {
			let front = {}
			try {
				front = parseFrontmatter(readFileSync(location.file, "utf8"))
			} catch (error) {
				log("warning", "read_rules", "frontmatter_read_failed", { errorType: error?.name || "Error" })
			}
			return { ...location, name: front.name || basename(location.dir), description: (front.description || "(无 description)").slice(0, 300) }
		})
		.sort((a, b) => a.key.localeCompare(b.key))
	cachedCatalog = { signature: fingerprint, entries }
	return entries
}

function formatSkillsCatalog() {
	const skills = getSkillsCatalog()
	if (skills.length === 0) return "\n\n[available skills]\n(no skills found)"
	return `\n\n[available skills]\n${skills
		.map((skill) => `- key: ${skill.key}\n  path: ${skill.file}\n  name: ${skill.name}\n  description: ${skill.description}`)
		.join("\n")}`
}

export async function call(args, { signal } = {}) {
	const cwd = args?.cwd
	if (cwd !== undefined && typeof cwd !== "string") {
		return { content: [{ type: "text", text: "Error: cwd must be a string" }], isError: true }
	}
	const workDir = cwd ? resolvePath(cwd) : SANDBOX_DIR
	const context = await getAgentsMdContext(workDir, { signal })
	if (context.cancelled) return { content: [{ type: "text", text: "Error: Project context read cancelled" }], isError: true }
	if (signal?.aborted) return { content: [{ type: "text", text: "Error: Project context read cancelled" }], isError: true }
	const text = formatAgentsMdContext(context) + formatSkillsCatalog()
	return { content: [{ type: "text", text }] }
}
