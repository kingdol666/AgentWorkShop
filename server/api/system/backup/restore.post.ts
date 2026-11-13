import { getValidatedQuery, readValidatedBody } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../utils/response'
import { requireAdmin } from '../../workshop/caller'
import { AppError } from '../../../utils/errors'
import { restoreBackup, RESTORE_CONFIRMATION } from '../../../services/workshop/db/backup/restore'

const bodySchema = z.object({
  source: z.string().min(1).max(1024),
  target: z.string().min(1).max(1024),
  confirm: z.string().optional(),
})

/** POST /api/system/backup/restore —— 仅恢复单个 SQLite 文件；默认 dry-run，拒绝覆盖现有目标。 */
export default defineApiHandler(async (event) => {
  const admin = requireAdmin(event)
  const body = await readValidatedBody(event, (input: unknown) => {
    const parsed = bodySchema.safeParse(input)
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', '恢复请求需提供 source/target')
    return parsed.data
  })
  const query = await getValidatedQuery(event, (input: unknown) => ({ dryRun: String((input as { dryRun?: unknown })?.dryRun ?? 'true') !== 'false' }))
  try {
    const report = await restoreBackup({
      source: body.source,
      target: body.target,
      dryRun: query.dryRun,
      confirm: body.confirm,
    })
    return { ...report, requestedBy: admin.id, confirmation: RESTORE_CONFIRMATION }
  }
  catch (err) {
    throw new AppError(400, 'RESTORE_REJECTED', err instanceof Error ? err.message : String(err))
  }
})
