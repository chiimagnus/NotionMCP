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
	title: "Read Image",
	description:
		"只读地读取一个图片文件，并把它作为可查看的图像内容返回（而不只是原始字节或标记文本）。默认会把图片缩放到 maxSize 以内以节省 token（位图和 SVG 都适用）；传 detail: \"original\" 可以跳过缩放、拿到原始分辨率。SVG 文件会先通过平台上的栅格化工具转成 PNG；位图缩放失败时会自动降级为返回原图，不报错。相对路径会基于沙盒文件夹（" +
		SANDBOX_DIR +
		"）解析；也支持绝对路径。",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "图片文件的路径（.svg、.png、.jpg、.jpeg、.gif、.webp）。相对路径会基于沙盒文件夹解析。" },
			maxSize: {
				type: "number",
				description: `可选，缩放的最大像素尺寸（默认 ${DEFAULT_IMAGE_MAX_SIZE}，最大 ${MAX_IMAGE_MAX_SIZE}）。detail 为 "original" 时忽略此参数。`,
			},
			detail: {
				type: "string",
				enum: ["high", "original"],
				description: "图片精度。默认 high：缩放到 maxSize 以内节省 token；original：跳过缩放，位图原样返回，SVG 按允许的最大尺寸栅格化。",
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
		const error = new Error(`SVG 栅格化失败，请安装 ImageMagick 或 librsvg：${errors.join("；")}`)
		error.stderr = errors.join("\n")
		throw error
	} finally {
		await rm(outDir, { recursive: true, force: true }).catch((err) => {
			log("error", "read_image", "temp_cleanup_failed", { error: err })
		})
	}
}

// ponytail: 照抄 codex view_image 的 detail: high/original 思路。位图缩放失败/工具缺失时
// 降级返回原图而不是报错——跟 SVG 不同，位图本身已经是可查看格式，缩放只是省 token 的锦上添
// 花，不该因为主机没装 ImageMagick 就让整个 read_image 挂掉。返回 null 表示降级。
async function resizeRasterToBytes(inputBytes, ext, maxSize, signal) {
	if (signal?.aborted) throw abortError()
	const outDir = await mkdtemp(join(tmpdir(), "raster-resize-"))
	const inputPath = join(outDir, `input${ext}`)
	try {
		await writeFile(inputPath, inputBytes, { signal })
		if (process.platform === "darwin") {
			// qlmanage 只吐 PNG 缩略图，位图输入的原始格式在这条路径上保不住。
			const outputPath = join(outDir, `${basename(inputPath)}.png`)
			const result = await runRasterizer("qlmanage", ["-t", "-s", String(maxSize), "-o", outDir, inputPath], { signal })
			if (result.cancelled) throw abortError("Image resize cancelled")
			if (result.code !== 0) return null
			try {
				return { data: await readBoundedFile(outputPath, { signal, label: "Resized image" }), mimeType: "image/png" }
			} catch (err) {
				if (err.name === "AbortError") throw err
				return null
			}
		}
		const outputPath = join(outDir, `output${ext}`)
		const resize = `${maxSize}x${maxSize}>`
		const candidates = [
			["magick", [inputPath, "-resize", resize, outputPath]],
			["convert", [inputPath, "-resize", resize, outputPath]],
		]
		for (const [command, args] of candidates) {
			const result = await runRasterizer(command, args, { signal })
			if (result.cancelled) throw abortError("Image resize cancelled")
			if (result.code !== 0) continue
			try {
				return { data: await readBoundedFile(outputPath, { signal, label: "Resized image" }), mimeType: null }
			} catch (err) {
				if (err.name === "AbortError") throw err
			}
		}
		return null
	} finally {
		await rm(outDir, { recursive: true, force: true }).catch((err) => {
			log("error", "read_image", "temp_cleanup_failed", { error: err })
		})
	}
}

function parseDetail(detail) {
	if (detail === undefined) return "high"
	if (detail === "high" || detail === "original") return detail
	throw new Error(`detail must be 'high' or 'original', got '${detail}'`)
}

async function readImage({ path, maxSize, detail }, signal) {
	if (signal?.aborted) throw abortError()
	if (!path || typeof path !== "string") {
		throw new Error("Missing required 'path' string")
	}
	const resolved = resolvePath(path)
	const ext = extname(resolved).toLowerCase()
	const size = imageSize(maxSize)
	const wantsOriginal = parseDetail(detail) === "original"

	if (RASTER_MIME_TYPES[ext]) {
		const buf = await readBoundedFile(resolved, { signal })
		if (wantsOriginal) {
			return { data: buf.toString("base64"), mimeType: RASTER_MIME_TYPES[ext] }
		}
		const resized = await resizeRasterToBytes(buf, ext, size, signal)
		if (!resized) {
			log("warning", "read_image", "raster_resize_skipped", { reason: "resize tool unavailable or failed" })
			return { data: buf.toString("base64"), mimeType: RASTER_MIME_TYPES[ext] }
		}
		return { data: resized.data.toString("base64"), mimeType: resized.mimeType || RASTER_MIME_TYPES[ext] }
	}
	if (ext === ".svg") {
		const svg = await readBoundedFile(resolved, { signal, label: "SVG input" })
		const rasterSize = wantsOriginal ? MAX_IMAGE_MAX_SIZE : size
		const buf = await rasterizeSvgToPng(svg, rasterSize, signal)
		return { data: buf.toString("base64"), mimeType: "image/png" }
	}
	throw new Error(`Unsupported image extension '${ext}'. Supported: .svg .png .jpg .jpeg .gif .webp`)
}

export async function call(args, context = {}) {
	let result
	try {
		result = await readImage(args || {}, context.signal)
	} catch (err) {
		if (err.name === "AbortError") throw err
		// ponytail: 参数缺失、后缀不支持、文件读不到——都是调用方给的输入和实际状态对不上，
		// 不是 NotionMCP 自己的进程故障，本地接住记 warning，不走顶层兼底的 error。
		log("warning", "read_image", "finished", { outcome: "failed", error: err })
		return { content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true }
	}
	log("info", "read_image", "finished", { outcome: "ok", mimeType: result.mimeType })
	return { content: [{ type: "image", data: result.data, mimeType: result.mimeType }] }
}
