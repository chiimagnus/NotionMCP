// tools/read_image.mjs
// The `read_image` tool: read an image file back as viewable image content
// (base64) so the calling model can actually see it. SVGs are rasterized to
// PNG first via a platform-native rasterizer.

import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, extname, basename } from "node:path"
import {
	SANDBOX_DIR,
	DEFAULT_IMAGE_MAX_SIZE,
	MAX_IMAGE_MAX_SIZE,
	RASTER_MIME_TYPES,
} from "../lib/config.mjs"
import { resolvePath } from "../lib/paths.mjs"
import { log } from "../lib/log.mjs"
import { registerChild, terminateProcessTree, unregisterChild } from "../lib/process-tree.mjs"

export const name = "read_image"
// ponytail: 单用户 MCP 把单张输入/输出限制为 10 MiB；需要处理素材库时应改为流式外部存储。
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_RASTERIZER_STDERR_BYTES = 8 * 1024
const RASTERIZER_TIMEOUT_MS = 30_000

export const definition = {
	name,
	title: "读取图片",
	description:
		"读取一个图片文件，并把它作为可查看的图像内容返回（而不只是原始字节或标记文本），这样调用方模型才能真正“看到”这张图。SVG 文件会先通过平台上的栅格化工具转成 PNG：macOS 使用 qlmanage，Linux/Windows 使用 ImageMagick（magick）或 rsvg-convert。相对路径会基于沙盒文件夹（" +
		SANDBOX_DIR +
		"）解析；也支持绝对路径。",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "图片文件的路径（.svg、.png、.jpg、.jpeg、.gif、.webp）。相对路径会基于沙盒文件夹解析。" },
			maxSize: {
				type: "number",
				description: `可选，栅格化 SVG 时的最大像素尺寸（默认 ${DEFAULT_IMAGE_MAX_SIZE}，最大 ${MAX_IMAGE_MAX_SIZE}）。对已经是位图格式的文件无效。`,
			},
		},
		required: ["path"],
	},
}

function abortError(message = "Image read cancelled") {
	const error = new Error(message)
	error.name = "AbortError"
	return error
}

function imageSize(maxSize) {
	if (maxSize === undefined) return DEFAULT_IMAGE_MAX_SIZE
	if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > MAX_IMAGE_MAX_SIZE) {
		throw new Error(`maxSize must be an integer from 1 to ${MAX_IMAGE_MAX_SIZE}`)
	}
	return maxSize
}

export async function readBoundedFile(path, { signal, label = "Image" } = {}) {
	if (signal?.aborted) throw abortError()
	const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0))
	try {
		const info = await handle.stat()
		if (!info.isFile()) throw new Error(`${label} must be a regular file`)
		const chunks = []
		let observed = 0
		const stream = handle.createReadStream({
			autoClose: false,
			highWaterMark: 64 * 1024,
			signal,
		})
		try {
			for await (const chunk of stream) {
				observed += chunk.length
				if (observed > MAX_IMAGE_BYTES) {
					throw new Error(`${label} is too large: observed ${observed} bytes, limit ${MAX_IMAGE_BYTES}`)
				}
				chunks.push(chunk)
			}
		} finally {
			stream.destroy()
		}
		return Buffer.concat(chunks, observed)
	} finally {
		await handle.close()
	}
}

function stderrCollector() {
	const chunks = []
	let bytes = 0
	let discarded = 0
	return {
		append(chunk) {
			const buffer = Buffer.from(chunk)
			const kept = Math.max(Math.min(MAX_RASTERIZER_STDERR_BYTES - bytes, buffer.length), 0)
			if (kept) {
				chunks.push(buffer.subarray(0, kept))
				bytes += kept
			}
			discarded += buffer.length - kept
		},
		value() {
			const decoded = new TextDecoder().decode(Buffer.concat(chunks, bytes))
			const expanded = Buffer.byteLength(decoded) > MAX_RASTERIZER_STDERR_BYTES
			const suffix = discarded
				? `\n...[truncated, ${discarded} more bytes]`
				: expanded
					? "\n...[truncated]"
					: ""
			return truncateUtf8(decoded, MAX_RASTERIZER_STDERR_BYTES - Buffer.byteLength(suffix)) + suffix
		},
	}
}

function truncateUtf8(text, maxBytes) {
	const encoded = Buffer.from(text)
	if (encoded.length <= maxBytes) return text
	const decoder = new TextDecoder("utf-8", { fatal: true })
	for (let end = maxBytes; end > 0; end -= 1) {
		try {
			return decoder.decode(encoded.subarray(0, end))
		} catch {}
	}
	return ""
}

