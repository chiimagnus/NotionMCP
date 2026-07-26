// tools/read_image.mjs
// The `read_image` tool: read an image file back as viewable image content
// (base64) so the calling model can actually see it. SVGs are rasterized to
// PNG first via a platform-native rasterizer.

import { spawn } from "node:child_process"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, extname, basename } from "node:path"
import {
	SANDBOX_DIR,
	DEFAULT_IMAGE_MAX_SIZE,
	MAX_IMAGE_MAX_SIZE,
	RASTER_MIME_TYPES,
} from "../lib/config.mjs"
import { resolvePath } from "../lib/paths.mjs"

export const name = "read_image"

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

function runRasterizer(command, args) {
	return new Promise((resolve) => {
		let settled = false
		let stderr = ""
		const finish = (result) => {
			if (settled) return
			settled = true
			resolve(result)
		}
		let child
		try {
			child = spawn(command, args)
		} catch (err) {
			finish({ code: -1, stderr: String(err) })
			return
		}
		child.stderr.on("data", (d) => (stderr += d))
		child.on("error", (err) => finish({ code: -1, stderr: String(err) }))
		child.on("close", (code) => finish({ code, stderr }))
	})
}

async function rasterizeSvgToPng(svgPath, maxSize) {
	const outDir = await mkdtemp(join(tmpdir(), "svg-thumb-"))
	const pngPath = join(outDir, `${basename(svgPath)}.png`)
	const resize = `${maxSize}x${maxSize}>`
	const candidates =
		process.platform === "darwin"
			? [["qlmanage", ["-t", "-s", String(maxSize), "-o", outDir, svgPath]]]
			: [
				["magick", [svgPath, "-resize", resize, pngPath]],
				["convert", [svgPath, "-resize", resize, pngPath]],
				["rsvg-convert", ["--width", String(maxSize), "--output", pngPath, svgPath]],
			]
	const errors = []
	try {
		for (const [command, args] of candidates) {
			const result = await runRasterizer(command, args)
			if (result.code !== 0) {
				errors.push(`${command}: ${result.stderr.trim() || `exit ${result.code}`}`)
				continue
			}
			try {
				return await readFile(pngPath)
			} catch (err) {
				errors.push(`${command}: 输出 PNG 不存在（${err.message}）`)
			}
		}
		throw new Error(`SVG 栅格化失败，请安装 ImageMagick 或 librsvg：${errors.join("；")}`)
	} finally {
		await rm(outDir, { recursive: true, force: true }).catch(() => {})
	}
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

export async function call(args) {
	const { data, mimeType } = await readImage(args || {})
	return { content: [{ type: "image", data, mimeType }] }
}
