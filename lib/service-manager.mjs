import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"

const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024

function collect(stream) {
	const chunks = []
	let bytes = 0
	stream?.on("data", (chunk) => {
		const buffer = Buffer.from(chunk)
		const kept = buffer.subarray(0, Math.max(0, MAX_COMMAND_OUTPUT_BYTES - bytes))
		if (kept.length) chunks.push(kept)
		bytes += kept.length
	})
	return () => Buffer.concat(chunks, bytes).toString("utf8")
}

export function runCommand(command, args, { timeoutMs = 10_000, spawnImpl = spawn } = {}) {
	return new Promise((resolve) => {
		let child
		try {
			child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
		} catch (error) {
			resolve({ status: null, stdout: "", stderr: "", error, timedOut: false })
			return
		}
		const stdout = collect(child.stdout)
		const stderr = collect(child.stderr)
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill()
		}, timeoutMs)
		child.once("error", (error) => {
			clearTimeout(timer)
			resolve({ status: null, stdout: stdout(), stderr: stderr(), error, timedOut })
		})
		child.once("close", (status) => {
			clearTimeout(timer)
			resolve({ status, stdout: stdout(), stderr: stderr(), timedOut })
		})
	})
}

export async function startService({ sandboxDir, port, token, createServer, ensureFunnel, mkdirImpl = mkdir }) {
	await mkdirImpl(sandboxDir, { recursive: true })
	const lifecycle = createServer({ port, token })
	try {
		await lifecycle.listen()
		const funnel = await ensureFunnel(port)
		return { lifecycle, funnel }
	} catch (error) {
		await lifecycle.shutdown("startup_failed")
		throw error
	}
}

export async function stopService({ lifecycle, disableFunnel, reason }) {
	let failure
	if (disableFunnel) {
		try {
			await disableFunnel()
		} catch (error) {
			failure = error
		}
	}
	try {
		await lifecycle.shutdown(reason)
	} catch (error) {
		failure ||= error
	}
	if (failure) throw failure
}
