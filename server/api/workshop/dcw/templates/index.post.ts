/**
 * POST /api/workshop/dcw/templates —— 新建自定义控制模板。
 */
import { readBody } from 'h3'
import type { DcwTemplateInput } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwTemplateRegistry } from '@/server/services/workshop/dcw/dcw-templates'
import { assertAssetManager } from '@/server/utils/asset-auth'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  assertAssetManager(user, '创建控制模板')
  const body = (await readBody(event) ?? {}) as DcwTemplateInput
  const template = getDcwTemplateRegistry().create(body)
  return { template }
})
