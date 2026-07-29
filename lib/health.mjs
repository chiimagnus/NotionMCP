export const HEALTH_PATH = "/healthz"

export function createHealthSnapshot({ version, maxActiveRequests, activeRequestCount, connectionCount = () => 0, legacySseCount = () => 0, isShuttingDown }) {
	const startedAt = Date.now()
	return () => {
		const acceptingRequests = !isShuttingDown()
		return {
			status: acceptingRequests ? "ready" : "draining",
			version,
			uptimeMs: Date.now() - startedAt,
			activeRequests: activeRequestCount(),
			maxActiveRequests,
			connections: {
				open: connectionCount(),
				legacySse: legacySseCount(),
			},
			checks: {
				listener: "ready",
				acceptingRequests: acceptingRequests ? "ready" : "draining",
			},
		}
	}
}
