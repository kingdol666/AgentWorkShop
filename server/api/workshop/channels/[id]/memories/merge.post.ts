/**
 * POST /api/workshop/channels/:id/memories/merge —— 合并同结论的多条经验（证据并集）。
 *
 * body: { memoryIds: string[] }
 * 权限：channel owner/admin（人在策展；Agent 工具面不可达）。
 *
 * 背景（2026-11-10 审计）：反射器一任务一条经验，晋升门要求 ≥2 独立任务样本——
 * 没有合并端点时自动产物永远停在 candidate，现场只能裸 SQL 合并（并因此绕过
 * upsert 的状态单调性）。合并本身不晋级，晋升仍走 promote（门判定 + 人审批）。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { mergeExperiences } from '../../../../../services/workshop/experience/promote'

const schema = z.object({
  memoryIds: z.array(z.string().trim().min(1)).min(2, '至少选择 2 条经验'),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const body = await readValidatedBody(event, zValidator(schema))
  return mergeExperiences(getAmlRuntime().db, {
    channelId,
    memoryIds: body.memoryIds,
    actor: user.id,
    actorName: user.name,
  })
})
