import http from "node:http"

function localRequest(port, timeoutMs = 2_000) {
	return new Promise((resolve) => {
		const request = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: timeoutMs }, (response) => {
			const chunks = []
			response.on("data", (chunk) => chunks.push(chunk))
			response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }))
		})
		request.once("timeout", () => request.destroy(new Error("timeout")))
		request.once("error", (error) => resolve({ error }))
	})
}

async function publicRequest(url) {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		})
		return { status: response.status }
	} catch (error) {
		return { error }
	}
}

export async function diagnose({ port, tailscale, publicUrl, request = localRequest, publicProbe = publicRequest }) {
	const [localResult, funnel] = await Promise.all([request(port), tailscale.status(port)])
	let local
	try {
		const health = localResult.status === 200 ? JSON.parse(localResult.body) : null
		local = health?.status === "ready" ? { state: "ready", version: health.version } : { state: "unavailable" }
	} catch {
		local = { state: "unavailable" }
	}
	if (localResult.error) local = { state: localResult.error.message === "timeout" ? "timeout" : "unavailable" }
	const publicResult = publicUrl ? await publicProbe(publicUrl) : null
	const publicStatus = !publicUrl
		? { state: "skipped" }
		: publicResult?.status === 401
			? { state: "reachable" }
			: { state: publicResult?.error?.message === "timeout" ? "timeout" : "unreachable" }
	const remediation = []
	if (local.state !== "ready") remediation.push("运行 notionmcp start，确认本机服务已启动")
	if (funnel.state === "not_logged_in") remediation.push("运行 tailscale login 后重试")
	else if (funnel.state === "missing" || funnel.state === "disabled") remediation.push("运行 notionmcp start 重新配置 Funnel /mcp 路由")
	else if (funnel.state === "wrong_target") remediation.push("检查 Tailscale Funnel 的 /mcp 路由，避免覆盖其他服务")
	else if (funnel.state === "timeout" || funnel.state === "unavailable") remediation.push("检查 Tailscale 客户端是否运行且可响应")
	if (publicStatus.state === "unreachable" || publicStatus.state === "timeout") remediation.push("确认 Notion 使用的公网 /mcp URL 与 Funnel 状态一致")
	return { ok: local.state === "ready" && funnel.state === "ready" && publicStatus.state !== "unreachable" && publicStatus.state !== "timeout", local, funnel, public: publicStatus, remediation }
}
