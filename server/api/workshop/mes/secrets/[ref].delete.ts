/**
 * DELETE /api/workshop/mes/secrets/:ref —— 删除 MES 运行时凭据(仅 admin)。
 * 删除后该 ref 的请求按「无凭据」处理(头省略);env 覆盖仍最高优先。
 */
import { getRouterParam } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { getMesSecretsRepo } from '@/server/services/workshop/mes/mes-secrets.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const ref = String(getRouterParam(event, 'ref') ?? '').trim()
  if (!ref) throw new AppError(400, 'BAD_REQUEST', '缺少凭据引用名 ref')
  const removed = getMesSecretsRepo().deleteSecret(ref)
  if (!removed) throw new AppError(404, ErrorCodes.NOT_FOUND, `凭据引用不存在: ${ref}`)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'mes.secret.delete',
    kind: 'system',
    level: 'warn',
    targetKind: 'mes-secret',
    targetId: ref,
    summary: `删除 MES 运行时凭据 ${ref}`,
    detail: { ref },
  })
  return { ref, deleted: true }
})
