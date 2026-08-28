/**
 * PATCH /api/workshop/daq/templates/:key —— 编辑自定义信号模板(内置模板拒绝)。
 * 成功后广播 daq.template.changed(op=updated)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqTemplateRegistry } from '@/server/services/workshop/daq/daq-templates'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import type { AepDaqTemplateChange, DaqTemplateInput } from '#shared/daq-protocol'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const key = getRouterParam(event, 'key') ?? ''
  const body = (await readBody(event) ?? {}) as Partial<DaqTemplateInput>
  const template = getDaqTemplateRegistry().update(key, body)
  broadcastSceneEvent('daq.template.changed', { op: 'updated', template } satisfies AepDaqTemplateChange)
  return { template }
})
