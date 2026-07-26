import http from "node:http"
import { PROXY_PORT, UPSTREAM_PORT } from "./lib/config.mjs"

const TOKEN = process.env.MCP_TOKEN

if (!TOKEN) {
	console.error("MCP_TOKEN 未设置，拒绝启动")
	process.exit(1)
}

http
	.createServer((req, res) => {
		if (req.headers.authorization !== `Bearer ${TOKEN}`) {
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
				proxyRes.pipe(res)
			},
		)

		proxyReq.on("error", () => {
			res.writeHead(502)
			res.end("Bad Gateway")
		})

		req.pipe(proxyReq)
	})
	.listen(PROXY_PORT, "127.0.0.1", () => {
		console.log(`auth proxy on 127.0.0.1:${PROXY_PORT}`)
	})
