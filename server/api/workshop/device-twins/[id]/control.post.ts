/**
 * POST /api/workshop/device-twins/:id/control —— 下发设备指令(模拟域)。
 * - Bearer 用户 token;body: { command, args? }
 * - 等价于 MCP device.control 的用户面入口
 * - 返回 { twin }
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo } from '@/server/services/workshop/assets/device-twin.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ command?: string, args?: Record<string, unknown> }>(event)
  if (!body?.command) throw new AppError(400, 'BAD_REQUEST', 'command 必填')
  const twin = getDeviceTwinRepo().applyControl(id, body.command, body.args ?? {})
  if (!twin) throw new AppError(404, 'NOT_FOUND', `设备不存在: ${id}`)
  return { twin }
})
