/**
 * GET/PATCH /api/workshop/channels/:id/memory-access-mode —— Memory Fabric 访问策略（批次 I）。
 * inherit/isolated/disabled/readonly；disabled=incognito（不读不写）；readonly=只读。
 */
import { getRouterParam, readBody } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { recordOps } from '../../../../../services/workshop/ops/ops'

const MODES = new Set(['inherit', 'isolated', 'disabled', 'readonly'])

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  if ((event.method?.toUpperCase() ?? 'GET') === 'GET') {
    return { mode: (channel as unknown as { memoryAccessMode?: string }).memoryAccessMode ?? 'inherit' }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const mode = String(body.mode ?? '')
  if (!MODES.has(mode)) throw new AppError(422, 'INVALID_MODE', 'mode 必须是 inherit/isolated/disabled/readonly')
  manager.deps.db.prepare('UPDATE channels SET memory_access_mode = ?, updated_at = ? WHERE id = ?')
    .run(mode, new Date().toISOString(), channelId)
  try {
    recordOps({
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action: 'memory.access_mode.update',
      kind: 'system',
      targetKind: 'channel',
      targetId: channelId,
      summary: `记忆访问策略 → ${mode}`,
      lineId: channel.lineId ?? '',
    })
  }
  catch { /* 审计失败不影响策略 */ }
  return { mode }
})
