/**
 * PATCH /api/workshop/channels/:id —— 更新 channel。
 *
 * 管理字段(name/description/workspace/enabled/llm)→ owner-only(语义不变)。
 * v17 群聊设置(visibility/joinPolicy/approvalPolicy/chatEnabled)→ 同样 owner-only,
 * 且支持 **version 乐观锁**:body.version 与当前不一致 → 409 VERSION_CONFLICT。
 *
 * 迁移安全:未传群聊字段的请求行为与旧版本**完全一致**(不触碰群聊维度)。
 * 开启群聊(chatEnabled=1)必须是 owner 显式提交;遗留无归属 Channel(owner NULL)
 * 依旧被 requireWritable 拦下(FORBIDDEN_LEGACY),不会因成员模型变成可写公开群聊。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '../../caller'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { AppError } from '../../../../utils/errors'
import { getWorkshopManager } from '../../../../plugins/workshop'

const channelLlmSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
}).optional()

const patchChannelSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  scenarioPrompt: z.string().optional(),
  workspace: z.string().min(1).optional(),
  enabled: z.number().int().min(0).max(1).optional(),
  /** channel 级默认 LLM(不传 = 不变;null = 清除回引擎默认) */
  llm: channelLlmSchema.nullable(),
  // ===== v17 群聊设置(owner-only)=====
  /** private = 仅成员可见;public = 登录用户可发现(仍需加入才可读/发言) */
  visibility: z.enum(['private', 'public']).optional(),
  /** open = 直接加入;owner_approve = 待 owner 批准 */
  joinPolicy: z.enum(['open', 'owner_approve']).optional(),
  /** owner_only = 仅 owner 可审批 HITL;any_member = 任一 active 成员可原子决策 */
  approvalPolicy: z.enum(['owner_only', 'any_member']).optional(),
  /** 0 = 未开启群聊(群聊端点 409);1 = 开启 */
  chatEnabled: z.number().int().min(0).max(1).optional(),
  /** 乐观锁:与当前 channels.version 不一致 → 409 VERSION_CONFLICT */
  version: z.number().int().min(0).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(patchChannelSchema))
  const manager = getWorkshopManager()
  // v17:管理守卫显式化 —— owner / admin / 遗留 403 语义与旧 getChannelForUser + requireWritable 一致
  const channel = manager.requireChannelOwner(channelId, user, 'channel')

  if (body.version !== undefined && body.version !== channel.version) {
    throw new AppError(409, 'VERSION_CONFLICT', `Channel 设置已被他处修改(当前版本 ${channel.version},提交 ${body.version}),请刷新后重试`)
  }

  const { version: _version, ...patch } = body
  const updated = await manager.updateChannel(channelId, patch)
  // 群聊设置变更 → 广播(成员/前端即时收敛)
  manager.publishChatSettings(channelId)
  return updated
})
