/**
 * POST /api/workshop/daq/export —— 用户面批量导出(异步任务,并发=1 队列)。
 * body: { line_id?, node_ids?, from?, to?, last_minutes?, title?, note?, merge? }
 * 返回 job 台账行;进度经 GET /api/workshop/daq/export/:id 查询。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { startDaqExport } from '@/server/services/workshop/eda/data-export'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const num = (k: string): number | undefined => {
    const v = body[k]
    if (v == null || String(v).trim() === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  try {
    const job = startDaqExport(user, {
      lineId: body.line_id ? String(body.line_id) : undefined,
      nodeIds: Array.isArray(body.node_ids)
        ? body.node_ids.map(x => String(x))
        : (body.node_ids ? String(body.node_ids).split(',').map(s => s.trim()).filter(Boolean) : undefined),
      fromMs: num('from'),
      toMs: num('to'),
      lastMinutes: num('last_minutes'),
      title: body.title ? String(body.title) : undefined,
      note: body.note ? String(body.note) : undefined,
      merge: body.merge === true || body.merge === 'true',
    })
    return { job }
  }
  catch (err) {
    const e = err as { status?: number, code?: string, message?: string }
    if (e.status && e.code) throw new AppError(e.status, e.code as never, e.message ?? '导出失败')
    throw err
  }
})
