export const HEALTH_PATH = "/healthz"

export function createHealthSnapshot({
	version,
	maxActiveRequests,
	activeRequestCount,
	queuedRequestCount = () => 0,
	maxQueuedRequests = 0,
	connectionCount = () => 0,
	legacySseCount = () => 0,
	maxSseStreams = 0,
	sseHighWater = () => 0,
	isShuttingDown,
}) {
	const startedAt = Date.now()
	return () => {
		const acceptingRequests = !isShuttingDown()
		return {
			status: acceptingRequests ? "ready" : "draining",
			version,
			uptimeMs: Date.now() - startedAt,
			activeRequests: activeRequestCount(),
			maxActiveRequests,
			queuedRequests: queuedRequestCount(),
			maxQueuedRequests,
			connections: {
				open: connectionCount(),
				legacySse: legacySseCount(),
				totalSse: legacySseCount(),
			},
			maxSseStreams,
			sseHighWater: sseHighWater(),
			checks: {
				listener: "ready",
				acceptingRequests: acceptingRequests ? "ready" : "draining",
			},
		}
	}
}
