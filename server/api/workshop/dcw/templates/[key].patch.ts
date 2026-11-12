/**
 * PATCH /api/workshop/dcw/templates/:key —— 编辑自定义控制模板(内置拒绝)。
 */
import { getRouterParam, readBody } from 'h3'
import type { DcwTemplateInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwTemplateRegistry } from '@/server/services/workshop/dcw/dcw-templates'
import { assertAssetManager } from '@/server/utils/asset-auth'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  assertAssetManager(user, '编辑控制模板')
  const key = getRouterParam(event, 'key') ?? ''
  const body = (await readBody(event) ?? {}) as Partial<DcwTemplateInput>
  const template = getDcwTemplateRegistry().update(key, body)
  return { template }
})
