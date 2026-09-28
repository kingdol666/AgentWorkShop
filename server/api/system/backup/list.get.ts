/**
 * GET /api/system/backup/list —— 备份清单(admin):库快照文件 + JSON/配置束目录。
 * 只列文件名与大小/时间,不回传内容;恢复操作 = 停实例后由运维手工替换(安全优先不给在线恢复 API)。
 */
import { readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineApiHandler } from '../../../utils/response'
import { requireAdmin } from '../../workshop/caller'
import { ensureDataDir } from '@/shared/config/home.mjs'

export default defineApiHandler(async (event) => {
  requireAdmin(event)
  const backupDir = resolve(ensureDataDir(), 'backups')
  let entries: Array<{ name: string, kind: 'db' | 'files', bytes: number, mtime: string }> = []
  try {
    entries = readdirSync(backupDir, { withFileTypes: true }).flatMap((e) => {
      const full = resolve(backupDir, e.name)
      try {
        const st = statSync(full)
        return [{
          name: e.name,
          kind: (e.isDirectory() ? 'files' : 'db') as 'db' | 'files',
          bytes: st.size,
          mtime: st.mtime.toISOString(),
        }]
      }
      catch { return [] }
    }).sort((a, b) => b.mtime.localeCompare(a.mtime))
  }
  catch { /* 备份目录尚不存在 = 还没备过 */ }
  return { backupDir, count: entries.length, entries: entries.slice(0, 200) }
})
