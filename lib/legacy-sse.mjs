import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"

import { createLegacySseServer } from "./mcp-protocol.mjs"

export const LEGACY_SSE_PATH = "/mcp/sse"
export const LEGACY_MESSAGES_PATH = "/mcp/messages"

// ponytail: 旧 transport 只保留 Notion 实际请求的两条路径；客户端完全迁移后删除整个模块。
export function createLegacySseManager({ onerror }) {
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

	return {
		async open(res, onclose) {
			const controller = new AbortController()
			const transport = new SSEServerTransport(LEGACY_MESSAGES_PATH, res)
			const session = {
				closed: false,
				id: transport.sessionId,
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
			} catch (error) {
				await closeSession(session, onclose)
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
			await Promise.allSettled(closing.map((session) => closeSession(session, session.onclose)))
		},
		get size() {
			return sessions.size
		},
	}
}
