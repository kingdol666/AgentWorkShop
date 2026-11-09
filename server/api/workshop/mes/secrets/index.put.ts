/**
 * PUT /api/workshop/mes/secrets —— 写入/轮换 MES 运行时凭据(仅 admin)。
 * body: { ref: string, value: string };value 永不回显、不入日志/审计 detail。
 */
import { readValidatedBody } from 'h3'
import { z } from 'zod'
import { requireRole } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getMesSecretsRepo } from '@/server/services/workshop/mes/mes-secrets.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'

// 凭据面:ref/value 均为非空字符串,不做隐式类型转换(数字/数组/对象一律 400)。
// 上限:ref 200 字符(引用名),value 64KB(密文;超限通常意味着误传大对象)。
const schema = z.object({
  ref: z.string().trim().min(1, '缺少凭据引用名 ref').max(200, 'ref 超过 200 字符上限'),
  value: z.string().min(1, '凭据值不能为空').max(65_536, 'value 超过 64KB 上限'),
}).refine(v => v.value.trim() !== '', { message: '凭据值不能为空', path: ['value'] })

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const { ref, value } = await readValidatedBody(event, zValidator(schema))
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
