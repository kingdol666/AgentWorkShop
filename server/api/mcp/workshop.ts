/**
 * MCP Streamable HTTP 端点 — /api/mcp/workshop
 *
 * 平台对 Agent harness 的自主作业面(设计文档 §6.1):Agent(MCP client)经本端点
 * 调用 16 个 workshop 工具(channel/agent/task/a2a 管理),与 REST API 双驱动同一 Manager。
 *
 * 实现: WebStandardStreamableHTTPServerTransport(stateful 模式,会话复用):
 *  - POST initialize(无 sessionId)→ 创建 transport + McpServer,响应头带回 Mcp-Session-Id
 *  - 后续 POST(带 sessionId)→ 复用 transport(会话内状态保留)
 *  - GET(带 sessionId)→ SSE 流(server → client 消息)
 *  - DELETE(带 sessionId)→ 关闭会话并从注册表移除
 * 传输层认证: 工具级 Bearer token(workshop-server 的 requireCaller 解析)。
 *
 * 兼容性: 手动构造 web Request + 直接返回 web Response——同时兼容 Nitro 内置 h3 1.x
 * 与项目根 h3 2.x(两者 Request/Response 转换助手名不一致,web 标准对象两版均可返回)。
 */
import { randomUUID } from 'node:crypto'
import { defineEventHandler, getRequestURL, getRequestHeaders, readRawBody } from 'h3'
import type { H3Event } from 'h3'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createWorkshopMcpServer } from '../../mcp/workshop-server'
import { getWorkshopManager } from '../../plugins/workshop'

/** 会话注册表:sessionId → transport(stateful 会话状态保留) */
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()

/** h3 event → web Request(跨 h3 1.x/2.x 兼容:不用版本互异的转换助手) */
async function toFetchRequest(event: H3Event): Promise<Request> {
  const hasBody = event.method !== 'GET' && event.method !== 'DELETE'
  const body = hasBody ? await readRawBody(event) : undefined
  return new Request(getRequestURL(event), {
    method: event.method,
    headers: new Headers(getRequestHeaders(event) as Record<string, string>),
    body,
  })
}

function sessionIdOf(event: H3Event): string | null {
  const url = new URL(event.path, 'http://localhost')
  const sid = url.searchParams.get('sessionId') ?? getRequestHeaders(event)['mcp-session-id']
  return typeof sid === 'string' && sid.length > 0 ? sid : null
}

export default defineEventHandler(async (event) => {
  const request = await toFetchRequest(event)
  const sessionId = sessionIdOf(event)

  // DELETE:关闭会话
  if (event.method === 'DELETE' && sessionId) {
    const transport = sessions.get(sessionId)
    if (transport) {
      try {
        await transport.handleRequest(request)
      }
      finally {
        sessions.delete(sessionId)
      }
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  }

  // 复用已有会话
  let transport = sessionId ? sessions.get(sessionId) : undefined

  // 新会话:预生成 sessionId,transport 在 initialize 时把它写入响应头
  if (!transport) {
    const newSessionId = randomUUID()
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    })
    const server = createWorkshopMcpServer(getWorkshopManager())
    await server.connect(transport)
    sessions.set(newSessionId, transport)
  }

  return transport.handleRequest(request)
})
