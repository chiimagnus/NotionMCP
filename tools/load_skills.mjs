// tools/load_skills.mjs
// The `load_skills` tool: at server startup, scan ~/.codex/skills and embed
// every skill's frontmatter description directly into this tool's own
// `definition.description` (so the catalog is visible right from tools/list,
// no separate "list skills" call is needed). Calling the tool with a skill's
// key then returns that skill's full SKILL.md content and folder path.
// Skills can be nested at any depth (e.g. "designs/screenshot",
// "workflow/init"); a directory counts as a skill once it has its own
// SKILL.md, and traversal stops there (its subfolders are skill resources,
// not further skills). Directories starting with "." are skipped.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { SKILLS_ROOT } from "../lib/config.mjs"
import { log } from "../lib/rpc.mjs"

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
			if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1)
			}
			result[currentKey] = value
		} else if (currentKey && isIndented && line.trim()) {
			const cont = line.trim()
			result[currentKey] = result[currentKey] ? `${result[currentKey]} ${cont}` : cont
		}
	}
	return result
}

function findSkills(dir, relPath = "") {
	let isSkill = false
	try {
		isSkill = statSync(join(dir, "SKILL.md")).isFile()
	} catch {}

	if (isSkill) {
		let front = {}
		try {
			front = parseFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf-8"))
		} catch {}
		return [
			{
				key: relPath || basename(dir),
				name: front.name || basename(dir),
				description: front.description || "(\u65e0 description)",
				dir,
			},
		]
	}

	let entries = []
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}

	const found = []
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue
		const childRel = relPath ? `${relPath}/${entry.name}` : entry.name
		found.push(...findSkills(join(dir, entry.name), childRel))
	}
	return found
}

function loadCatalog() {
	try {
		return findSkills(SKILLS_ROOT).sort((a, b) => a.key.localeCompare(b.key))
	} catch {
		return []
	}
}

const catalog = loadCatalog()
const catalogByKey = Object.fromEntries(catalog.map((s) => [s.key, s]))

const catalogText = catalog.length
	? catalog.map((s) => `- ${s.key}\uff1a${s.description}`).join("\n")
	: `(\u5728 ${SKILLS_ROOT} \u4e0b\u6ca1\u6709\u53d1\u73b0\u4efb\u4f55 skill)`

export const name = "load_skills"

export const definition = {
	name,
	title: "\u52a0\u8f7d\u6280\u80fd",
	description:
		`\u6309 key \u52a0\u8f7d ${SKILLS_ROOT} \u4e0b\u67d0\u4e2a\u6280\u80fd\uff08skill\uff09\u7684\u5b8c\u6574 SKILL.md \u5185\u5bb9\u4e0e\u6240\u5728\u76ee\u5f55\u8def\u5f84\u3002\u6280\u80fd\u76ee\u5f55\u53ef\u4ee5\u5d4c\u5957\u4efb\u610f\u5c42\u7ea7\uff0ckey \u5c31\u662f\u76f8\u5bf9 ${SKILLS_ROOT} \u7684\u8def\u5f84\uff08\u4f8b\u5982 "apple-docs"\u3001"designs/screenshot"\u3001"workflow/init"\uff09\u3002\u4e0b\u9762\u662f\u5f53\u524d\u6240\u6709\u53ef\u7528\u6280\u80fd\u53ca\u7b80\u4ecb\uff0c\u4efb\u52a1\u5339\u914d\u67d0\u4e2a\u6280\u80fd\u65f6\uff0c\u76f4\u63a5\u7528\u5b83\u7684 key \u8c03\u7528\u672c\u5de5\u5177\u83b7\u53d6\u5b8c\u6574\u6307\u5f15\uff1a\n\n${catalogText}`,
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "\u6280\u80fd key\uff08\u76f8\u5bf9\u6280\u80fd\u6839\u76ee\u5f55\u7684\u8def\u5f84\uff09\uff0c\u4f8b\u5982 \"apple-docs\" \u6216 \"designs/screenshot\"\u3002",
			},
		},
		required: ["name"],
	},
}

export async function call(args) {
	const key = args && args.name
	if (!key || typeof key !== "string") {
		return { content: [{ type: "text", text: "\u7f3a\u5c11\u5fc5\u586b\u53c2\u6570 name" }], isError: true }
	}
	const skill = catalogByKey[key]
	if (!skill) {
		const available = catalog.map((s) => s.key).join(", ") || "(\u65e0)"
		log(`load_skills ${JSON.stringify(key)} -> not found`)
		return {
			content: [{ type: "text", text: `\u672a\u627e\u5230\u6280\u80fd "${key}"\u3002\u53ef\u7528\u6280\u80fd key\uff1a${available}` }],
			isError: true,
		}
	}
	let content
	try {
		content = readFileSync(join(skill.dir, "SKILL.md"), "utf-8")
	} catch (err) {
		log(`load_skills ${JSON.stringify(key)} -> read failed: ${err && err.message ? err.message : err}`)
		return { content: [{ type: "text", text: `\u8bfb\u53d6\u5931\u8d25\uff1a${err}` }], isError: true }
	}
	log(`load_skills ${JSON.stringify(key)} -> ok`)
	return {
		content: [{ type: "text", text: `\u76ee\u5f55\uff1a${skill.dir}\n\n${content}` }],
		isError: false,
	}
}
