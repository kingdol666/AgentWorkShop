/**
 * GET /api/workshop/mes/datasets —— MES 数据集台账(用户面)。
 * 可见 = 数据集产线可读(readonly+)或创建者本人;只回台账与统计读取,文件路径不外露绝对盘符以外语义。
 * GET /api/workshop/mes/datasets/:id?mode=head|stats|rows&offset= —— 单数据集读取(采样 ≤3 行,原文不进响应)。
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { lineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { getMesDatasets } from '@/server/services/workshop/mes/mes-datasets'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const store = getMesDatasets()
  const id = getRouterParam(event, 'id')
  const all = store.listDatasets(200)
  const visible = all.filter((ds) => {
    if (ds.createdBy === user.id) return true
    return !!ds.lineId && lineMode(user, ds.lineId) !== 'none'
  })
  if (!id) {
    return {
      datasets: visible.map(ds => ({
        id: ds.id,
        nodeId: ds.nodeId,
        nodeName: ds.nodeName || ds.nodeId,
        lineId: ds.lineId || '',
        fromTs: ds.fromTs,
        toTs: ds.toTs,
        rows: ds.rows,
        status: ds.status,
        error: ds.status === 'failed' ? String(ds.error ?? '').slice(0, 200) : undefined,
        createdBy: ds.createdBy,
      })),
      count: visible.length,
    }
  }
  const meta = store.datasetMeta(id)
  if (!meta) throw new AppError(404, ErrorCodes.NOT_FOUND, `数据集不存在: ${id}`)
  if (meta.createdBy !== user.id && !(meta.lineId && lineMode(user, meta.lineId) !== 'none')) {
    throw new AppError(403, 'SCOPE_VIOLATION' as never, '该数据集不在你的可读范围内。')
  }
  const q = getQuery(event)
  const mode = String(q.mode ?? 'head')
  const r = store.readDataset(id, mode === 'stats' || mode === 'rows' ? mode : 'head', Number(q.offset) || 0)
  if (r.mode === 'stats') {
    return { id, mode: 'stats', stats: r.stats, nodeName: meta.nodeName || meta.nodeId }
  }
  if (r.mode === 'rows') {
    return { id, mode: 'rows', total: r.rowsView.total, offset: r.rowsView.offset, rows: r.rowsView.rows.slice(0, 20) }
  }
  return { id, mode: 'head', columns: r.head.columns, totalRows: r.head.totalRows, preview: r.head.preview.slice(0, 3) }
})
