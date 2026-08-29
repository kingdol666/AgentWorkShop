/**
 * PATCH /api/workshop/dcw/lines/:id —— 编辑产线(名称/光晕色/描述)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import type { LineInput } from '#shared/dcw-protocol'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Partial<LineInput>>(event) ?? {}
  return { line: getDcwController().updateLine(id, body) }
})
