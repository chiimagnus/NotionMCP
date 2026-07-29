export const HEALTH_PATH = "/healthz"

export function createHealthSnapshot({ version, maxActiveRequests, activeRequestCount, isShuttingDown }) {
	const startedAt = Date.now()
	return () => {
		const acceptingRequests = !isShuttingDown()
		return {
			status: acceptingRequests ? "ready" : "draining",
			version,
			uptimeMs: Date.now() - startedAt,
			activeRequests: activeRequestCount(),
			maxActiveRequests,
			checks: {
				listener: "ready",
				acceptingRequests: acceptingRequests ? "ready" : "draining",
			},
		}
	}
}
