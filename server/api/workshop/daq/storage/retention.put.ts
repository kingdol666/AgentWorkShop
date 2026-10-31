/**
 * PUT /api/workshop/daq/storage/retention —— 逐产线保留期覆写。
 * body: { line_id, raw_retention_h?, minute_retention_h?, hour_retention_h? }
 *
 * 语义:
 *  - raw_retention_h 允许短于/长于全局(长于全局时,全局 drop_chunks 已停用,
 *    由逐线删除保证不误删);
 *  - minute_retention_h ≥ 1(小时);hour_retention_h = 0 表示永久保留;
 *  - 至少提供一个字段;未提供=保持现值不动;显式传 null=重置回全局缺省。
 */
import { readBody } from 'h3'
import { requireRole, resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { tsdbLayoutInfo, tsdbSetLineRetention } from '@/server/services/workshop/daq/storage'
import { recordOps } from '@/server/services/workshop/ops/ops'

interface Body {
  line_id?: string
  raw_retention_h?: number | null
  minute_retention_h?: number | null
  hour_retention_h?: number | null
}

function num(v: unknown, field: string, allowZero: boolean): number | null | undefined {
  // 2026-10-30 修复:absent(undefined)=保持现值;显式 null=重置回全局缺省。
  // 旧实现把「未提供」也折算成 null 下发,部分更新(如只改 hour)会把既有 raw 覆写
  // 静默抹掉 → sweep 按全局裁剪,长保留数据被删(数据安全事故级)。
  if (v === undefined) return undefined
  if (v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n < 1)) {
    throw new AppError(400, 'VALIDATION_ERROR', `${field} 必须为${allowZero ? '非负' : '正'}数字(收到 ${String(v)})`)
  }
  return Math.round(n)
}

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  requireRole(event, ['admin', 'editor'])
  const body = await readBody<Body>(event) ?? {}
  if (body.line_id == null || String(body.line_id).trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'line_id 必填(未分配产线请显式传空串的语义请用专用接口,不支持在此误改)')
  }
  const patch = {
    rawRetentionH: num(body.raw_retention_h, 'raw_retention_h', false),
    minuteRetentionH: num(body.minute_retention_h, 'minute_retention_h', false),
    hourRetentionH: num(body.hour_retention_h, 'hour_retention_h', true),
  }
  if (body.raw_retention_h === undefined && body.minute_retention_h === undefined && body.hour_retention_h === undefined) {
    throw new AppError(400, 'VALIDATION_ERROR', '至少提供 raw_retention_h / minute_retention_h / hour_retention_h 之一')
  }
  await tsdbSetLineRetention(String(body.line_id), patch)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'daq.storage.retention',
    kind: 'daq',
    targetKind: 'daq-line',
    targetId: String(body.line_id),
    lineId: String(body.line_id),
    summary: `设置产线保留期:raw=${patch.rawRetentionH === undefined ? '未改' : patch.rawRetentionH ?? '重置为全局'}h / minute=${patch.minuteRetentionH === undefined ? '未改' : patch.minuteRetentionH ?? '重置为全局'}h / hour=${patch.hourRetentionH === undefined ? '未改' : patch.hourRetentionH ?? '重置为全局'}h`,
  })
  return { layout: await tsdbLayoutInfo() }
})
