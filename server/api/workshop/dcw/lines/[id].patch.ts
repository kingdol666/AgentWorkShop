/**
 * PATCH /api/workshop/dcw/lines/:id —— 编辑产线(名称/光晕色/描述/控制模式总闸)。
 * controlMode:manual→auto 摘人工审批闸门,须显式 confirm:true(服务端强制;MODE_CONFIRM_REQUIRED)。
 */
import { getRouterParam, readBody } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import type { LineInput } from '#shared/dcw-protocol'

export default defineApiHandler(async (event) => {
  // 权限模型 v3:产线元数据编辑仅 admin(operate 用户可启停/写控,但不能改线)
  requireRole(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Partial<LineInput>>(event) ?? {}
  return { line: getDcwController().updateLine(id, body) }
})
