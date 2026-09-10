/**
 * POST /api/workshop/teams —— 创建 AgentTeam(Agent 模板编组容器)。
 * visibility 缺省 private;public = 全员可读可用,仅属主/admin 可改删。
 * plugins 可选(建队勾选启用哪些插件):以 team id 为键落团队偏好,部署时传导到 channel。
 */
import { z } from 'zod'
import { resolveUser } from '../caller'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { getPluginHost, pluginManifest } from '@/server/services/workshop/plugins/host.mjs'
import type { ChannelPluginToggle } from '@/server/services/workshop/db/channel-plugins.repo'

const createTeamSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  description: z.string().optional(),
  visibility: z.enum(['private', 'public']).optional(),
  plugins: z.array(z.object({ name: z.string(), enabled: z.boolean() })).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(createTeamSchema))
  // 只接受已注册且启用的插件名(与 teams/:id/plugins PUT 同语义;停用插件写入无意义)
  const host = getPluginHost()
  const registered = new Set(host ? pluginManifest().filter(p => p.enabled).map(p => p.name) : [])
  const plugins: ChannelPluginToggle[] | undefined = body.plugins
    ? body.plugins
        .filter(p => registered.has(p.name))
        .map(p => ({ name: p.name, enabled: p.enabled !== false }))
    : undefined
  return getWorkshopManager().createTeam({
    name: body.name,
    description: body.description,
    visibility: body.visibility,
    ownerUserId: user.id,
    ...(plugins?.length ? { plugins } : {}),
  })
})
