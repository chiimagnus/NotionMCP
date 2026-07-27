import http from "node:http"
import { timingSafeEqual } from "node:crypto"
import { PROXY_PORT, UPSTREAM_PORT } from "./config.mjs"

const TOKEN = process.env.MCP_TOKEN

if (!TOKEN) {
	console.error("MCP_TOKEN 未设置，拒绝启动")
	process.exit(1)
}

const expectedAuthorization = Buffer.from(`Bearer ${TOKEN}`)

function authorized(header) {
	const actual = Buffer.from(header || "")
	return actual.length === expectedAuthorization.length && timingSafeEqual(actual, expectedAuthorization)
}

http
	.createServer((req, res) => {
		if (!authorized(req.headers.authorization)) {
			res.writeHead(401, { "content-type": "text/plain" })
			res.end("Unauthorized")
			return
		}

		const proxyReq = http.request(
			{
				host: "127.0.0.1",
				port: UPSTREAM_PORT,
				path: req.url,
				method: req.method,
				headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` },
			},
			(proxyRes) => {
				res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
				res.flushHeaders?.()
				proxyRes.on("error", () => res.destroy())
				proxyRes.pipe(res)
			},
		)

		proxyReq.on("error", () => {
			if (res.destroyed) return
			if (res.headersSent) {
				res.destroy()
				return
			}
			res.writeHead(502).end("Bad Gateway")
		})
		req.on("aborted", () => proxyReq.destroy())
		req.on("error", () => proxyReq.destroy())
		res.on("close", () => {
			if (!res.writableEnded) proxyReq.destroy()
		})

		req.pipe(proxyReq)
	})
	.listen(PROXY_PORT, "127.0.0.1", () => {
		console.log(`auth proxy on 127.0.0.1:${PROXY_PORT}`)
	})
