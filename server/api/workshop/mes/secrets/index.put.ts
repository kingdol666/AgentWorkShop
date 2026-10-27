/**
 * PUT /api/workshop/mes/secrets —— 写入/轮换 MES 运行时凭据(仅 admin)。
 * body: { ref: string, value: string };value 永不回显、不入日志/审计 detail。
 */
import { readBody } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getMesSecretsRepo } from '@/server/services/workshop/mes/mes-secrets.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const body = await readBody(event).catch(() => null) as { ref?: unknown, value?: unknown } | null
  const ref = String(body?.ref ?? '').trim()
  const value = String(body?.value ?? '')
  if (!ref) throw new AppError(400, 'BAD_REQUEST', '缺少凭据引用名 ref')
  if (value.trim() === '') throw new AppError(400, 'BAD_REQUEST', '凭据值不能为空')
  let entry: { updatedAt: string, updatedBy: string }
  try {
    entry = getMesSecretsRepo().setSecret(ref, value, user.id)
  }
  catch (err) {
    throw new AppError(400, 'BAD_REQUEST', err instanceof Error ? err.message : String(err))
  }
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'mes.secret.set',
    kind: 'system',
    level: 'info',
    targetKind: 'mes-secret',
    targetId: ref,
    summary: `写入 MES 运行时凭据 ${ref}`,
    detail: { ref, updatedAt: entry.updatedAt },
  })
  return { ref, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy }
})
