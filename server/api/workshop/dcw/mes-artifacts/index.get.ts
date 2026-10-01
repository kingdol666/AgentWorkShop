/**
 * GET /api/workshop/dcw/mes-artifacts?node_id=&limit= —— MES 点位产物清单。
 * 返回 <数据根>/mes-artifacts/<node_id>/ 下产物(mtime 新→旧,≤limit 条):
 * { artifacts: [{name, bytes, mime, mtime}] }(不含文件内容;内容走 /file)
 */
import { getQuery } from 'h3'
import { statSync } from 'node:fs'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { listMesArtifacts } from '@/server/services/workshop/mes/mes-hook'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const nodeId = String(q.node_id ?? '').trim()
  const limit = Math.max(1, Math.min(Number(q.limit) || 50, 200))
  if (!nodeId) return { artifacts: [], message: '缺少 node_id' }
  const artifacts = listMesArtifacts(nodeId, limit).map((a) => {
    let mtime: string | null = null
    try {
      mtime = statSync(a.file).mtime.toISOString()
    }
    catch { /* 已被清理 */ }
    return { name: a.name, bytes: a.bytes, mime: a.mime, mtime }
  })
  return { artifacts, count: artifacts.length }
})
