/**
 * POST /api/workshop/aml/entities/prune —— 清理孤儿实体目录(磁盘有、元数据无)。
 * body: { dryRun?: boolean } —— dryRun=true 只报告;缺省 false 执行删除。
 * 只删 <amlRoot>/{datasets,jobs,models}/<id> 形状的目录(带根内越界防护);
 * **不会**删除"元数据在、实体缺失"的行(那需要人工判断是重建还是清元数据)。
 * 权限:admin/editor。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { pruneOrphans } from '@/server/services/workshop/aml/entity'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const body = await readBody<{ dryRun?: boolean }>(event) ?? {}
  const dryRun = body.dryRun === true
  const result = pruneOrphans(dryRun)
  if (!dryRun && result.removed.length > 0) {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'aml.entity.prune', kind: 'system',
      summary: `清理 AML 孤儿实体目录 ${result.removed.length} 个`,
      targetKind: 'aml_env', targetId: 'entities',
    })
  }
  return result
})
