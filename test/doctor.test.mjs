import assert from "node:assert/strict"
import test from "node:test"

import { diagnose } from "../lib/doctor.mjs"

test("doctor 将本机、Funnel 和修复建议拆开报告", async () => {
	const ready = await diagnose({
		port: 8000,
		request: async () => ({ status: 200, body: JSON.stringify({ status: "ready", version: "2.0.0" }) }),
		tailscale: { status: async () => ({ state: "ready", publicUrl: "https://host.example/mcp" }) },
	})
	assert.deepEqual(ready, {
		ok: true,
		local: { state: "ready", version: "2.0.0" },
		funnel: { state: "ready", publicUrl: "https://host.example/mcp" },
		public: { state: "skipped" },
		remediation: [],
	})

	const failed = await diagnose({
		port: 8000,
		request: async () => ({ error: new Error("connect ECONNREFUSED") }),
		tailscale: { status: async () => ({ state: "not_logged_in" }) },
	})
	assert.equal(failed.ok, false)
	assert.deepEqual(failed.remediation, ["运行 notionmcp start，确认本机服务已启动", "运行 tailscale login 后重试"])
})

test("doctor 的公网探测必须显式 opt-in，且不携带 Token", async () => {
	let observedUrl
	const result = await diagnose({
		port: 8000,
		publicUrl: "https://public.example/mcp",
		request: async () => ({ status: 200, body: JSON.stringify({ status: "ready", version: "2.0.0" }) }),
		tailscale: { status: async () => ({ state: "ready" }) },
		publicProbe: async (url) => {
			observedUrl = url
			return { status: 401 }
		},
	})
	assert.equal(observedUrl, "https://public.example/mcp")
	assert.deepEqual(result.public, { state: "reachable" })
	assert.equal(result.ok, true)
})
