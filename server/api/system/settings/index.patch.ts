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

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin'])
  const body = (await readBody(event)) ?? {}
  const overrides = body.override ?? body.overrides ?? body
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, message: '请求体应为 { "override": { key: value } }' }
  }
  return { ok: true, ...getSystemConfigService().patch(overrides as Record<string, unknown>) }
})
