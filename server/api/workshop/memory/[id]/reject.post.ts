/**
 * POST /api/workshop/memory/:id/reject —— 人工裁定「不成立」（批次 B / W5）。
 *
 * 原行退役 + 负向 candidate（经验行）+ 原因必填；正文/证据/审计保留，不硬删。
 * 权限与 /memory 写面同口径（owner/admin，命中频道范围）。
 */
import { readBody, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { MemoryAdminError, rejectMemory } from '@/server/services/workshop/memory/memory-admin'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  const { channelId } = assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', '裁定不成立必须填写原因')
  let result: ReturnType<typeof rejectMemory>
  try {
    result = rejectMemory(getAmlRuntime().db, {
      id,
      reason,
      actor: { kind: 'human', id: user.id },
    })
  }
  catch (err) {
    // MemoryAdminError 自带状态码与业务码（409 AGENT_MAINTAINED / 409 DELETED / 404 NOT_FOUND）：
    // 不翻译就一律塌成 500 INTERNAL_ERROR，前端拿不到"为什么不能裁定"。
    if (err instanceof MemoryAdminError) throw new AppError(err.statusCode, err.code, err.message)
    throw err
  }
  try {
    recordOps({
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action: 'memory.reject',
      kind: 'system',
      targetKind: 'memory',
      targetId: id,
      summary: `人工裁定不成立：${reason.slice(0, 120)}`,
      lineId: channelId,
    })
  }
  catch { /* 审计失败不影响裁定 */ }
  return result
})
