// lib/config.mjs
// Shared constants for the exec-server MCP tools.

import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// 这个文件自己在 <仓库根目录>/lib/config.mjs，往上一级就是仓库根目录。
// 用 import.meta.url 自己算路径，以后整个文件夹再搬家也不用改这里
// （这也是 2026.7.26 从 ~/.mcp 搬到 NotionMCP/ 时暴露的一个坑：旧版硬编码
// 了 homedir()/.mcp/exec.log，搬家后目录不存在，appendFile 静默失败，
// 审计日志断更但完全不报错——所以才要改成自解析）。
const MCP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export const SANDBOX_DIR =
	process.env.MCP_SANDBOX_DIR || join(homedir(), "Github_OpenSource", "AI-Share")
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
