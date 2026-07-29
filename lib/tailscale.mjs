export const FUNNEL_PATH = "/mcp"

function targetFor(port) {
	return `http://127.0.0.1:${port}${FUNNEL_PATH}`
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
		if (handlers[FUNNEL_PATH]) route = { host, allowed, target: handlers[FUNNEL_PATH].Proxy }
	}
	if (!route) return { state: "missing", checkedAt, target }
	if (route.target !== target) {
		return {
			state: "wrong_target",
			checkedAt,
			target,
			actualTarget: route.target,
			legacyTarget: route.target === legacyTargetFor(port),
		}
	}
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
			const result = await execute(["funnel", "--bg", `--set-path=${FUNNEL_PATH}`, status.target])
			if (commandFailed(result)) throw commandError("配置 Tailscale Funnel 失败", result)
			const confirmed = await this.status(port)
			return { changed: true, status: confirmed.state === "ready" ? confirmed : { ...status, state: "configured" } }
		},
		async disableMcpFunnel() {
			await turnOff(FUNNEL_PATH)
		},
	}
}
