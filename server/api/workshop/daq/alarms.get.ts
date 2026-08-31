/**
 * GET /api/workshop/daq/alarms?scope=open|all&limit= —— 报警列表(S5)。
 * open = 未确认(默认);all = 含已确认历史(审计/复盘)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const scope = q.scope === 'all' ? 'all' : 'open'
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100))
  return { alarms: getDaqController().listAlarms(scope, limit) }
})
