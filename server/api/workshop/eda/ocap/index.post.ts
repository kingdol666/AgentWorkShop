/**
 * POST /api/workshop/eda/ocap —— 开 OCAP 处置单(见 index.get.ts 头注;方法分文件)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { createOcap } from '@/server/services/workshop/eda/ocap'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const alarmId = String(body.alarm_id ?? '').trim()
  const title = String(body.title ?? '').trim()
  if (!alarmId || !title) throw new AppError(400, 'VALIDATION_ERROR' as never, 'alarm_id 与 title 必填。')
  try {
    return { record: createOcap(user, {
      alarmId,
      title,
      runId: body.run_id ? String(body.run_id) : undefined,
      nodeId: body.node_id ? String(body.node_id) : undefined,
    }) }
  }
  catch (err) {
    throw new AppError(400, 'VALIDATION_ERROR' as never, err instanceof Error ? err.message : String(err))
  }
})
