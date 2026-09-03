/**
 * GET /api/system/settings —— 运行时设置全量快照。
 * 返回描述符 + 有效值 + 各键来源(config.yml/runtime/env) + 覆盖文件路径。
 * 前端「系统设置 → 运行配置」表单据此渲染;CLI `aw status` 也走同源概念。
 * 鉴权:任何已登录用户可读(config.get 同语义)。
 */
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'

export default defineApiHandler((event) => {
  resolveUser(event)
  return getSystemConfigService().snapshot()
})
