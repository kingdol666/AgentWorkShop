/**
 * PATCH /api/workshop/dcw/recipes/:id —— 编辑配方。
 * params 变更自动版本化(paramsHistory 入史,归因=当前用户)。
 */
import { getRouterParam, readBody } from 'h3'
import type { RecipeInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<Partial<RecipeInput>>(event) ?? {}
  const recipe = getDcwController().updateRecipe(id, body, {
    by: 'user',
    actorName: user.name,
    actor: user.id,
    description: '界面编辑配方',
  })
  return { recipe }
})
