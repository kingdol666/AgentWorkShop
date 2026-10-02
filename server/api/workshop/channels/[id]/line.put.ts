/**
 * PUT /api/workshop/channels/:id/line —— 绑定/解绑产线(v18)。
 * body: { "lineId": "<产线id>" | null }  (null/缺省 = 解绑)
 *
 * 只读扩权语义:绑定后频道成员无需节点绑定即可读取该产线的运维日志(ops_log)、
 * 配方变更史(recipe_log/recipe_versions)与实时全景(line_context:运行状态/活动
 * 批次/当前配方);参数下发等写操作仍必须走节点授权,不受绑定影响。
 * 权限:channel owner / admin(与 PATCH channel 同一守卫)。
 * 绑定变更回收成员运行时,下次装配注入产线简报(与场景 prompt 变更同链路)。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '../../caller'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { requireLineMode } from '../../../../services/workshop/permissions'
import { getDcwLineRepo } from '../../../../services/workshop/dcw/dcw-line.repo'
import { AppError, ErrorCodes } from '../../../../utils/errors'

const bindLineSchema = z.object({
  lineId: z.string().trim().nullable().optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(bindLineSchema))
  const manager = getWorkshopManager()
  manager.requireChannelOwner(channelId, user, 'channel')
  // 权限模型 v3:绑线者须对该产线有 grant(readonly 即可绑,成员仅只读上下文;
  // operate 才可经此 channel 管理产线);admin 天然放行;产线必须存在
  if (body.lineId) {
    if (!getDcwLineRepo().byId(body.lineId)) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${body.lineId}`)
    }
    requireLineMode(user, body.lineId, 'readonly')
  }
  const channel = await manager.bindChannelLine(channelId, body.lineId ?? '')
  return { ok: true, lineId: channel.lineId, channel }
})
