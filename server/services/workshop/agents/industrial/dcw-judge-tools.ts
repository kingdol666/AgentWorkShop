/**
 * 判定与回滚(dcw_judge / dcw_rollback / dcw_journal)与绑定鉴权
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentNodeBinding } from '../node-bindings.repo'
import { agentBadgeLabel } from '../agent-badge'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getRecipeRollBackManager } from '../../dcw/recipe-rollback-manager'
import { getToolApprovals } from '../tool-approvals'

/**
 * 写向工具的统一鉴权闸门(绑定必查)。
 *
 * 背景:dcw_control / dcw_read 各自抄了一份 `repo.find(agentId, nodeId, 'dcw')` 判定,
 * 而 dcw_rollback / dcw_judge 的「接管孤儿记录」分支忘了这一步 —— 任何 agent(哪怕
 * 零绑定)都能借 record_id 或超时接管,驱动真实 PLC 执行回退。这是权限模型里的
 * **默认放行**,与 node-bindings.repo 自述的「未绑定节点一律拒绝」直接冲突。
 * 收敛为单一入口后,新增写向工具不会再漏。
 *
 * @returns 命中返回绑定对象;未命中返回可直接回给模型的拒绝文本(isError)
 */
export function requireDcwBinding(agentId: string, nodeId: string, action: string): { binding: AgentNodeBinding } | { error: { text: string, isError: true } } {
  const repo = getAgentNodeBindingRepo()
  const binding = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
  if (binding) return { binding }
  const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
  return {
    error: {
      text: mine.length
        ? `无权${action}节点 ${nodeId || '(空)'}。你有权控制的数控节点:${mine.map(b => b.nodeId).join(', ')}(可用 my_industrial_nodes 查看物理含义)。`
        : `你尚未绑定任何数控节点,无权${action}。请在数字孪生界面绑定数控节点。`,
      isError: true,
    },
  }
}

/** 工具:dcw_judge —— 对自己的优化记录落判定(keep/rollback/uncertain)。
 *  判定与执行分离:rollback 判定只入册,执行必须再调 dcw_rollback。
 *  鉴权:记录所属节点必须仍在你的 dcw 绑定内 —— 接管孤儿记录同样受此约束。 */
