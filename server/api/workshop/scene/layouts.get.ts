/**
 * GET /api/workshop/scene/layouts —— 频道领地放置清单(3D 小镇布局持久化)。
 * - Bearer 用户 token;返回 { layouts: SceneLayout[] }
 * - 前端按自己频道 id 过滤;empty = 场景尚未放置任何频道(初始场地)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getSceneLayoutRepo } from '@/server/services/workshop/scene/scene-layout.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  return { layouts: getSceneLayoutRepo().listAll() }
})
