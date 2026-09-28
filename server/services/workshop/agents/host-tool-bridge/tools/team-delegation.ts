/**
 * 团队节点权限委派工具(lead 专属):team_grant_nodes / team_revoke_nodes。
 *
 * lead 把**自己已绑定**的 DAQ/DCW 节点授权给同频道 worker(派发前、执行中均可),
 * 授权面不可超越 lead 本人的绑定面(planDelegation fail-closed 校验)。
 * 校验核心在 agents/node-delegation.ts;本文件只做工具面参数解析与结果文本。
 */
import { AppError } from '../../../../../utils/errors'
import { applyDelegation, planDelegation, revokeDelegation, type DelegationMember } from '../../node-delegation'
import type { HostToolBridgeContext, HostToolResult } from '../types'

/** workspace 成员视图(listAgents 与本工具面的最小接口;便于单测桩替换) */
interface MembersView {
  listAgents(): Promise<Array<{ id: string, role: 'lead' | 'worker', enabled?: number }>>
}

function membersOf(ws: MembersView): Promise<DelegationMember[]> {
  return ws.listAgents() as Promise<DelegationMember[]>
}

function summaryText(bindings: Array<{ nodeId: string, kind: string, mode: string }>): string {
  const lines = bindings.map(b => `  - ${b.kind === 'daq' ? '数采' : '写控'} ${b.nodeId}(mode=${b.mode})`)
  return `\n${lines.join('\n')}`
}

function parseNodeIds(args: Record<string, unknown>): string[] {
  const raw = args.node_ids ?? args.nodeIds
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  return list.map(x => String(x ?? '').trim()).filter(Boolean)
}

/** lead → worker 授予节点(自己绑定面内的节点;fail-closed 全成全败) */
export async function handleGrantNodes(identity: HostToolBridgeContext['identity'], args: Record<string, unknown>, ws: MembersView): Promise<HostToolResult> {
  const targetAgentId = String(args.agent_id ?? args.assignee_id ?? '').trim()
  const nodeIds = parseNodeIds(args)
  const mode = args.mode === 'manual' || args.mode === 'auto' ? (args.mode as 'auto' | 'manual') : undefined
  try {
    const plan = planDelegation({
      leaderAgentId: identity.agentId,
      channelId: identity.channelId,
      targetAgentId,
      nodeIds,
      members: await membersOf(ws),
      mode,
    })
    const bindings = applyDelegation(plan, identity.agentId)
    return {
      text: `已把 ${bindings.length} 条节点授权授予 ${targetAgentId}:${summaryText(bindings)}\n来源:lead 绑定面内的节点;worker 现在可用 my_industrial_nodes 查看自己的授权。`,
    }
  }
  catch (err) {
    return { text: err instanceof AppError ? err.message : `节点授权失败: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** lead 收回授予给 worker 的节点授权 */
export async function handleRevokeNodes(identity: HostToolBridgeContext['identity'], args: Record<string, unknown>, ws: MembersView): Promise<HostToolResult> {
  const targetAgentId = String(args.agent_id ?? args.assignee_id ?? '').trim()
  const nodeIds = parseNodeIds(args)
  try {
    const results = revokeDelegation({
      leaderAgentId: identity.agentId,
      targetAgentId,
      nodeIds,
      members: await membersOf(ws),
    })
    const okList = results.filter(r => r.revoked)
    const missList = results.filter(r => !r.revoked)
    const parts = [`已收回 ${okList.length} 条授权`, ...okList.map(r => `  - ${r.kind} ${r.nodeId}`)]
    if (missList.length) parts.push(`未收回(不在其绑定面或非你授予):${missList.map(r => `${r.kind}:${r.nodeId}`).join('、')}`)
    return { text: parts.join('\n') }
  }
  catch (err) {
    return { text: err instanceof AppError ? err.message : `收回授权失败: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

export interface DispatchGrantResult {
  ok: boolean
  text: string
}

/**
 * 派发时随任务授予节点(dispatch_task 的 grant_node_ids;lead 专属)。
 * fail-closed:任一节点不在 lead 绑定面 → 整单失败,任务不创建。
 */
export async function grantNodesForDispatch(identity: HostToolBridgeContext['identity'], assigneeId: string, nodeIds: string[], mode: 'auto' | 'manual' | undefined, ws: MembersView): Promise<DispatchGrantResult> {
  try {
    const plan = planDelegation({
      leaderAgentId: identity.agentId,
      channelId: identity.channelId,
      targetAgentId: assigneeId,
      nodeIds,
      members: await membersOf(ws),
      mode,
    })
    const bindings = applyDelegation(plan, identity.agentId)
    return { ok: true, text: `随任务授予 ${bindings.length} 条节点授权 → ${assigneeId}${summaryText(bindings)}` }
  }
  catch (err) {
    const msg = err instanceof AppError ? err.message : `随任务授予节点失败: ${err instanceof Error ? err.message : String(err)}`
    return { ok: false, text: msg }
  }
}
