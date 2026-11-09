/**
 * POST /api/workshop/dcw/:id/write —— 设定值下发(核心写命令;body: { value: number })。
 * 工程量安全校验 → 驱动换算/写/回读校验 → ACK。越界 400;在飞 409。
 * R1 留痕由 write() 中央埋点统一完成(manual 来源携带真实用户身份)。
 */
import { getRouterParam, readValidatedBody, getRequestHeader } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { benchModeEnabled } from '@/server/services/workshop/bench-mode'

// 物理设备写面:value 必须是有限数值。**不用 coerce** —— Number(null)/Number("")/
// Number(false)/Number([]) 全部等于 0,会把"漏传/误传"变成一次真实的 0 设定下发
// (四层限界只挡越界,不挡 0)。UI/MCP/bench 均已按 number 发送(2026-11-10 复核)。
const schema = z.object({
  value: z.number({ invalid_type_error: 'value 必须是数值(工程量纲)' })
    .finite('value 必须是有限数值'),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const { value } = await readValidatedBody(event, zValidator(schema))
  // 产线权限:写控设定值需「可操控」(readonly/无权用户 403)
  requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')
  // D8 基准消融臂透传(仅 AW_BENCH_MODE=1 时生效;生产模式恒 undefined=full 臂)

  const benchArm = benchModeEnabled()

    ? (getRequestHeader(event, 'x-aw-bench-arm') || undefined) as 'no-interlock' | 'no-readback' | 'ungated' | undefined

    : undefined

  const outcome = await getDcwController().write(id, value, null, { source: 'manual', actor: user.id, actorName: user.name, benchArm })
  return { outcome }
})
