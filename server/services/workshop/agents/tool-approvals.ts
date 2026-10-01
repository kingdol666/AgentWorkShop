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
  /** 结构化审批载荷(可选;整包方案审批 recipe-propose 存方案集+预检结果,前端渲染结构化审批卡) */
  payload?: unknown
  createdAt: string
  /** 到期时刻(createdAt + 超时窗);UI 据此显示自动拒绝倒计时 */
  expiresAt: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  comment: string
  /** 多方案裁决序号(批准时人类选定的包下标;仅 recipe-propose 结构化审批单使用) */
  choice: number | null
  decidedAt: string | null
  /** S4:裁决人留痕(空 = 超时/系统收敛) */
  decidedBy: string
  decidedName: string
}

/** 审批超时窗(超时默认拒绝,指令不执行);security.hitl_timeout_ms(env HITL_TIMEOUT_MS 兼容) */
const TIMEOUT_MS = (): number => securityHitlTimeoutMs()
const HISTORY_CAP = 50

/** resolve 数据通道:approved/comment/id + 多方案裁决序号 choice(可选,仅结构化审批单携带) */
export interface ToolApprovalDecision {
  approved: boolean
  comment: string
  id: string
  choice?: number
}

class ToolApprovalService {
  private pending = new Map<string, {
    approval: ToolApproval
    resolve: (r: ToolApprovalDecision) => void
    timer: NodeJS.Timeout
  }>()

  private history: ToolApproval[] = []

  /** 挂起一次执行审批(工具侧 await;批准/拒绝/超时三向落定)。
   *  opts.title 覆盖 HITL 待办标题(缺省 = 既有「XX 下发审批」,默认行为不变);
   *  opts.timeoutMs 覆盖本单超时窗(expiresAt 与 timer 两处同源取值;缺省 = 全局 hitl_timeout_ms);
   *  opts.payload 携带结构化审批载荷(随 pending/history 落库,前端渲染结构化审批卡)。
   *  不传 opts 的既有调用(param_control/manual-approval/recipe 门)行为不变。 */
  request(agentId: string, nodeId: string, kind: 'dcw' | 'daq', detail: string, opts?: { title?: string, timeoutMs?: number, payload?: unknown }): Promise<ToolApprovalDecision> {
    const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS()
    const approval: ToolApproval = {
      id: `ap-${randomUUID().slice(0, 8)}`,
      agentId,
      nodeId,
      kind,
      detail,
      ...(opts?.payload !== undefined ? { payload: opts.payload } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      status: 'pending',
      comment: '',
      choice: null,
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
      title: opts?.title ?? `${approval.kind.toUpperCase()} 下发审批`,
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
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(approval.id, { approval, resolve, timer })
    })
  }

  /** 裁决一次挂起审批;choice = 多方案选定包下标(可选;仅结构化审批单语义化使用,落历史留痕) */
  decide(id: string, approved: boolean, comment: string, decidedBy = '', decidedName = '', choice?: number): ToolApproval {
    const entry = this.pending.get(id)
    if (!entry) throw new Error(`审批不存在或已处理: ${id}`)
    const choiceNorm = Number.isInteger(choice) ? (choice as number) : null
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.approval.status = approved ? 'approved' : 'denied'
    entry.approval.comment = String(comment ?? '').trim()
    entry.approval.choice = choiceNorm
    entry.approval.decidedAt = new Date().toISOString()
    entry.approval.decidedBy = decidedBy
    entry.approval.decidedName = decidedName
    this.remember(entry.approval)
    getHitlRegistry().resolve('dcw-approval', id, 'answered', decidedBy || undefined)
    entry.resolve({ approved, comment: entry.approval.comment, id, ...(choiceNorm != null ? { choice: choiceNorm } : {}) })
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
        // 结构化审批载荷(payload_json 列;空串/坏 JSON → undefined,前端走 detail 文本降级)
        ...(parsePayloadJson(r.payloadJson)),
        status: r.status as ToolApproval['status'],
        comment: r.comment,
        choice: typeof r.choice === 'number' ? r.choice : null,
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
    // S4:同步持久化(失败不影响审批主流程——工具侧已拿到裁决结果);
    // payload_json/choice 随行落库(整包方案审批后可追溯参数表与选定包)
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
        payloadJson: a.payload !== undefined ? JSON.stringify(a.payload) : '',
        choice: a.choice,
      })
    }
    catch {
      // 持久化失败降级为仅内存历史
    }
  }
}

/** payload_json 列 → payload 字段(空串/解析失败 → 不携带,展示层走 detail 文本降级) */
function parsePayloadJson(raw: string): { payload?: unknown } {
  if (!raw) return {}
  try {
    return { payload: JSON.parse(raw) }
  }
  catch {
    return {}
  }
}

// ================================================================
// fail-closed 决策归一(产线 Co-Pilot P2 铁律 5:多方案审批未携带 choice 的
// 「批准」一律按拒绝收敛)
// ================================================================

/** 归一结果:approved 可能被降级为 false;rejectedReason 非空即发生了 fail-closed 收敛 */
export interface NormalizedRecipeProposeDecision {
  approved: boolean
  choice?: number
  rejectedReason?: string
}

/**
 * 整包方案(recipe-propose)裁决归一:
 *  - 仅当 pending.payload?.schemaVersion === 1(结构化审批单)时生效;
 *  - schemaVersion 不存在(legacy 审批单)完全不干预 —— 既有 dcw/daq 审批行为逐字节不变;
 *  - approved=true 且 choice 不是 0..packages.length-1 的整数 → 归一为 approved=false
 *    (审批历史与工具回执都按拒绝计:不给默认包、不取第一个包兜底);
 *  - approved=false 时 choice 无语义,原样透传。
 */
export function normalizeRecipeProposeDecision(
  pending: Pick<ToolApproval, 'payload'> | null | undefined,
  decision: { approved: boolean, choice?: number },
): NormalizedRecipeProposeDecision {
  const payload = pending?.payload as { schemaVersion?: unknown, packages?: unknown } | undefined
  if (!payload || payload.schemaVersion !== 1) {
    return { approved: decision.approved, ...(decision.choice !== undefined ? { choice: decision.choice } : {}) }
  }
  if (decision.approved !== true) return { approved: false }
  const packageCount = Array.isArray(payload.packages) ? payload.packages.length : 0
  const choice = decision.choice
  if (Number.isInteger(choice) && (choice as number) >= 0 && (choice as number) < packageCount) {
    return { approved: true, choice }
  }
  return {
    approved: false,
    rejectedReason: packageCount > 0
      ? `未携带有效方案序号 choice(需为 0~${packageCount - 1} 的整数),多方案批准按拒绝收敛(fail-closed)`
      : '审批单无可选方案集,批准按拒绝收敛(fail-closed)',
  }
}

const g = globalThis as typeof globalThis & { __toolApprovals?: ToolApprovalService }

export function getToolApprovals(): ToolApprovalService {
  g.__toolApprovals ??= new ToolApprovalService()
  return g.__toolApprovals
}
