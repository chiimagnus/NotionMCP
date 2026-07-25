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
