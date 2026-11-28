/**
 * POST /api/workshop/memory/import —— 导入同 scope JSONL（批次 L；敏感过滤 + 幂等）。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { importMemoryJsonl } from '@/server/services/workshop/memory/export'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const channelId = String(body.channelId ?? '')
  const jsonl = String(body.jsonl ?? '')
  if (!channelId || !jsonl) throw new AppError(422, 'INVALID', 'channelId 与 jsonl 必填')
  if (user.role !== 'admin') {
    const row = getAmlRuntime().db.prepare('SELECT owner_user_id AS owner FROM channels WHERE id = ?').get(channelId) as { owner?: string | null } | undefined
    if (!row || row.owner !== user.id) throw new AppError(403, 'FORBIDDEN', '仅频道 owner/管理员可导入')
  }
  if (Buffer.byteLength(jsonl, 'utf8') > 4 * 1024 * 1024) throw new AppError(413, 'TOO_LARGE', '导入文件超过 4MB')
  const report = importMemoryJsonl(getAmlRuntime().db, channelId, jsonl, user.id)
  try {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user', action: 'memory.import', kind: 'system',
      targetKind: 'channel', targetId: channelId,
      summary: `导入记忆：memories ${report.memories} / blocks ${report.blocks} / docs ${report.documents} / skipped ${report.skipped} / redacted ${report.redacted}`,
    })
  }
  catch { /* 审计失败不影响导入 */ }
  return report
})
