/**
 * POST /api/system/backup/run —— 手动触发一次全量备份(admin)。
 * 复用 server/plugins/backup.ts 的 backupOnce(三库在线快照 + JSON/配置面 + 保留轮转),
 * 成败均落 audit_log(system.backup.*)。
 */
import { defineApiHandler } from '../../../utils/response'
import { requireAdmin } from '../../workshop/caller'
import { AppError } from '../../../utils/errors'

export default defineApiHandler(async (event) => {
  requireAdmin(event)
  const { backupOnce } = await import('../../../plugins/backup')
  const { ensureDataDir } = await import('@/shared/config/home.mjs')
  try {
    await backupOnce(ensureDataDir())
  }
  catch (err) {
    throw new AppError(500, 'BACKUP_FAILED', `备份失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: true, at: new Date().toISOString() }
})
