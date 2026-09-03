/**
 * POST /api/system/settings/reset —— 清空全部运行时覆盖（回落 config.yml/base + env）。
 * 鉴权:仅 admin。
 */
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'

export default defineApiHandler((event) => {
  requireRole(event, ['admin'])
  return { ok: true, ...getSystemConfigService().reset() }
})
