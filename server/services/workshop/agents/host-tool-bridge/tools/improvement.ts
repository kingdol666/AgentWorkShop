/**
 * 改进提案读面（WP-D2）—— improvement_list 工具。
 *
 * 只读：把反射器产出的「带证据候选」列给 Agent（改配方/入知识/补 runbook 的建议）。
 * 真正的写动作必须走各自的 HITL 工具（recipe_update / kb_agent ingest），本工具不写任何东西。
 */
import type { AgentWorkspace } from '../../agent-interface'
import type { HostToolResult } from '../types'

const STATUSES = new Set(['pending', 'accepted', 'rejected', 'expired'])

export async function handleImprovementList(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  if (!ws.listImprovementProposals) {
    return { text: '改进提案读面在当前运行时不可用（workspace 未接线）。', isError: true }
  }
  const rawStatus = typeof args.status === 'string' ? args.status.trim() : ''
  const status = rawStatus && STATUSES.has(rawStatus) ? rawStatus as 'pending' | 'accepted' | 'rejected' | 'expired' : undefined
  const limit = typeof args.limit === 'number' ? args.limit : undefined
  const rows = await ws.listImprovementProposals({ status, limit })
  if (rows.length === 0) {
    return { text: `暂无改进提案${status ? `（status=${status}）` : ''}。提案由反射器在干预判定为 identifiable_effect 等场景自动产出。` }
  }
  const lines = rows.map((r) => {
    const ev = [
      r.lineId ? `line=${r.lineId}` : '',
      r.recipeId ? `recipe=${r.recipeId}` : '',
      `source=${r.sourceKind}:${r.sourceId.slice(0, 8)}`,
      r.decidedAt ? `decided=${r.decidedAt.slice(0, 16)}` : '',
    ].filter(Boolean).join(' · ')
    return `- [${r.status}] ${r.title}\n    ${r.detail}\n    id=${r.id} · ${ev}`
  })
  return { text: `改进提案（${rows.length} 条${status ? `，status=${status}` : ''}）：\n${lines.join('\n')}\n\n注意：提案只是候选；执行必须走对应 HITL 工具（recipe_update 等），审批通过后才会真正改产线。` }
}
