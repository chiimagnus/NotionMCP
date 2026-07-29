export const FUNNEL_PATH = "/mcp"
export const MCP_FUNNEL_PATHS = [FUNNEL_PATH, "/mcp/sse", "/mcp/messages"]

function targetFor(port, path = FUNNEL_PATH) {
	return `http://127.0.0.1:${port}${path}`
}

function legacyTargetFor(port) {
	return `http://127.0.0.1:${port}`
}

function resultDetail(result) {
	return result.error?.message || result.stderr?.trim() || (result.timedOut ? "command timed out" : `exit ${result.status ?? "unknown"}`)
}

function commandError(action, result) {
	const error = new Error(`${action}：${resultDetail(result)}`)
	error.stderr = result.stderr || ""
	return error
}

function commandFailed(result) {
	return result.timedOut || result.error || result.status !== 0
}

export function inspectFunnelStatus(result, port, now = Date.now) {
	const checkedAt = new Date(now()).toISOString()
	if (result.timedOut) return { state: "timeout", checkedAt }
	if (result.error || result.status !== 0) {
		return {
			state: /not logged in|login/i.test(resultDetail(result)) ? "not_logged_in" : "unavailable",
			checkedAt,
		}
	}
	let status
	try {
		status = JSON.parse(result.stdout)
	} catch {
		return { state: "unavailable", checkedAt }
	}
	const target = targetFor(port)
	let route
	for (const [host, server] of Object.entries(status.Web || {})) {
		const handlers = server?.Handlers || {}
		const allowed = status.AllowFunnel?.[host] === true
		if (MCP_FUNNEL_PATHS.some((path) => handlers[path])) route = { host, allowed, handlers }
	}
	if (!route) return { state: "missing", checkedAt, target }
	const wrongPath = MCP_FUNNEL_PATHS.find((path) => route.handlers[path] && route.handlers[path].Proxy !== targetFor(port, path))
	if (wrongPath) {
		const actualTarget = route.handlers[wrongPath].Proxy
		return {
			state: "wrong_target",
			checkedAt,
			target,
			actualTarget,
			routePath: wrongPath,
			legacyTarget: wrongPath === FUNNEL_PATH && actualTarget === legacyTargetFor(port),
		}
	}
	const missingPaths = MCP_FUNNEL_PATHS.filter((path) => !route.handlers[path])
	if (missingPaths.length) return { state: "missing", checkedAt, target, missingPaths }
	if (!route.allowed) return { state: "disabled", checkedAt, target }
	return { state: "ready", checkedAt, target, publicUrl: `https://${route.host}${FUNNEL_PATH}` }
}

export function createTailscaleManager({ path, run, now = Date.now, timeoutMs = 10_000 }) {
	if (typeof run !== "function") throw new Error("Tailscale command runner is required")
	const execute = (args) => run(path, args, { timeoutMs })
	const turnOff = async (path) => {
		const result = await execute(["funnel", `--set-path=${path}`, "off"])
		if (commandFailed(result)) throw commandError(`关闭 Funnel ${path} 失败`, result)
	}

	return {
		async status(port) {
			return inspectFunnelStatus(await execute(["funnel", "status", "--json"]), port, now)
		},
		async ensureMcpFunnel(port) {
			const status = await this.status(port)
			if (["timeout", "not_logged_in", "unavailable"].includes(status.state)) {
				throw new Error(`无法检查 Tailscale Funnel：${status.state}`)
			}
			if (status.state === "wrong_target" && !status.legacyTarget) {
				throw new Error(`Funnel ${FUNNEL_PATH} 已指向其他目标：${status.actualTarget}`)
			}
			if (status.state === "ready") return { changed: false, status }
			for (const path of MCP_FUNNEL_PATHS) {
				const result = await execute(["funnel", "--bg", `--set-path=${path}`, targetFor(port, path)])
				if (commandFailed(result)) throw commandError(`配置 Tailscale Funnel ${path} 失败`, result)
			}
			const confirmed = await this.status(port)
			return { changed: true, status: confirmed.state === "ready" ? confirmed : { ...status, state: "configured" } }
		},
		async disableMcpFunnel() {
			for (const path of [...MCP_FUNNEL_PATHS].reverse()) await turnOff(path)
		},
	}
}
