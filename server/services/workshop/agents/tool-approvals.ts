/**
 * ToolApprovals —— 手动确认模式的工具执行审批服务(进程内)。
 *
 * manual 模式绑定的数控下发:工具调用 → request() 挂起等待 →
 * 孪生侧栏审批面板 批准/拒绝(可附备注)→ 挂起 Promise 落定,
 * 结果(含用户备注)回给 Agent 作为 tool result。超时自动按拒绝收敛。
 */

import { randomUUID } from 'node:crypto'
import { getOps } from '../ops/ops'
import { securityHitlTimeoutMs } from '../settings'
import { getHitlRegistry } from './hitl-registry'

export interface ToolApproval {
  id: string
  agentId: string
  nodeId: string
  kind: 'dcw' | 'daq'
  /** 人读摘要(节点名/物理量/目标值/窗口) */
  detail: string
  createdAt: string
  /** 到期时刻(createdAt + 超时窗);UI 据此显示自动拒绝倒计时 */
  expiresAt: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  comment: string
  decidedAt: string | null
  /** S4:裁决人留痕(空 = 超时/系统收敛) */
  decidedBy: string
  decidedName: string
}

/** 审批超时窗(超时默认拒绝,指令不执行);security.hitl_timeout_ms(env HITL_TIMEOUT_MS 兼容) */
const TIMEOUT_MS = (): number => securityHitlTimeoutMs()
const HISTORY_CAP = 50

class ToolApprovalService {
  private pending = new Map<string, {
    approval: ToolApproval
    resolve: (r: { approved: boolean, comment: string, id: string }) => void
    timer: NodeJS.Timeout
  }>()

  private history: ToolApproval[] = []

  /** 挂起一次执行审批(工具侧 await;批准/拒绝/超时三向落定) */
  request(agentId: string, nodeId: string, kind: 'dcw' | 'daq', detail: string): Promise<{ approved: boolean, comment: string, id: string }> {
    const approval: ToolApproval = {
      id: `ap-${randomUUID().slice(0, 8)}`,
      agentId,
      nodeId,
      kind,
      detail,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TIMEOUT_MS()).toISOString(),
      status: 'pending',
      comment: '',
      decidedAt: null,
      decidedBy: '',
      decidedName: '',
    }
    // 全局 HITL 待办登记(channelId/agentName 由插件注入的 resolver 补全;
    // expiresAt 与审批超时窗同源,前端可显示倒计时)
    getHitlRegistry().register({
      kind: 'dcw-approval',
      id: approval.id,
      agentId: approval.agentId,
      title: `${approval.kind.toUpperCase()} 下发审批`,
      detail: approval.detail,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(approval.id)) return
        this.pending.delete(approval.id)
        approval.status = 'expired'
        approval.decidedAt = new Date().toISOString()
        approval.comment = '审批超时未处理,默认拒绝,指令未执行'
        this.remember(approval)
        getHitlRegistry().resolve('dcw-approval', approval.id, 'expired')
        resolve({ approved: false, comment: approval.comment, id: approval.id })
      }, TIMEOUT_MS())
      timer.unref?.()
      this.pending.set(approval.id, { approval, resolve, timer })
    })
  }

  decide(id: string, approved: boolean, comment: string, decidedBy = '', decidedName = ''): ToolApproval {
    const entry = this.pending.get(id)
    if (!entry) throw new Error(`审批不存在或已处理: ${id}`)
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.approval.status = approved ? 'approved' : 'denied'
    entry.approval.comment = String(comment ?? '').trim()
    entry.approval.decidedAt = new Date().toISOString()
    entry.approval.decidedBy = decidedBy
    entry.approval.decidedName = decidedName
    this.remember(entry.approval)
    getHitlRegistry().resolve('dcw-approval', id, 'answered', decidedBy || undefined)
    entry.resolve({ approved, comment: entry.approval.comment, id })
    return entry.approval
  }

  /** 审批面板拉取(指定 Agent 的待处理;agentId 空 = 全部) */
  listPending(agentId = ''): ToolApproval[] {
    return [...this.pending.values()]
      .map(e => e.approval)
      .filter(a => !agentId || a.agentId === agentId)
  }

  /** 解绑/换线时取消挂起审批:该 Agent 对某节点的全部 pending 按拒绝收敛(备注说明原因) */
  cancelPendingFor(agentId: string, nodeId: string): number {
    let n = 0
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.approval.agentId !== agentId || entry.approval.nodeId !== nodeId) continue
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.approval.status = 'denied'
      entry.approval.comment = '绑定已解除,审批失效'
      entry.approval.decidedAt = new Date().toISOString()
      this.remember(entry.approval)
      getHitlRegistry().resolve('dcw-approval', id, 'cancelled')
      entry.resolve({ approved: false, comment: entry.approval.comment, id })
      n++
    }
    return n
  }

  /** 同一 Agent 同一节点的挂起审批去重:已有 pending 时拒绝新挂起(防审批面板堆积) */
  hasPendingFor(agentId: string, nodeId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.approval.agentId === agentId && entry.approval.nodeId === nodeId) return true
    }
    return false
  }

  historyList(): ToolApproval[] {
    // S4:优先读持久化表(重启后仍可查);未接线(测试/降级)回退内存窗口
    const repo = getOps()?.approvalHistory
    if (repo) {
      return repo.list(HISTORY_CAP * 4).map(r => ({
        id: r.id,
        agentId: r.agentId,
        nodeId: r.nodeId,
        kind: r.kind as ToolApproval['kind'],
        detail: r.detail,
        status: r.status as ToolApproval['status'],
        comment: r.comment,
        decidedAt: r.decidedAt,
        decidedBy: r.decidedBy,
        decidedName: r.decidedName,
        createdAt: r.createdAt,
        // 持久化表未存到期时刻:按超时窗从 createdAt 派生(仅展示用)
        expiresAt: new Date(Date.parse(r.createdAt) + TIMEOUT_MS()).toISOString(),
      }))
    }
    return this.history
  }

  private remember(a: ToolApproval): void {
    this.history.unshift(a)
    if (this.history.length > HISTORY_CAP) this.history.splice(HISTORY_CAP)
    // S4:同步持久化(失败不影响审批主流程——工具侧已拿到裁决结果)
    try {
      getOps()?.approvalHistory.upsert({
        id: a.id,
        agentId: a.agentId,
        nodeId: a.nodeId,
        kind: a.kind,
        detail: a.detail,
        status: a.status,
        comment: a.comment,
        decidedBy: a.decidedBy,
        decidedName: a.decidedName,
        createdAt: a.createdAt,
        decidedAt: a.decidedAt,
      })
    }
    catch {
      // 持久化失败降级为仅内存历史
    }
  }
}

const g = globalThis as typeof globalThis & { __toolApprovals?: ToolApprovalService }

export function getToolApprovals(): ToolApprovalService {
  g.__toolApprovals ??= new ToolApprovalService()
  return g.__toolApprovals
}
