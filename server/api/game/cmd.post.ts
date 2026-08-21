/**
 * POST /api/game/cmd — Agent/MCP 下行指令注入端点(execDownlink 的 HTTP 暴露)
 *
 * 开发/测试专用:让外部脚本(本机 puppeteer 验证 / 后续真实 Agent harness)经 HTTP
 * 触发 session.execDownlink(name, payload),走与 brain 决议同一的 emit 路径 → WS 下行 → 前端渲染。
 *
 * 即真实 Agent 的 sendmsg 入口雏形:后续 MCP 接入时,MCP tool handler 即调用同一 execDownlink。
 *
 * 请求体: { type: string, payload: object }
 * 响应(成功): { code:0, data:{ applied:true, type, payload } }
 * 响应(失败): { code:'<ParseErrorCode>', message } 由 AppError 映射 HTTP 状态:
 *   - 400 BAD_MESSAGE / UNKNOWN_COMMAND / INVALID_PAYLOAD
 *   - 403 FORBIDDEN(非 agentCallable 指令)
 */
import { readBody } from 'h3'
import { defineApiHandler } from '../../utils/response'
import { AppError } from '../../utils/errors'
import { gameSession } from '../../services/game/session'
import { resolveUser } from '../workshop/caller'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{ type?: string, payload?: unknown }>(event)
  if (!body || typeof body.type !== 'string') {
    throw new AppError(400, 'BAD_MESSAGE', '需要 { type, payload }')
  }
  const res = gameSession.execDownlink(body.type, body.payload ?? {})
  if (!res.ok) {
    const status = res.error.code === 'FORBIDDEN' ? 403 : 400
    throw new AppError(status, res.error.code, res.error.message)
  }
  return { applied: true, type: res.value.type, payload: res.value.payload }
})
