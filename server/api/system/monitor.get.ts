/**
 * GET /api/system/monitor —— 运行时资源监控快照(用户级隔离)。
 * 普通用户:仅本人 channel 的 runtime/agent/进程(孤儿与无主资源不可见);
 * admin:全量视图,附 ownerUserId/ownerName(创建者)标注。需要用户 token(管理面)。
 */
import { defineApiHandler } from '../../utils/response'
import { resolveUser } from '../workshop/caller'
import { getWorkshopManager } from '../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getWorkshopManager().monitorRuntimeForUser(user)
})
