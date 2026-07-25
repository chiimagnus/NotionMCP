// tools/read_image.mjs
// The `read_image` tool: read an image file back as viewable image content
// (base64) so the calling model can actually see it. SVGs are rasterized to
// PNG first via macOS's built-in QuickLook (qlmanage).

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
		"读取一个图片文件，并把它作为可查看的图像内容返回（而不只是原始字节或标记文本），这样调用方模型才能真正“看到”这张图。SVG 文件会先通过 macOS 自带的 QuickLook 自动栅格化为 PNG，因为矢量标记本身无法直接当作图像查看。相对路径会基于沙盒文件夹（" +
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

export async function call(args) {
	const { data, mimeType } = await readImage(args || {})
	return { content: [{ type: "image", data, mimeType }] }
}
