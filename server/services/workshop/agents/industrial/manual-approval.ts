/**
 * 手动确认模式(mode='manual')的审批样板 —— 参数面(param_control)/节点面(dcw_control)/
 * 回退面(dcw_rollback)共用的同源审批语义:
 *   ① 同 Agent 同节点挂起去重(防审批面板堆积);
 *   ② 挂起等待用户批准(超时按拒绝收敛,备注回给 Agent);
 *   ③ 批准后绑定二次校验(审批期间解绑 = 权限在批准时失效,指令不执行)。
 * (由 param-tools/dcw-tools/dcw-judge-tools 中三份同构内联块收敛而来)
 */
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getToolApprovals } from '../tool-approvals'

export async function requestManualApproval(args: {
  agentId: string
  nodeId: string
  /** 人读摘要(进入孪生审批面板与 HITL 待办) */
  detail: string
  /** 动作口径(决定三处文案的动词):缺省 '下发'(参数面/节点面);回退面传 '回退' */
  action?: '下发' | '回退'
}): Promise<{ ok: true, comment: string } | { ok: false, text: string, isError?: boolean }> {
  const action = args.action ?? '下发'
  const pendingText = action === '回退'
    ? '你对该节点已有一条待审批指令,请等待用户处理后再发新的回退请求(避免审批堆积)。'
    : '你对该执行节点已有一条待审批的下发指令,请等待用户处理后再发新指令(避免审批堆积)。'
  const resultPrefix = action === '回退' ? '回退未执行' : '指令未执行'
  const approvals = getToolApprovals()
  if (approvals.hasPendingFor(args.agentId, args.nodeId)) {
    return { ok: false, text: pendingText, isError: true }
  }
  const ap = await approvals.request(args.agentId, args.nodeId, 'dcw', args.detail)
  if (!ap.approved) {
    return {
      ok: false,
      text: `${resultPrefix}:用户${ap.comment.includes('超时') ? '未在时限内批准(超时)' : `拒绝了本次${action}`}。用户备注:${ap.comment || '(无)'}`,
    }
  }
  // 审批期间节点可能被解绑/删除(权限在批准时失效):二次校验
  if (!getAgentNodeBindingRepo().find(args.agentId, args.nodeId, 'dcw')) {
    return {
      ok: false,
      text: `${resultPrefix}:审批通过时你的该节点绑定已被解除(权限在批准时失效)。`,
      isError: true,
    }
  }
  // 批准附言随回执:人类可在批准时留反馈(缺省空),原样回流给 Agent
  return { ok: true, comment: ap.comment ?? '' }
}
