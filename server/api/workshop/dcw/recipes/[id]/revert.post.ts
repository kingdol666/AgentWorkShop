/**
 * POST /api/workshop/dcw/recipes/:id/revert —— 回退配方参数到指定历史版本/已知良好批次。
 * 生成新版本(非破坏;历史完整保留)。body: { version?: number, toLastGood?: boolean, reason: string }。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ version?: number, toLastGood?: boolean, reason?: string }> (event) ?? {}
  if (!body.toLastGood && body.version == null) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '需提供 version(历史版本号)或 toLastGood=true')
  }
  const recipe = getDcwController().revertRecipe(id, {
    version: body.version,
    toLastGood: body.toLastGood === true,
  }, {
    by: 'user',
    actorName: user.name,
    actor: user.id,
    description: body.reason?.trim() || '界面回退',
  })
  return { recipe }
})
