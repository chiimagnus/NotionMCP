import { spawn, spawnSync } from "node:child_process"

const activeChildren = new Set()
const cleanupPromises = new WeakMap()
const TERM_GRACE_MS = 500
const TASKKILL_TIMEOUT_MS = 3_000

function signalUnixTree(child, signal) {
	try {
		process.kill(-child.pid, signal)
		return
	} catch {}
	try {
		child.kill(signal)
	} catch {}
}

function unixTreeAlive(child) {
	try {
		process.kill(-child.pid, 0)
		return true
	} catch {}
	try {
		process.kill(child.pid, 0)
		return true
	} catch {
		return false
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForUnixTreeExit(child, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (unixTreeAlive(child) && Date.now() < deadline) {
		await delay(Math.min(25, deadline - Date.now()))
	}
	return !unixTreeAlive(child)
}

function taskkill(child) {
	return new Promise((resolve) => {
		let killer
		try {
			killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			})
		} catch {
			resolve()
			return
		}
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			killer.off("error", finish)
			killer.off("close", finish)
			resolve()
		}
		const timer = setTimeout(() => {
			try {
				killer.kill()
			} catch {}
			finish()
		}, TASKKILL_TIMEOUT_MS)
		killer.once("error", finish)
		killer.once("close", finish)
	})
}

async function terminate(child) {
	if (!child?.pid) return
	if (process.platform === "win32") {
		await taskkill(child)
		return
	}
	signalUnixTree(child, "SIGTERM")
	if (await waitForUnixTreeExit(child, TERM_GRACE_MS)) return
	signalUnixTree(child, "SIGKILL")
	await waitForUnixTreeExit(child, TERM_GRACE_MS)
}

// ponytail: registry 只保存本进程亲自创建的 child；需要资源配额或 Windows Job Object 时再升级。
export function registerChild(child) {
	if (child?.pid) activeChildren.add(child)
	return child
}

export function unregisterChild(child) {
	activeChildren.delete(child)
}

export function terminateProcessTree(child) {
	if (!child?.pid) return Promise.resolve()
	let cleanup = cleanupPromises.get(child)
	if (!cleanup) {
		cleanup = terminate(child)
		cleanupPromises.set(child, cleanup)
	}
	return cleanup
}

function terminateSync(child) {
	if (!child?.pid) return
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				timeout: TASKKILL_TIMEOUT_MS,
				windowsHide: true,
			})
		} catch {}
		return
	}
	signalUnixTree(child, "SIGKILL")
}

process.once("exit", () => {
	for (const child of activeChildren) terminateSync(child)
})
