/**
 * GET /api/workshop/optimization/runs?bindingId=&limit= —— 运行台账(含候选/建议摘要)
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { getRunRepo } from '@/server/services/workshop/optimization/run.repo'
import { getBindingRepo } from '@/server/services/workshop/optimization/binding.repo'
import { assertAgentAccess } from '@/server/services/workshop/optimization/rest-auth'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const q = getQuery(event)
  const bindingId = typeof q.bindingId === 'string' ? q.bindingId : undefined
  if (bindingId) {
    const binding = getBindingRepo().get(bindingId)
    if (!binding) throw new AppError(404, 'BINDING_NOT_FOUND', `绑定 ${bindingId} 不存在`)
    assertAgentAccess(user, binding.channelAgentId)
  }
  else if (user.role !== 'admin') {
    throw new AppError(403, 'SCOPE_VIOLATION', '全局运行列表仅管理员可读;请按 bindingId 查询')
  }
  const limit = typeof q.limit === 'string' ? Math.max(1, Math.min(Number(q.limit) || 50, 200)) : 50
  const runs = getRunRepo().listRuns({ bindingId, limit }).map(run => ({
    ...run,
    problemIr: safeJson(run.problemIrJson),
    diagnostics: safeJson(run.diagnosticsJson),
    recommendation: getRunRepo().latestRecommendationForRun(run.id) ?? null,
  }))
  return { runs }
})

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text || '{}') as Record<string, unknown>
  }
  catch {
    return {}
  }
}
