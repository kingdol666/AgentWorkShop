/**
 * PATCH /api/workshop/channel-templates/:id —— 更新 Channel 模板。
 * 权限:属主或 admin;内置模板任何人不可修改(TEMPLATE_BUILTIN)。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { resolveUser } from '../caller'
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

const patchSchema = z.object({
  name: z.string().min(1).optional(),
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
  const templateId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(patchSchema))
  const manager = getWorkshopManager()
  const tpl = manager.getChannelTemplate(templateId)
  if (!tpl) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
  manager.requireWritable(tpl.ownerUserId, user, 'Channel 模板')
  return manager.updateChannelTemplate(templateId, body)
})
