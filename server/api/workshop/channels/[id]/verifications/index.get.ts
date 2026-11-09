/**
 * GET /api/workshop/channels/:id/verifications —— 独立回读验证看板（WP-C1，只读）。
 * 返回本频道写入台账的独立验证结论（match/mismatch/inconclusive）。
 * 注意：inconclusive 不等于通过；L1/门须按"未证实"处理。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../../caller'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { listBlindVerifications } from '../../../../../services/workshop/verify/blind-verifier'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const rows = listBlindVerifications(getAmlRuntime().db, channelId)
  const byVerdict: Record<string, number> = {}
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1
  return { total: rows.length, byVerdict, rows }
})
