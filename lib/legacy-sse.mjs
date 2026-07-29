import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"

import { createLegacySseServer } from "./mcp-protocol.mjs"

export const LEGACY_SSE_PATH = "/mcp/sse"
export const LEGACY_MESSAGES_PATH = "/mcp/messages"

// ponytail: 旧 transport 只保留 Notion 实际请求的两条路径；客户端完全迁移后删除整个模块。
export function createLegacySseManager({ maxSessions, onerror }) {
	const sessions = new Map()

	const closeSession = async (session, onclose) => {
		if (session.closed) return
		session.closed = true
		sessions.delete(session.id)
		session.controller.abort(new Error("SSE session closed"))
		try {
			await session.server.close()
		} catch (error) {
			onerror(error)
		}
		onclose?.()
	}

	const oldestIdleSession = () => {
		let oldest
		for (const session of sessions.values()) {
			if (session.busy || (oldest && oldest.lastUsedAt <= session.lastUsedAt)) continue
			oldest = session
		}
		return oldest
	}

	return {
		async open(res, onclose) {
			let replaced = false
			if (sessions.size >= maxSessions) {
				const idle = oldestIdleSession()
				if (!idle) return false
				// ponytail: Notion abandons 2024 SSE streams; replace only idle streams so a retry never hits a stale cap.
				await closeSession(idle, idle.onclose)
				replaced = true
			}
			const controller = new AbortController()
			const transport = new SSEServerTransport(LEGACY_MESSAGES_PATH, res)
			const session = {
				busy: 0,
				closed: false,
				id: transport.sessionId,
				lastUsedAt: Date.now(),
				onclose,
				controller,
				server: createLegacySseServer(controller.signal),
				transport,
			}
			transport.onclose = () => void closeSession(session, onclose)
			transport.onerror = (error) => onerror(error)
			sessions.set(session.id, session)
			try {
				await session.server.connect(transport)
				return { replaced }
			} catch (error) {
				await closeSession(session, onclose)
				throw error
			}
		},
		async handleMessage(req, res, sessionId, parsedBody) {
			const session = sessions.get(sessionId)
			if (!session) return false
			session.busy += 1
			session.lastUsedAt = Date.now()
			try {
				await session.transport.handlePostMessage(req, res, parsedBody)
				return true
			} finally {
				session.busy -= 1
				session.lastUsedAt = Date.now()
			}
		},
		hasSession(sessionId) {
			return sessions.has(sessionId)
		},
		async close() {
			const closing = [...sessions.values()]
			await Promise.allSettled(closing.map((session) => closeSession(session, session.onclose)))
		},
		get size() {
			return sessions.size
		},
	}
}
