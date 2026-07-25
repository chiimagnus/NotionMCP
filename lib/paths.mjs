// lib/paths.mjs
// Resolve a user-supplied path against the sandbox directory unless it is
// already absolute.

import { isAbsolute, join } from "node:path"
import { SANDBOX_DIR } from "./config.mjs"

export function resolvePath(inputPath) {
	return isAbsolute(inputPath) ? inputPath : join(SANDBOX_DIR, inputPath)
}
