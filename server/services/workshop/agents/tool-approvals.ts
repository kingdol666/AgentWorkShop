/**
 * ToolApprovals —— 手动确认模式的工具执行审批服务(进程内)。
 *
 * manual 模式绑定的数控下发:工具调用 → request() 挂起等待 →
 * 孪生侧栏审批面板 批准/拒绝(可附备注)→ 挂起 Promise 落定,
 * 结果(含用户备注)回给 Agent 作为 tool result。超时自动按拒绝收敛。
 */

import { randomUUID } from 'node:crypto'

export interface ToolApproval {
  id: string
  agentId: string
  nodeId: string
  kind: 'dcw' | 'daq'
  /** 人读摘要(节点名/物理量/目标值/窗口) */
  detail: string
  createdAt: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  comment: string
  decidedAt: string | null
}

const TIMEOUT_MS = 180_000
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
      status: 'pending',
      comment: '',
      decidedAt: null,
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(approval.id)) return
        this.pending.delete(approval.id)
        approval.status = 'expired'
        approval.comment = '审批超时未处理,指令未执行'
        this.remember(approval)
        resolve({ approved: false, comment: approval.comment, id: approval.id })
      }, TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(approval.id, { approval, resolve, timer })
    })
  }

  decide(id: string, approved: boolean, comment: string): ToolApproval {
    const entry = this.pending.get(id)
    if (!entry) throw new Error(`审批不存在或已处理: ${id}`)
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.approval.status = approved ? 'approved' : 'denied'
    entry.approval.comment = String(comment ?? '').trim()
    entry.approval.decidedAt = new Date().toISOString()
    this.remember(entry.approval)
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
    return this.history
  }

  private remember(a: ToolApproval): void {
    this.history.unshift(a)
    if (this.history.length > HISTORY_CAP) this.history.splice(HISTORY_CAP)
  }
}

const g = globalThis as typeof globalThis & { __toolApprovals?: ToolApprovalService }

export function getToolApprovals(): ToolApprovalService {
  g.__toolApprovals ??= new ToolApprovalService()
  return g.__toolApprovals
}
