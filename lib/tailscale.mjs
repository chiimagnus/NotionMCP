export const FUNNEL_PATH = "/mcp"
export const MCP_FUNNEL_PATHS = [FUNNEL_PATH, "/mcp/sse", "/mcp/messages"]
const ROOT_PATH = "/"

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
	let rootOnlyRoute
	for (const [host, server] of Object.entries(status.Web || {})) {
		const handlers = server?.Handlers || {}
		const allowed = status.AllowFunnel?.[host] === true
		const candidate = { host, allowed, handlers }
		if (MCP_FUNNEL_PATHS.some((path) => handlers[path])) route = candidate
		else if (!rootOnlyRoute && handlers[ROOT_PATH]) rootOnlyRoute = candidate
	}
	route ||= rootOnlyRoute
	if (!route) return { state: "missing", checkedAt, target }
	const rootTarget = route.handlers[ROOT_PATH]?.Proxy
	const legacyRoot = rootTarget === legacyTargetFor(port)
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
			rootTarget,
			legacyRoot,
		}
	}
	if (legacyRoot) {
		return { state: "legacy_root", checkedAt, target, actualTarget: rootTarget, routePath: ROOT_PATH }
	}
	if (rootTarget) return { state: "wrong_root_target", checkedAt, target, actualTarget: rootTarget, routePath: ROOT_PATH }
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
	const assertConfigurable = (status) => {
		if (["timeout", "not_logged_in", "unavailable"].includes(status.state)) {
			throw new Error(`无法检查 Tailscale Funnel：${status.state}`)
		}
		if (status.rootTarget && !status.legacyRoot) {
			throw new Error(`Funnel 根路径已指向其他目标：${status.rootTarget}`)
		}
		if (status.state === "wrong_target" && !status.legacyTarget) {
			throw new Error(`Funnel ${FUNNEL_PATH} 已指向其他目标：${status.actualTarget}`)
		}
		if (status.state === "wrong_root_target") {
			throw new Error(`Funnel 根路径已指向其他目标：${status.actualTarget}`)
		}
	}

	return {
		async status(port) {
			return inspectFunnelStatus(await execute(["funnel", "status", "--json"]), port, now)
		},
		async ensureMcpFunnel(port) {
			let status = await this.status(port)
			let changed = false
			assertConfigurable(status)
			if (status.legacyRoot || status.state === "legacy_root") {
				await turnOff(ROOT_PATH)
				changed = true
				status = await this.status(port)
				assertConfigurable(status)
				if (status.state === "legacy_root") throw new Error("未能移除旧 Funnel 根路径")
			}
			if (status.state === "ready") return { changed, status }
			for (const path of MCP_FUNNEL_PATHS) {
				const result = await execute(["funnel", "--bg", `--set-path=${path}`, targetFor(port, path)])
				if (commandFailed(result)) throw commandError(`配置 Tailscale Funnel ${path} 失败`, result)
			}
			const confirmed = await this.status(port)
			assertConfigurable(confirmed)
			if (confirmed.state !== "ready") throw new Error(`Funnel 配置后仍未就绪：${confirmed.state}`)
			return { changed: true, status: confirmed }
		},
		async disableMcpFunnel() {
			for (const path of [...MCP_FUNNEL_PATHS].reverse()) await turnOff(path)
		},
	}
}
