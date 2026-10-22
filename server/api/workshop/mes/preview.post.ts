/**
 * POST /api/workshop/mes/preview —— MES 调试台取数预览(用户面)。
 * body: { node_id, from, to, max_rows? } → 结构化统计 + ≤3 行采样 + 字段字典 + 脱敏 req 回显。
 * 频控 30 次/60s 按 userId;护栏:窗 ≤7 天、行 ≤5000;原文(图像像素/全量行)不进响应。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { mesPreview } from '@/server/services/workshop/eda/mes-console'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ node_id?: string, from?: string, to?: string, max_rows?: number | string }>(event) ?? {}
  const nodeId = String(body.node_id ?? '').trim()
  if (!nodeId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'node_id 必填。')
  const now = Date.now()
  const fromIso = String(body.from ?? '') || new Date(now - 3600_000).toISOString()
  const toIso = String(body.to ?? '') || new Date(now).toISOString()
  const r = await mesPreview(user, { nodeId, fromIso, toIso, maxRows: body.max_rows == null ? undefined : Number(body.max_rows) })
  if (!r.ok) {
    throw new AppError(r.status, r.code as never, r.message)
  }
  return r.data
})
