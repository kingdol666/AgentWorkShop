/**
 * POST /api/workshop/memory/curations/:id/regenerate —— 显式重新汇整（批次 E）。
 * 人工编辑过的文档默认阻止自动覆盖；本端点等价 force=true，但会先做权限校验。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { runCuratorForChannel } from '@/server/services/workshop/memory/curator'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  const { channelId } = assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const result = await runCuratorForChannel(getAmlRuntime().db, channelId, {
    force: true,
    useLlm: body.useLlm === true || (body.useLlm !== false && Boolean(process.env.AW_MEMORY_CURATOR_LLM_URL?.trim())),
  })
  try {
    recordOps({
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action: 'memory.curation.regenerate',
      kind: 'system',
      targetKind: 'memory',
      targetId: id,
      summary: `显式重新汇整知识手册：${result.status}（${result.sourceCount} 来源，${result.mode}）`,
      lineId: channelId,
    })
  }
  catch { /* 审计失败不影响汇整 */ }
  return result
})
