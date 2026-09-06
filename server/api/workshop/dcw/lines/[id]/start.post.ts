/**
 * POST /api/workshop/dcw/lines/:id/start —— 该产线开跑(body: { recipeId })。
 * 门控:配方必归属本产线的产品且含工艺参数;激活窗口后本产线数采逐样本打标。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { getActiveLineRun } from '@/server/services/workshop/dcw/line-run'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { emitLineLifecycle } from '@/server/services/workshop/plugins/host.mjs'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id')!
  // 产线权限:开跑会向真实 PLC 下发全部配方参数,需「可操控」
  requireLineMode(user, id, 'operate')
  const body = await readBody<{ recipeId?: string }>(event) ?? {}
  const run = await getDcwController().lineStart(id, String(body.recipeId ?? ''))
  const active = getActiveLineRun(id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'line.start',
    kind: 'line',
    targetKind: 'line',
    targetId: id,
    summary: `产线开跑:批次 ${run.id} · 配方「${active?.recipeName ?? body.recipeId ?? ''}」已下发`,
    lineId: id,
    productId: active?.productId ?? '',
    recipeId: active?.recipeId ?? String(body.recipeId ?? ''),
    detail: { runId: run.id, recipeId: body.recipeId ?? '' },
  })
  emitLineLifecycle('line:start', { lineId: id, runId: run.id, recipeId: active?.recipeId ?? String(body.recipeId ?? ''), productName: active?.productName ?? '' })
  return { run, line: getDcwController().lineState(id) }
})
