/**
 * POST /api/workshop/memory/repair —— 记忆/图谱 FTS 重建与清理（admin）。
 * 只重建派生索引、清理过期/孤儿数据，不删除记忆正文。
 */
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { repairMemory } from '@/server/services/workshop/memory/export'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '仅管理员可执行修复')
  const counts = repairMemory(getAmlRuntime().db)
  try {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'memory.repair', kind: 'system', targetKind: 'system', targetId: 'memory',
      summary: `记忆修复：${JSON.stringify(counts)}`,
    })
  }
  catch { /* 审计失败不影响修复 */ }
  return { counts }
})
