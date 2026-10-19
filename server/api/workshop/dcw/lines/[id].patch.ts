/**
 * PATCH /api/workshop/dcw/lines/:id —— 编辑产线(名称/光晕色/描述/控制模式总闸)。
 * controlMode:manual→auto 摘人工审批闸门,须显式 confirm:true(服务端强制;MODE_CONFIRM_REQUIRED)。
 */
import { getRouterParam, readBody } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { recordOps } from '@/server/services/workshop/ops/ops'
import type { LineInput } from '#shared/dcw-protocol'

export default defineApiHandler(async (event) => {
  // 权限模型 v3:产线元数据编辑仅 admin(operate 用户可启停/写控,但不能改线)
  const user = requireRole(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Partial<LineInput>>(event) ?? {}
  const line = getDcwController().updateLine(id, body)
  // 改线名/描述/控制模式总闸都是产线域变更(controlMode 直接改变人工审批闸门)
  const changed = Object.keys(body)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'line.update', kind: 'line', targetKind: 'line', targetId: id,
    lineId: id,
    summary: `编辑产线「${line.name}」(${changed.join('/') || '无变更'})`,
    detail: { keys: changed },
  })
  return { line }
})
