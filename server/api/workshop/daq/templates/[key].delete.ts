/**
 * DELETE /api/workshop/daq/templates/:key —— 删除自定义信号模板(内置模板拒绝)。
 * 成功后广播 daq.template.changed(op=removed);已建节点不受影响(域已落节点)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqTemplateRegistry } from '@/server/services/workshop/daq/daq-templates'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import type { AepDaqTemplateChange } from '#shared/daq-protocol'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const key = getRouterParam(event, 'key') ?? ''
  const removed = getDaqTemplateRegistry().remove(key)
  broadcastSceneEvent('daq.template.changed', { op: 'removed', template: removed } satisfies AepDaqTemplateChange)
  return { removed: removed.key }
})
