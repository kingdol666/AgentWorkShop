/**
 * GET /api/workshop/aml/datasets/:id —— 数据集详情(注册表行 + 统计/清洗报告)。
 */
import { getRouterParam } from 'h3'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const ds = getAmlRuntime().repo.dataset.get(id)
  if (!ds) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${id} 不存在`)
  requireLineMode(user, ds.lineId, 'readonly')
  const reportPath = join(ds.path, 'report.json')
  const report = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, 'utf8'))
    : null
  return { dataset: ds, report }
})
