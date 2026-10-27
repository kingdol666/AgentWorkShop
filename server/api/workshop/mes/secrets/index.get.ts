/**
 * GET /api/workshop/mes/secrets —— 列出 MES 运行时凭据引用(仅 admin)。
 * 只回引用名与更新时间,永不回 value(零明文面)。
 */
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getMesSecretsRepo } from '@/server/services/workshop/mes/mes-secrets.repo'

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin'])
  const refs = getMesSecretsRepo().listRefs()
  return { refs, count: refs.length }
})