export async function toolDcwJudge(agentId: string, args: { record_id?: string, verdict?: string, reason?: string }): Promise<{ text: string, isError?: boolean }> {
  const recordId = String(args.record_id ?? '').trim()
  const verdict = String(args.verdict ?? '').trim() as 'keep' | 'rollback' | 'uncertain'
  const reason = String(args.reason ?? '').trim()
  if (!recordId)
    return { text: 'record_id 必填(优化记录 id,dcw_control 下发成功后会返回)。', isError: true }
  if (!['keep', 'rollback', 'uncertain'].includes(verdict))
    return { text: 'verdict 必须为 keep / rollback / uncertain。', isError: true }
  if (!reason)
    return { text: 'reason 必填:判定必须引用数采证据(建议先 daq_query 取窗口数据再判定)。', isError: true }
  const rb = getRecipeRollBackManager()
  const record = rb.recordById(recordId)
  if (!record)
    return { text: `优化记录 ${recordId} 不存在。`, isError: true }
  const takeover = record.agentId !== agentId && rb.isStale(record)
  if (record.agentId !== agentId && !takeover)
    return { text: `记录 ${recordId} 不是你发起的优化(发起者:${record.agentId ?? '用户'}),Agent 仅可判定自己的记录;他人记录请请用户在界面判定。`, isError: true }
  // 接管是「时间」判定,不是「权限」判定 —— 权限必须单独查绑定(早先漏了这一步)
  const auth = requireDcwBinding(agentId, record.nodeId, '判定该记录')
  if ('error' in auth) return auth.error
  try {
    const finalReason = takeover ? `[接管孤儿记录,原属主 ${record.agentId ?? '?'} 超时未判定] ${reason}` : reason
    const updated = rb.judge(recordId, verdict, finalReason, 'agent', agentId, { takeover, actorName: agentBadgeLabel(agentId) })
    const next = verdict === 'rollback'
      ? '判定已入册;请立即用 dcw_rollback(record_id) 执行回退(判定不自动改 PLC)。'
      : verdict === 'keep'
        ? `已定档为已验证经验${updated.recipeId ? '(配方已标记 lastGood)' : ''}。`
        : '记录保持 open,继续观察或等下次设定关闭。'
    return { text: `判定已入册:记录 ${recordId} → ${verdict}(${reason})。${next}` }
  }
  catch (err) {
    return { text: `判定失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:dcw_rollback —— 执行回退(自己的记录直接执行;他人记录需用户在界面执行)。
 *  鉴权:节点必须绑定给该 agent(record_id 路径先解析出 record.nodeId);
 *  manual 模式绑定与 dcw_control 同源 —— 回退也会改 PLC,必须推请用户确认。
 *  args: record_id(回退该记录到其 from 值)或 node_id(单步撤销到最近稳定锚);to = 指定目标锚。 */
export async function toolDcwRollback(agentId: string, args: { record_id?: string, node_id?: string, to?: string }): Promise<{ text: string, isError?: boolean }> {
  const rb = getRecipeRollBackManager()
  const recordId = String(args.record_id ?? '').trim()
  const nodeId = String(args.node_id ?? '').trim()
  const to = String(args.to ?? '').trim() || undefined
  if (!recordId && !nodeId)
    return { text: 'record_id 或 node_id 至少提供一个。', isError: true }
  try {
    // 归属解析:record_id 路径的节点来自记录本身,node_id 路径直接用入参
    const record = recordId ? rb.recordById(recordId) : undefined
    if (recordId && !record)
      return { text: `优化记录 ${recordId} 不存在。`, isError: true }
    const targetNodeId = record?.nodeId ?? nodeId
    if (record) {
      const takeover = record.agentId !== agentId && rb.isStale(record)
      if (record.agentId !== agentId && !takeover)
        return { text: `记录 ${recordId} 不是你发起的优化(发起者:${record.agentId ?? '用户'}),回退他人记录请请用户在数采中心/产线详情执行;若原属主已消失(超时未判定),可先 dcw_judge 接管后再回退。`, isError: true }
    }
    // 授权闸门(早先整段缺失 → 任意 agent 可回退任意节点)
    const auth = requireDcwBinding(agentId, targetNodeId, '回退')
    if ('error' in auth) return auth.error
    // manual 模式:回退是真实 PLC 写入,与 dcw_control 同源推请用户批准
    if (auth.binding.mode === 'manual') {
      const node = getDcwController().byId(targetNodeId)
      const approvals = getToolApprovals()
      if (approvals.hasPendingFor(agentId, targetNodeId))
        return { text: '你对该节点已有一条待审批指令,请等待用户处理后再发新的回退请求(避免审批堆积)。', isError: true }
      const detail = `${node?.name ?? targetNodeId} 回退到${record ? `记录 ${recordId} 的 from 值` : '最近稳定锚'}${to ? `(${to})` : ''}`
      const ap = await approvals.request(agentId, targetNodeId, 'dcw', detail)
      if (!ap.approved) {
        return { text: `回退未执行:用户${ap.comment.includes('超时') ? '未在时限内批准(超时)' : '拒绝了本次回退'}。用户备注:${ap.comment || '(无)'}` }
      }
      // 审批期间绑定可能已被解除:批准时二次校验(与 dcw_control 同口径)
      if (!getAgentNodeBindingRepo().find(agentId, targetNodeId, 'dcw'))
        return { text: '回退未执行:审批通过时你的该节点绑定已被解除(权限在批准时失效)。', isError: true }
    }
    if (record) {
      const fresh = await rb.rollbackRecord(recordId, agentId, 'agent', undefined, { actorName: agentBadgeLabel(agentId) })
      return { text: `回退已执行:记录 ${recordId} 标记 rolled-back;下发恢复值 ${fresh?.params[0]?.to}${'(以回读为准)'};新回退记录 ${fresh?.id} 已入册。请 daq_query 复测确认恢复。` }
    }
    const fresh = await rb.rollbackNode(targetNodeId, agentId, 'agent', to, { actorName: agentBadgeLabel(agentId) })
    return { text: `节点单步回退已执行:恢复到最近稳定锚值;新回退记录 ${fresh?.id} 已入册。请 daq_query 复测确认恢复。` }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { text: `回退被拒绝:${msg}(回退经与下发相同的安全门控;冷却期内禁止重复回退)`, isError: true }
  }
}

/** 工具:dcw_journal —— 参数变更史/优化记录查询(在册审计;谁/何时/从多少到多少/判定) */
export async function toolDcwJournal(agentId: string, args: { node_id?: string, recipe_id?: string, limit?: number | string }): Promise<{ text: string, isError?: boolean }> {
  const rb = getRecipeRollBackManager()
  const nodeId = String(args.node_id ?? '').trim()
  const recipeId = String(args.recipe_id ?? '').trim()
  const limit = Math.min(Number(args.limit) || 20, 100)
  const repo = getAgentNodeBindingRepo()
  const bound = new Set(repo.byAgent(agentId).map(b => b.nodeId))
  if (nodeId && !bound.has(nodeId))
    return { text: `无权查询节点 ${nodeId} 的账本(仅可查自己绑定的节点)。`, isError: true }
  const records = rb.records({ nodeId: nodeId || undefined, recipeId: recipeId || undefined, limit })
  if (records.length === 0)
    return { text: '窗口内无优化记录(该节点/配方尚无 Agent 调控历史)。' }
  const lines = records.map((r) => {
    const p = r.params[0]
    const judge = r.judge ? `${r.judge.verdict}(${r.judge.by}:${r.judge.reason.slice(0, 50)})` : '未判定'
    const closed = r.closedAt ? `,关闭于 ${r.closedAt.slice(11, 19)}(${r.closedBy})` : ',进行中'
    return `- ${r.id} [${r.status}] ${r.nodeName}: ${p?.from ?? '?'} → ${p?.to},设定 ${r.setAt.slice(11, 19)},判定 ${judge}${closed}${r.hypothesis ? `\n  假设: ${r.hypothesis.slice(0, 80)}` : ''}`
  })
  const anchors = nodeId ? rb.journal({ nodeId, limit }) : []
  const anchorLines = anchors.slice(0, 10).map(a => `- ${a.at.slice(11, 19)} [${a.source}/${a.actor}] ${a.prevValue ?? '?'} → ${a.newValue}`)
  return {
    text: `优化记录(${records.length} 条,含参数/判定/窗口):\n${lines.join('\n')}${nodeId ? `\n\n参数变更锚(最近 ${anchorLines.length} 条):\n${anchorLines.join('\n')}` : ''}\n\n判定与执行分离:rollback 判定后需 dcw_rollback 执行;回退同样入册可审计。`,
  }
}
