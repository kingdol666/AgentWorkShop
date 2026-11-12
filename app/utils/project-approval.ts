/**
 * 项目审批摘要(第二轮 E10)。
 *
 * 审批历史此前直接截取 payloadJson 前 140 字符,用户看到的是
 * `{"deliverables":[{"id":"13a3…","status":"approved"}]…`。
 * 这里按审批类型抽出人话;坏 JSON/未知类型返回空串,组件回退到类型名。
 */

export interface ApprovalContext {
  /** 审批对象 id(交付物/成果审批时用于补全名称) */
  subjectId?: string
  deliverables?: Array<{ id: string, name: string }>
  results?: Array<{ id: string, title: string, summary?: string }>
}

interface Payload {
  goal?: unknown
  strategy?: unknown
  plan?: Payload
  deliverables?: unknown
  deliverableId?: unknown
  deliverableName?: unknown
  resultId?: unknown
  resultTitle?: unknown
  title?: unknown
  version?: unknown
  workItemCount?: unknown
  completedWorkItems?: unknown
  workItems?: unknown
}

function obj(raw: unknown): Payload | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Payload : null
}

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

function shortId(raw: unknown): string {
  const id = text(raw)
  return id ? id.slice(0, 8) : ''
}

function versionOf(p: Payload): string {
  return typeof p.version === 'number' ? ` · v${p.version}` : ''
}

function parse(payloadJson?: string): Payload | null {
  if (!payloadJson) return null
  try {
    return obj(JSON.parse(payloadJson))
  }
  catch {
    return null
  }
}

export function approvalSummary(kind: string, payloadJson?: string, ctx?: ApprovalContext): string {
  const p = parse(payloadJson)
  if (!p) return ''

  if (kind === 'plan_approval') {
    const plan = obj(p.plan) ?? p
    const goal = text(plan.goal)
    const list = Array.isArray(plan.deliverables) ? plan.deliverables : []
    const parts: string[] = []
    if (goal) parts.push(goal)
    if (list.length > 0) parts.push(`${list.length} 项交付物`)
    return parts.join(' · ')
  }

  if (kind === 'deliverable_acceptance') {
    const id = text(p.deliverableId) || text(ctx?.subjectId)
    const known = ctx?.deliverables?.find(d => d.id === id)?.name
    // 审批对象可能是“交付物”也可能是其下的成果(subjectId 指向 result)
    const knownResult = ctx?.results?.find(r => r.id === id)?.title
    const name = text(p.deliverableName) || known || knownResult || shortId(id)
    return name ? `交付物:${name}${versionOf(p)}` : ''
  }

  if (kind === 'result_acceptance' || kind === 'result_review') {
    const id = text(p.resultId) || text(ctx?.subjectId)
    const known = ctx?.results?.find(r => r.id === id)?.title
    const title = text(p.resultTitle) || text(p.title) || known || shortId(id)
    return title ? `成果:${title}${versionOf(p)}` : ''
  }

  if (kind === 'project_complete') {
    const total = typeof p.workItemCount === 'number'
      ? p.workItemCount
      : Array.isArray(p.workItems)
        ? p.workItems.length
        : undefined
    const done = typeof p.completedWorkItems === 'number' ? p.completedWorkItems : undefined
    if (total != null) return done != null ? `工作项 ${done}/${total} 已完成` : `工作项 ${total} 项收口`
    return '项目收口'
  }

  return ''
}
