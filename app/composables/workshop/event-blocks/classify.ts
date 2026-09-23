/**
 * 事件归类与 agent 身份配色(纯函数,渲染与聚类共用)。
 */
import type { AepEnvelope } from '#shared/workshop-protocol'
import type { BlockKind } from './types'

const TOOL_PREFIX = /^🔧\s*\S+/

/** 事件 → 聚合类别 */
export function classifyEvent(e: AepEnvelope): BlockKind {
  switch (e.type) {
    case 'agent.status.message':
      return TOOL_PREFIX.test(String((e.payload as { text?: string }).text ?? '')) ? 'tool' : 'status'
    case 'agent.status':
      return 'life'
    case 'a2a.message':
      return 'route'
    case 'agent.delta':
    case 'agent.message':
      return 'stream'
    case 'task.status':
    case 'task.progress':
      return 'task'
    case 'a2a.artifact':
      return 'artifact'
    case 'agent.member':
      return 'member'
    case 'memory.saved':
      return 'memory'
    case 'error':
      return 'error'
    default:
      return 'other'
  }
}

/** agent 稳定配色(id hash → hue;无 id 灰。饱和度/亮度压低:白字首字母可达 AA 对比;
 *  同一色相供头像/泳道头/提及悬停卡共用 —— 身份色全站同源,不另造配色) */
export function agentHueColor(agentId: string | null | undefined): string {
  if (!agentId) return '#6e6e77'
  let h = 0
  for (const ch of agentId) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h}, 42%, 34%)`
}
