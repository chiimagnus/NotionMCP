#!/usr/bin/env node
// exec-server.mjs
// Zero-dependency MCP server (stdio transport) exposing two tools:
//   1. run_command — run arbitrary shell commands on this Mac.
//   2. read_image  — read an image file back as viewable image content
//                     (base64), so the calling AI can actually see it,
//                     not just its raw text/bytes. SVGs are rasterized to
//                     PNG first via macOS's built-in QuickLook (qlmanage),
//                     since most viewers expect raster bytes, not vector
//                     markup.
//
// SECURITY NOTE (read this before exposing it to the internet):
// - This is NOT a hard sandbox. `cwd` is only a *default* working directory,
//   not an enforced boundary. A command like `cd / && rm -rf ...` or any
//   absolute path will still execute outside the sandbox folder. Same goes
//   for read_image's `path` — it can point anywhere on disk.
// - The only thing standing between "anyone on the internet" and "arbitrary
//   code execution on this Mac" is the bearer token checked by auth-proxy.mjs
//   in front of this server. Keep that token secret (keychain only, never in
//   Notion pages, repos, or chat logs).
// - Every run_command call is appended to ~/.mcp/exec.log (timestamp +
//   command + exit code) purely for your own audit/debugging. This is NOT a
//   safety gate; it does not block or slow down execution.

import { spawn } from "node:child_process"
import { appendFile, readFile, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, isAbsolute, extname, basename } from "node:path"

const SANDBOX_DIR =
	process.env.MCP_SANDBOX_DIR || join(homedir(), "Github_OpenSource", "AI-Share")
const LOG_FILE = join(homedir(), ".mcp", "exec.log")
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 3_600_000 // 1 hour ceiling; pass timeoutMs to raise up to this
const MAX_OUTPUT_CHARS = 100_000
const DEFAULT_IMAGE_MAX_SIZE = 1024
const MAX_IMAGE_MAX_SIZE = 2000

function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n")
}

