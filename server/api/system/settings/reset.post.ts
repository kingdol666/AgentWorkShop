/**
 * POST /api/system/settings/reset —— 清空全部运行时覆盖（回落 config.yml/base + env）。
 * 鉴权:仅 admin。
 */
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'
import { recordOps } from '../../../services/workshop/ops/ops'

export default defineApiHandler((event) => {
  const user = requireRole(event, ['admin'])
  const res = getSystemConfigService().reset()
  if (res.changed?.length) {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'system.settings.reset', kind: 'system',
      summary: `清空运行时覆盖(${res.changed.length} 键回落 config.yml)`,
    })
  }
  return { ok: true, ...res }
})
