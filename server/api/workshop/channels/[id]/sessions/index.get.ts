/**
 * GET /api/workshop/channels/:id/sessions —— 会话清单（含成员映射与状态）。
 * 只读面：可见性同 messages/queue（getChannelForUser），不要求可写。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

/** memberMapJson → { baseId: cloneId }（容错：坏 JSON 视为空映射） */
function parseMemberMap(raw: string | undefined): Record<string, string> {
  try {
    return JSON.parse(raw ?? '{}')
  }
  catch {
    return {}
  }
}

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id)
  const sessions = manager.listChannelSessions(channelId)
  return sessions.map((s) => {
    const brief = manager.getSessionBrief(s.id)
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      memberMap: parseMemberMap(s.memberMapJson),
      createdAt: s.createdAt,
      closedAt: s.closedAt,
      // 项目任务实例（2026-11-07）：任务溯源，前端会话卡展示「任务」徽标
      projectId: s.projectId,
      projectWorkItemId: s.projectWorkItemId,
      createdByKind: s.createdByKind,
      instanceKind: s.instanceKind,
      summary: s.summary,
      lastActiveAt: s.lastActiveAt,
      kind: brief?.kind ?? (s.instanceKind === 'task' ? 'task' : s.instanceKind === 'project' ? 'project' : 'manual'),
      brief: brief
        ? {
            currentTask: brief.currentTask,
            nextStep: brief.nextStep,
            openQuestions: brief.openQuestions,
            deliverables: brief.deliverables,
          }
        : null,
    }
  })
})
