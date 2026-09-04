/**
 * GET /api/system/settings —— 运行时设置全量快照。
 * 返回描述符 + 有效值 + 各键来源(config.yml/runtime/env) + 覆盖文件路径。
 * 前端「系统设置 → 运行配置」表单据此渲染;CLI `aw status` 也走同源概念。
 * 鉴权:admin/editor(effective 含 MQTT 密钥/objectstore secretKey 等敏感字段)。
 */
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'

export default defineApiHandler((event) => {
  requireRole(event, ['admin', 'editor'])
  return getSystemConfigService().snapshot()
})
