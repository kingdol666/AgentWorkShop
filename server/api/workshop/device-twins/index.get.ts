/**
 * GET /api/workshop/device-twins —— 数字孪生设备列表。
 * - Bearer 用户 token;?workspaceId= 可选作用域
 * - 返回 { twins: DeviceTwin[] }
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo } from '@/server/services/workshop/assets/device-twin.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const workspaceId = typeof q.workspaceId === 'string' ? q.workspaceId : ''
  return { twins: getDeviceTwinRepo().listAll(workspaceId) }
})
