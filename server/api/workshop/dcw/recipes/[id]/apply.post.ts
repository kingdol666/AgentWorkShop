/**
 * POST /api/workshop/dcw/recipes/:id/apply —— 一键下发配方(创建批次 + 逐参数写)。
 * R3:admin/editor 才可执行;approvalGate 开启时走双人复核(首次 202 返回待审 id,
 * 另一 admin 批准后申请人携 approvalId 重放放行)。
 */
import { getRouterParam, readBody, setResponseStatus } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { gateDangerous } from '@/server/utils/approval-gate'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ approvalId?: string }>(event) ?? {}
  const gate = gateDangerous(useRuntimeConfig(event).approvalGate === true, user, { action: 'recipe.apply', targetId: id, summary: `一键下发配方 ${id}` }, body.approvalId)
  if (gate.pending) {
    setResponseStatus(event, 202)
    return { pending: true, requestId: gate.requestId }
  }
  const run = await getDcwController().applyRecipe(id)
  // R1:配方一键下发 = 批量写命令,留痕
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: 'recipe.apply', targetKind: 'recipe', targetId: id, detail: { runId: (run as { id?: string }).id } })
  return { run }
})
