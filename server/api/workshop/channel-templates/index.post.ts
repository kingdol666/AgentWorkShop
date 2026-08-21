/**
 * POST /api/workshop/channel-templates —— 创建 Channel 模板(场景 + 工作目录 + 成员组合)。
 * 成员引用的 Agent 模板须操作者可读(属主/public/内置);visibility 缺省 private。
 */
import { z } from 'zod'
import { resolveUser } from '../caller'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { getWorkshopManager } from '../../../plugins/workshop'

const memberSchema = z.union([
  z.object({ templateId: z.string().min(1), role: z.enum(['lead', 'worker']) }),
  z.object({
    inline: z.object({
      name: z.string().min(1),
      harness: z.string().min(1),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
    role: z.enum(['lead', 'worker']),
  }),
])

const createSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  description: z.string().optional(),
  scenarioPrompt: z.string().optional(),
  workspace: z.string().optional(),
  lead: z.object({
    name: z.string().min(1),
    harness: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  }).nullable().optional(),
  members: z.array(memberSchema).optional(),
  visibility: z.enum(['private', 'public']).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(createSchema))
  const manager = getWorkshopManager()
  // 成员模板引用校验:引用的 Agent 模板须操作者可读
  for (const m of body.members ?? []) {
    if ('templateId' in m) {
      const tpl = manager.getAgent(m.templateId)
      if (!tpl) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${m.templateId}`)
      manager.requireTemplateReadable(tpl, user, 'Agent 模板')
    }
  }
  return manager.createChannelTemplate({
    name: body.name,
    description: body.description,
    scenarioPrompt: body.scenarioPrompt,
    workspace: body.workspace,
    lead: body.lead ?? null,
    members: body.members ?? [],
    visibility: body.visibility,
    ownerUserId: user.id,
  })
})
