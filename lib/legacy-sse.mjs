import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"

import { createLegacySseServer } from "./mcp-protocol.mjs"

export const LEGACY_SSE_PATH = "/mcp/sse"
export const LEGACY_MESSAGES_PATH = "/mcp/messages"

// ponytail: 旧 transport 只保留 Notion 实际请求的两条路径；客户端完全迁移后删除整个模块。
export function createLegacySseManager({ maxSessions, onerror }) {
	const sessions = new Map()

	const remove = (session, onclose) => {
		if (!sessions.delete(session.id)) return
		session.controller.abort(new Error("SSE session closed"))
		onclose?.()
	}

	return {
		async open(res, onclose) {
			if (sessions.size >= maxSessions) return false
			const controller = new AbortController()
			const transport = new SSEServerTransport(LEGACY_MESSAGES_PATH, res)
			const session = {
				id: transport.sessionId,
				controller,
				server: createLegacySseServer(controller.signal),
				transport,
			}
			transport.onclose = () => remove(session, onclose)
			transport.onerror = (error) => onerror(error)
			sessions.set(session.id, session)
			try {
				await session.server.connect(transport)
				return true
			} catch (error) {
				remove(session, onclose)
				try {
					await session.server.close()
				} catch (closeError) {
					onerror(closeError)
				}
				throw error
			}
		},
		async handleMessage(req, res, sessionId, parsedBody) {
			const session = sessions.get(sessionId)
			if (!session) return false
			await session.transport.handlePostMessage(req, res, parsedBody)
			return true
		},
		hasSession(sessionId) {
			return sessions.has(sessionId)
		},
		async close() {
			const closing = [...sessions.values()]
			sessions.clear()
			for (const session of closing) session.controller.abort(new Error("Server shutting down"))
			await Promise.allSettled(closing.map((session) => session.server.close()))
		},
		get size() {
			return sessions.size
		},
	}
}
