/**
 * POST /api/workshop/aml/env/venv —— 创建/重建训练环境 ./aml/.venv。
 * body: { force?: boolean } —— force=true 时先删旧环境再重建(依赖升级/环境损坏时用)。
 * 异步:立即返回任务快照(kind=create-venv),进度经 GET /aml/env 轮询。
 * 权限:admin/editor。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { startCreateVenv } from '@/server/services/workshop/aml/env-manager'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<{ force?: boolean }>(event) ?? {}
  const task = startCreateVenv({ force: body.force === true })
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: body.force ? 'aml.env.rebuild_venv' : 'aml.env.create_venv', kind: 'system',
    summary: `${body.force ? '重建' : '创建'}训练环境 ./aml/.venv(任务 ${task.id})`,
    targetKind: 'aml_env', targetId: task.id,
  })
  return { task }
})
