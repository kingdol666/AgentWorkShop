/**
 * Goal 完成门的运行时探针：把 Agent 绑定面 + DAQ 控制器实时读数接给纯判定器。
 * 只读；不写任务、不下发。
 */
import { getAgentNodeBindingRepo } from '../agents/node-bindings.repo'
import { getDaqController } from '../daq/daq-controller'
import { evaluateGoalCompletion, parseTargetBand, type GoalCompletionVerifier } from './goal-completion'

const WRITE_BINDING_KINDS = new Set(['dcw', 'recipe', 'line-recipe'])

function bindingsOf(agentId: string | undefined): { daq: string[], writes: boolean } {
  if (!agentId) return { daq: [], writes: false }
  try {
    const rows = getAgentNodeBindingRepo().byAgent(agentId)
    return {
      daq: rows.filter(b => b.kind === 'daq').map(b => b.nodeId),
      writes: rows.some(b => WRITE_BINDING_KINDS.has(b.kind)),
    }
  }
  catch {
    return { daq: [], writes: false }
  }
}

function latestReading(nodeId: string): { value: number | null, atMs: number | null, quality: string | null } | null {
  try {
    const node = getDaqController().byId(nodeId)
    if (!node) return null
    const atMs = node.lastAt ? Date.parse(node.lastAt) : Number.NaN
    return {
      value: typeof node.value === 'number' && Number.isFinite(node.value) ? node.value : null,
      atMs: Number.isFinite(atMs) ? atMs : null,
      quality: node.quality ?? null,
    }
  }
  catch {
    return null
  }
}

/** caller（Lead）、任务接收者（Worker）与其子任务接收者的 DAQ 绑定面取并集。 */
export function buildGoalCompletionVerifier(callerAgentId: string): GoalCompletionVerifier {
  return (task, args) => {
    const agentIds = [callerAgentId, task.assigneeId, ...(task.relatedAssigneeIds ?? [])]
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    const allowedNodeIds = new Set<string>()
    let writes = false
    for (const agentId of agentIds) {
      const summary = bindingsOf(agentId)
      for (const nodeId of summary.daq) allowedNodeIds.add(nodeId)
      if (summary.writes) writes = true
    }
    // 没有写授权（dcw/recipe/line-recipe）的任务不可能改设备：不启用完成门，
    // 避免把纯分析任务（标题里恰好含 32.5±0.35）误伤。
    const band = parseTargetBand(`${task.title ?? ''}\n${task.description ?? ''}`)
    if (band && !writes) return { ok: true, skipped: true }
    return evaluateGoalCompletion({
      title: task.title ?? '',
      description: task.description ?? '',
      verification: args.verification,
      allowedNodeIds,
      readLatest: latestReading,
    })
  }
}
