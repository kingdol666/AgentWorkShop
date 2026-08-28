/**
 * POST /api/workshop/daq/templates —— 新建自定义信号模板(登录用户)。
 * 成功后广播 daq.template.changed(op=added)收敛全部客户端。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqTemplateRegistry } from '@/server/services/workshop/daq/daq-templates'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import type { AepDaqTemplateChange, DaqTemplateInput } from '#shared/daq-protocol'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = (await readBody(event) ?? {}) as DaqTemplateInput
  const template = getDaqTemplateRegistry().create(body)
  broadcastSceneEvent('daq.template.changed', { op: 'added', template } satisfies AepDaqTemplateChange)
  return { template }
})