export function runRasterizer(command, args, { signal, timeoutMs = RASTERIZER_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ code: -1, stderr: "Rasterizer cancelled", timedOut: false, cancelled: true })
			return
		}
		let settled = false
		let stopPromise = null
		const stderr = stderrCollector()
		const finish = (code, { error, timedOut = false, cancelled = false } = {}) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child?.stderr?.off("data", onStderr)
			child?.off("error", onError)
			child?.off("close", onClose)
			signal?.removeEventListener?.("abort", onAbort)
			unregisterChild(child)
			if (error) stderr.append(String(error.message || error))
			resolve({ code: code ?? -1, stderr: stderr.value(), timedOut, cancelled })
		}
		let child
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "ignore", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
			})
			registerChild(child)
		} catch (err) {
			stderr.append(String(err))
			resolve({ code: -1, stderr: stderr.value(), timedOut: false, cancelled: false })
			return
		}
		const stop = (reason, error) => {
			if (settled || stopPromise) return
			stopPromise = terminateProcessTree(child).finally(() => {
				child.stderr?.destroy()
				finish(child.exitCode, {
					error,
					timedOut: reason === "timeout",
					cancelled: reason === "cancelled",
				})
			})
		}
		const onStderr = (data) => stderr.append(data)
		const onAbort = () => stop("cancelled")
		const onError = (error) => stop("error", error)
		const onClose = (code) => {
			if (!stopPromise) finish(code)
		}
		const timer = setTimeout(() => stop("timeout"), timeoutMs)
		child.stderr?.on("data", onStderr)
		child.once("error", onError)
		child.once("close", onClose)
		signal?.addEventListener?.("abort", onAbort, { once: true })
		if (signal?.aborted) onAbort()
	})
}

async function rasterizeSvgToPng(svgBytes, maxSize, signal) {
	if (signal?.aborted) throw abortError()
	const outDir = await mkdtemp(join(tmpdir(), "svg-thumb-"))
	const svgPath = join(outDir, "input.svg")
	const pngPath = process.platform === "darwin" ? join(outDir, `${basename(svgPath)}.png`) : join(outDir, "output.png")
	const resize = `${maxSize}x${maxSize}>`
	const errors = []
	try {
		await writeFile(svgPath, svgBytes, { signal })
		svgBytes = null
		const candidates =
			process.platform === "darwin"
				? [["qlmanage", ["-t", "-s", String(maxSize), "-o", outDir, svgPath]]]
				: [
					["magick", [svgPath, "-resize", resize, pngPath]],
					["convert", [svgPath, "-resize", resize, pngPath]],
					["rsvg-convert", ["--width", String(maxSize), "--output", pngPath, svgPath]],
				]
		for (const [command, args] of candidates) {
			const result = await runRasterizer(command, args, { signal })
			if (result.cancelled) throw abortError("SVG rasterization cancelled")
			if (result.code !== 0) {
				const reason = result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.code}`
				errors.push(`${command}: ${reason}`)
				continue
			}
			try {
				return await readBoundedFile(pngPath, { signal, label: "Rasterized image" })
			} catch (err) {
				if (err.name === "AbortError") throw err
				errors.push(`${command}: ${err.message}`)
			}
		}
		throw new Error(`SVG 栅格化失败，请安装 ImageMagick 或 librsvg：${errors.join("；")}`)
	} finally {
		await rm(outDir, { recursive: true, force: true }).catch((err) => {
			log("error", "read_image", "temp_cleanup_failed", { error: err })
		})
	}
}

async function readImage({ path, maxSize }, signal) {
	if (signal?.aborted) throw abortError()
	if (!path || typeof path !== "string") {
		throw new Error("Missing required 'path' string")
	}
	const resolved = resolvePath(path)
	const ext = extname(resolved).toLowerCase()
	const size = imageSize(maxSize)

	if (RASTER_MIME_TYPES[ext]) {
		const buf = await readBoundedFile(resolved, { signal })
		return { data: buf.toString("base64"), mimeType: RASTER_MIME_TYPES[ext] }
	}
	if (ext === ".svg") {
		const svg = await readBoundedFile(resolved, { signal, label: "SVG input" })
		const buf = await rasterizeSvgToPng(svg, size, signal)
		return { data: buf.toString("base64"), mimeType: "image/png" }
	}
	throw new Error(`Unsupported image extension '${ext}'. Supported: .svg .png .jpg .jpeg .gif .webp`)
}

export async function call(args, context = {}) {
	const { data, mimeType } = await readImage(args || {}, context.signal)
	log("info", "read_image", "finished", { outcome: "ok", mimeType })
	return { content: [{ type: "image", data, mimeType }] }
}
