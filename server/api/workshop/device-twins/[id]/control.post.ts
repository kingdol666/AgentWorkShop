/**
 * POST /api/workshop/device-twins/:id/control —— 下发设备指令(模拟域)。
 * - Bearer 用户 token;body: { command, args? }
 * - 等价于 MCP device.control 的用户面入口
 * - 返回 { twin }
 */
import { getRouterParam, readValidatedBody } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo } from '@/server/services/workshop/assets/device-twin.repo'
import { assertAssetManager } from '@/server/utils/asset-auth'

// 设备指令面:command 必填非空字符串(指令名),args 必须是对象(拒绝数组/标量 —— 过去会被
// 当作对象透传进 applyControl)。未知 command 的语义仍由 repo 判定(此处只守形状)。
const schema = z.object({
  command: z.string().trim().min(1, 'command 必填').max(128, 'command 超过 128 字符上限'),
  args: z.record(z.string(), z.unknown()).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  assertAssetManager(user, '设备孪生操控')
  const id = getRouterParam(event, 'id')!
  const { command, args } = await readValidatedBody(event, zValidator(schema))
  const twin = getDeviceTwinRepo().applyControl(id, command, args ?? {})
  if (!twin) throw new AppError(404, 'NOT_FOUND', `设备不存在: ${id}`)
  return { twin }
})
