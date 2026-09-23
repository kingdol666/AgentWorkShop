/**
 * 密集行视图去重(纯函数供密集行视图复用)。
 */
import type { AepEnvelope } from '#shared/workshop-protocol'
import { classifyEvent } from './classify'
import { foldRelation, taskIdOf, textOf } from './text-utils'

/**
 * 密集行视图去重:delta→全文落定同为 agent.status.message/agent.message 时,
 * fold 掉落定帧(row 只保留一段),流/工具行保持各自 row。
 */
export function foldStreamDuplicates(events: AepEnvelope[]): AepEnvelope[] {
  const out: AepEnvelope[] = []
  const trails = new Map<string, string>()
  for (const e of events) {
    const cls = classifyEvent(e)
    const key = `${e.agentId ?? ''}\u0000${taskIdOf(e) ?? ''}`
    switch (e.type) {
      case 'agent.delta':
        trails.set(key, (trails.get(key) ?? '') + textOf(e))
        out.push(e)
        break
      case 'agent.message':
      case 'agent.status.message': {
        const isTool = e.type === 'agent.status.message' && cls === 'tool'
        if (e.type === 'agent.status.message' && isTool) {
          out.push(e)
          break
        }
        const t = textOf(e).trim()
        const trail = trails.get(key) ?? ''
        trails.set(key, '')
        if (t && (foldRelation(trail, t) === 'dup' || foldRelation(trail, t) === 'extend')) {
          // 与流累计重复:流已渲染(渲染于前序 row)
          continue
        }
        out.push(e)
        break
      }
      default:
        out.push(e)
    }
  }
  return out
}