function log(line) {
	appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`).catch(() => {})
}

function truncate(s) {
	if (s.length <= MAX_OUTPUT_CHARS) return s
	return (
		s.slice(0, MAX_OUTPUT_CHARS) +
		`\n...[truncated, ${s.length - MAX_OUTPUT_CHARS} more chars]`
	)
}

function runCommand({ command, cwd, timeoutMs }) {
	return new Promise((resolve) => {
		if (!command || typeof command !== "string") {
			resolve({ code: -1, stdout: "", stderr: "Missing required 'command' string", timedOut: false })
			return
		}
		const workDir = cwd ? join(SANDBOX_DIR, cwd) : SANDBOX_DIR
		const timeout = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
		let child
		try {
			child = spawn("/bin/sh", ["-c", command], { cwd: workDir, env: process.env })
		} catch (err) {
			resolve({ code: -1, stdout: "", stderr: String(err), timedOut: false })
			return
		}
		let stdout = ""
		let stderr = ""
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeout)
		child.stdout.on("data", (d) => (stdout += d))
		child.stderr.on("data", (d) => (stderr += d))
		child.on("close", (code) => {
			clearTimeout(timer)
			log(`cmd=${JSON.stringify(command)} cwd=${JSON.stringify(workDir)} exit=${code} timedOut=${timedOut}`)
			resolve({ code, stdout: truncate(stdout), stderr: truncate(stderr), timedOut })
		})
		child.on("error", (err) => {
			clearTimeout(timer)
			resolve({ code: -1, stdout, stderr: String(err), timedOut: false })
		})
	})
}

const RASTER_MIME_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
}

function resolvePath(inputPath) {
	return isAbsolute(inputPath) ? inputPath : join(SANDBOX_DIR, inputPath)
}

function rasterizeSvgToPng(svgPath, maxSize) {
	return new Promise(async (resolve, reject) => {
		let outDir
		try {
			outDir = await mkdtemp(join(tmpdir(), "svg-thumb-"))
		} catch (err) {
			reject(err)
			return
		}
		const child = spawn("qlmanage", ["-t", "-s", String(maxSize), "-o", outDir, svgPath])
		let stderr = ""
		child.stderr.on("data", (d) => (stderr += d))
		child.on("error", (err) => reject(err))
		child.on("close", async (code) => {
			if (code !== 0) {
				reject(new Error(`qlmanage exited ${code}: ${stderr}`))
				return
			}
			try {
				const pngPath = join(outDir, `${basename(svgPath)}.png`)
				const buf = await readFile(pngPath)
				resolve(buf)
			} catch (err) {
				reject(err)
			} finally {
				rm(outDir, { recursive: true, force: true }).catch(() => {})
			}
		})
	})
}

async function readImage({ path, maxSize }) {
	if (!path || typeof path !== "string") {
		throw new Error("Missing required 'path' string")
	}
	const resolved = resolvePath(path)
	const ext = extname(resolved).toLowerCase()
	const size = Math.min(Number(maxSize) || DEFAULT_IMAGE_MAX_SIZE, MAX_IMAGE_MAX_SIZE)

	if (RASTER_MIME_TYPES[ext]) {
		const buf = await readFile(resolved)
		return { data: buf.toString("base64"), mimeType: RASTER_MIME_TYPES[ext] }
	}
	if (ext === ".svg") {
		const buf = await rasterizeSvgToPng(resolved, size)
		return { data: buf.toString("base64"), mimeType: "image/png" }
	}
	throw new Error(`Unsupported image extension '${ext}'. Supported: .svg .png .jpg .jpeg .gif .webp`)
}

const tools = [
	{
		name: "run_command",
		description:
			"Run a shell command on this Mac (executed via /bin/sh -c). Default working directory is " +
			SANDBOX_DIR +
			". This is NOT a hard sandbox — commands can still reach paths outside the working directory (absolute paths, `cd ..`, etc). Use for running python/pip, editing files, generating images/SVGs, training scripts, and any other command-line task.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run." },
				cwd: { type: "string", description: "Optional subdirectory relative to the sandbox folder." },
				timeoutMs: {
					type: "number",
					description: `Optional timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). Raise this for long-running jobs like model training.`,
				},
			},
			required: ["command"],
		},
	},
	{
		name: "read_image",
		description:
			"Read an image file back as viewable image content, so the calling model can actually see it (not just its raw bytes/markup). SVG files are automatically rasterized to PNG first (via macOS's built-in QuickLook), since vector markup can't be viewed directly as an image. Relative paths resolve against the sandbox folder (" +
			SANDBOX_DIR +
			"); absolute paths also work.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the image file (.svg, .png, .jpg, .jpeg, .gif, .webp). Relative paths resolve against the sandbox folder." },
				maxSize: {
					type: "number",
					description: `Optional max pixel dimension when rasterizing SVGs (default ${DEFAULT_IMAGE_MAX_SIZE}, max ${MAX_IMAGE_MAX_SIZE}). Ignored for already-raster formats.`,
				},
			},
			required: ["path"],
		},
	},
]

let buffer = ""
process.stdin.on("data", (chunk) => {
	buffer += chunk
	let idx
	while ((idx = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, idx)
		buffer = buffer.slice(idx + 1)
		if (line.trim()) handleLine(line)
	}
})

async function handleLine(line) {
	let msg
	try {
		msg = JSON.parse(line)
	} catch {
		return
	}
	const { id, method, params } = msg

	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "exec-server", version: "1.1.0" },
			},
		})
		return
	}
	if (method === "notifications/initialized" || method === "ping") {
		if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} })
		return
	}
	if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools } })
		return
	}
	if (method === "tools/call") {
		const { name, arguments: args } = params || {}
		if (name === "run_command") {
			try {
				const result = await runCommand(args || {})
				const text = `exit code: ${result.code}${result.timedOut ? " (timed out, process killed)" : ""}\n\n--- stdout ---\n${result.stdout}\n\n--- stderr ---\n${result.stderr}`
				send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })
			} catch (err) {
				send({
					jsonrpc: "2.0",
					id,
					result: { content: [{ type: "text", text: `Error: ${err}` }], isError: true },
				})
			}
			return
		}
		if (name === "read_image") {
			try {
				const { data, mimeType } = await readImage(args || {})
				send({ jsonrpc: "2.0", id, result: { content: [{ type: "image", data, mimeType }] } })
			} catch (err) {
				send({
					jsonrpc: "2.0",
					id,
					result: { content: [{ type: "text", text: `Error: ${err}` }], isError: true },
				})
			}
			return
		}
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } })
		return
	}
	if (id !== undefined) {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } })
	}
}

process.stdin.resume()
