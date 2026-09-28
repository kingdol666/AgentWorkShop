/**
 * PATCH /api/system/settings —— 写入运行时设置（持久化 + 热重载）。
 * body: { "override": { "<key>": value | null } }
 *   value 非 null → 校验后写入 data/runtime-settings.json 并立即应用(live 键实时生效)
 *   value 为 null → 清除该键覆盖(回落 config.yml)
 * 返回 { changed, restartRequired, effective, sources, overrides }。
 * 鉴权:仅 admin（系统级设置变更属高危管理面）。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'
import { recordOps } from '../../../services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  const overrides = body.override ?? body.overrides ?? body
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, message: '请求体应为 { "override": { key: value } }' }
  }
  const res = getSystemConfigService().patch(overrides as Record<string, unknown>)
  // 高危管理面留痕:改了哪些键(值不落审计——可能含凭据),谁改的
  if (res.changed?.length) {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'system.settings.update', kind: 'system',
      summary: `运行时设置变更:${res.changed.join(', ')}`,
    })
  }
  return { ok: true, ...res }
})
