// lib/config.mjs
// Shared constants for the exec-server MCP tools.

import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// 相对于本文件自身位置计算仓库根目录，避免硬编码绝对路径。
const MCP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export const SANDBOX_DIR =
	process.env.MCP_SANDBOX_DIR || join(homedir(), "Github_OpenSource", "AI-Share")
export const SKILLS_ROOT =
	process.env.MCP_SKILLS_DIR || join(homedir(), ".codex", "skills")
export const LOG_FILE = join(MCP_ROOT, "exec.log")
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 3_600_000 // 1 hour ceiling; pass timeoutMs to raise up to this
export const MAX_OUTPUT_CHARS = 100_000
export const DEFAULT_IMAGE_MAX_SIZE = 1024
export const MAX_IMAGE_MAX_SIZE = 2000

export const RASTER_MIME_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
}
