/**
 * ToolApprovals —— 手动确认模式的工具执行审批服务(进程内)。
 *
 * manual 模式绑定的数控下发:工具调用 → request() 挂起等待 →
 * 孪生侧栏审批面板 批准/拒绝(可附备注)→ 挂起 Promise 落定,
 * 结果(含用户备注)回给 Agent 作为 tool result。超时自动按拒绝收敛。
 */

import { randomUUID } from 'node:crypto'
import { getOps } from '../ops/ops'
import { securityHitlTimeoutMode, securityHitlTimeoutMs } from '../settings'
import { getHitlRegistry } from './hitl-registry'
import { sendHitlNote } from '../runtime/platform-notice'
import { notifyLineOperators } from '../runtime/line-notify'
import { getDcwController } from '../dcw/dcw-controller'
import { recordRecipeOpAnchor } from '../dcw/recipe-op-anchor'

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
    /** 自动拒绝 timer(reject 模式;hold 模式无 → 不自动拒,仅周期催办) */
    timer?: NodeJS.Timeout
    /** 未读升级提醒 timers(50%/85% TTL;decide/超时统一清理;hold 模式为周期催办) */
    remindTimers: NodeJS.Timeout[]
    /** 审批单归属产线(线域定向通知用;可空 = 推导不出) */
    lineId?: string
  }>()

  private history: ToolApproval[] = []

  /** 挂起一次执行审批(工具侧 await;批准/拒绝/超时三向落定)。
   *  opts.title 覆盖 HITL 待办标题(缺省 = 既有「XX 下发审批」,默认行为不变);
   *  opts.timeoutMs 覆盖本单超时窗(expiresAt 与 timer 两处同源取值;缺省 = 全局 hitl_timeout_ms);
   *  opts.payload 携带结构化审批载荷(随 pending/history 落库,前端渲染结构化审批卡)。
   *  不传 opts 的既有调用(param_control/manual-approval/recipe 门)行为不变。 */
  request(agentId: string, nodeId: string, kind: 'dcw' | 'daq', detail: string, opts?: { title?: string, timeoutMs?: number, payload?: unknown }): Promise<ToolApprovalDecision> {
    // hold 模式(手动生产语义):审批不自动拒、周期催办;显式传 timeoutMs 的调用方
    // (整包方案 30min)同样被 hold 覆盖 —— 真人在环时"等人"优先于"限时"。
    const hold = securityHitlTimeoutMode() === 'hold'
    const timeoutMs = hold ? 0 : (opts?.timeoutMs ?? TIMEOUT_MS())
    const approval: ToolApproval = {
      id: `ap-${randomUUID().slice(0, 8)}`,
      agentId,
      nodeId,
      kind,
      detail,
      ...(opts?.payload !== undefined ? { payload: opts.payload } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : '',
      status: 'pending',
      comment: '',
      choice: null,
      decidedAt: null,
      decidedBy: '',
      decidedName: '',
    }
    // 全局 HITL 待办登记(channelId/agentName 由插件注入的 resolver 补全;
    // expiresAt 与审批超时窗同源,前端可显示倒计时;hold 模式为空 = 等待中)
    getHitlRegistry().register({
      kind: 'dcw-approval',
      id: approval.id,
      agentId: approval.agentId,
      title: opts?.title ?? `${approval.kind.toUpperCase()} 下发审批`,
      detail: approval.detail,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt || null,
      nodeId: approval.nodeId,
    })
    // 出生即留痕:审批单落 approval_history(status=pending)。此前只在裁决/超时时落库,
    // 重启后遗留的 pending 单在历史里"查无此单"——对账把 HITL 面标 failed,历史面却无迹可查。
    this.remember(approval)
    // 线域定向触达(生产化 2026-10-08):按审批锚点推导产线,通知该线 operate 授权用户
    // (他们不一定在 Agent 频道里);eventId 与 hitl-registry 频道通知同键,(recipient,eventId)
    // 唯一键幂等去重,重叠接收人不重复打扰。
    const lineId = this.lineIdOf(nodeId)
    if (lineId) {
      notifyLineOperators(lineId, {
        eventId: `hitl_request:dcw-approval:${approval.id}`,
        title: opts?.title ?? `${approval.kind.toUpperCase()} 下发审批`,
        body: detail,
        hitlKind: 'dcw-approval',
        hitlId: approval.id,
        payload: { requestType: 'approval', harness: 'dcw', agentId, approvalId: approval.id, lineId },
      })
    }
    return new Promise((resolve) => {
      if (hold) {
        // hold:无自动拒绝 timer;每 5 分钟催办一次(线域定向 + 频道通告),直至人工裁决
        const escalated = new Set<number>()
        const REMIND_EVERY_MS = 5 * 60_000
        const remind = () => {
          if (!this.pending.has(approval.id)) return
          const tick = Math.floor((Date.now() - Date.parse(approval.createdAt)) / REMIND_EVERY_MS)
          if (tick > 0 && !escalated.has(tick)) {
            escalated.add(tick)
            const summary = `${approval.kind.toUpperCase()} 审批 ${approval.id}(${opts?.title ?? approval.nodeId})仍待人工裁决(hold 模式不自动拒绝)。请尽快在审批面板处置。`
            try {
              sendHitlNote({ agentId: approval.agentId, title: '⏰ 审批催办(hold 模式)', summary })
            }
            catch { /* 通知失败不影响审批主流程 */ }
            if (lineId) {
              notifyLineOperators(lineId, {
                eventId: `hitl_escalate:dcw-approval:${approval.id}:${tick}`,
                title: '⏰ 审批催办(hold 模式)',
                body: summary,
                hitlKind: 'dcw-approval',
                hitlId: approval.id,
              })
            }
          }
        }
        const remindTimer = setInterval(remind, REMIND_EVERY_MS)
        remindTimer.unref?.()
        this.pending.set(approval.id, { approval, resolve, remindTimers: [remindTimer], ...(lineId ? { lineId } : {}) })
        return
      }
      // 未读升级(2026-10-05 评审):此前超时=静默 approved:false —— 「人没看到→自动拒绝」。
      // 50%/85% TTL 各发一次升级提醒(复用 HITL 通知面);超时语义不软化,仍 fail-closed。
      const escalated = new Set<number>()
      const remindAt = (frac: number) => {
        const t = setTimeout(() => {
          if (!this.pending.has(approval.id) || escalated.has(frac)) return
          escalated.add(frac)
          const summary = `${approval.kind.toUpperCase()} 审批 ${approval.id}(${opts?.title ?? approval.nodeId})尚未裁决;${Math.round((1 - frac) * 100)}% 时限后默认拒绝(指令不执行)。请立即在频道提醒人工,或准备按拒绝口径修订方案。`
          try {
            sendHitlNote({
              agentId: approval.agentId,
              title: `⏰ 审批即将超时(${Math.round(frac * 100)}% 时限)—— 请向频道催办`,
              summary,
            })
          }
          catch { /* 通知失败不影响审批主流程 */ }
          if (lineId) {
            notifyLineOperators(lineId, {
              eventId: `hitl_escalate:dcw-approval:${approval.id}:${frac}`,
              title: `⏰ 审批即将超时(${Math.round(frac * 100)}% 时限)`,
              body: summary,
              hitlKind: 'dcw-approval',
              hitlId: approval.id,
            })
          }
        }, Math.round(timeoutMs * frac))
        t.unref?.()
        return t
      }
      const remindTimers = [remindAt(0.5), remindAt(0.85)]
      const timer = setTimeout(() => {
        remindTimers.forEach(clearTimeout)
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
      const prevEntry = this.pending.get(approval.id)
      if (prevEntry) {
        // 幂等重复 request:清掉旧提醒(原实现同样覆盖 timer)
        prevEntry.remindTimers?.forEach(clearTimeout)
      }
      this.pending.set(approval.id, { approval, resolve, timer, remindTimers, ...(lineId ? { lineId } : {}) })
    })
  }

  /** 审批锚点 → 产线 id(节点 id 直查;recipe:/recipe-propose: 前缀查配方产线) */
  private lineIdOf(nodeId: string): string {
    const m = /^(?:recipe|recipe-propose):(.+)$/.exec(nodeId)
    try {
      if (m) {
        const recipe = getDcwController().listRecipes().find(r => r.id === m[1])
        return recipe?.lineId ?? ''
      }
      return getDcwController().byId(nodeId)?.lineId ?? ''
    }
    catch {
      return ''
    }
  }

  /** 裁决一次挂起审批;choice = 多方案选定包下标(可选;仅结构化审批单语义化使用,落历史留痕) */
  decide(id: string, approved: boolean, comment: string, decidedBy = '', decidedName = '', choice?: number): ToolApproval {
    const entry = this.pending.get(id)
    if (!entry) throw new Error(`审批不存在或已处理: ${id}`)
    const choiceNorm = Number.isInteger(choice) ? (choice as number) : null
    clearTimeout(entry.timer)
    entry.remindTimers.forEach(clearTimeout)
    this.pending.delete(id)
    entry.approval.status = approved ? 'approved' : 'denied'
    entry.approval.comment = String(comment ?? '').trim()
    entry.approval.choice = choiceNorm
    entry.approval.decidedAt = new Date().toISOString()
    entry.approval.decidedBy = decidedBy
    entry.approval.decidedName = decidedName
    this.remember(entry.approval)
    // Recipe 下发频控锚:仅"已批准"的下发族审批落锚(审批=计时起点;未批准不计时)。
    // recipe_update 只写定义不触产线,排除;失败仅告警不反噬裁决主流程。
    if (approved) {
      try {
        const m = entry.approval.nodeId.match(/^(?:recipe|recipe-propose):(.+)$/)
        const payload = (entry.approval.payload ?? {}) as { op?: string, kind?: string }
        if (m && payload.op !== 'update') {
          const rawOp = String(payload.op)
          const op = (['trial', 'apply', 'rollback'].includes(rawOp) ? rawOp : rawOp === 'dispatch' ? 'apply' : 'propose') as 'trial' | 'apply' | 'rollback' | 'propose'
          recordRecipeOpAnchor({
            recipeId: m[1]!,
            at: Date.parse(entry.approval.decidedAt ?? '') || Date.now(),
            approvalId: id,
            agentId: entry.approval.agentId,
            op,
            source: 'hitl-approved',
          })
        }
      }
      catch (err) {
        console.warn('[tool-approvals] recipe 下发锚记录失败(不影响裁决):', err instanceof Error ? err.message : err)
      }
    }
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
      // 附言可能再也到不了 Agent(回合已死):平台通告补送,人机交互不因链路断裂丢话
      sendHitlNote({
        agentId,
        title: '审批失效',
        summary: `你在节点 ${entry.approval.nodeId} 的 ${entry.approval.kind.toUpperCase()} 审批(${id})因绑定解除被收敛为拒绝,指令未执行:${entry.approval.detail}`,
      })
      n++
    }
    return n
  }

  /**
   * 回合终止时收敛该 Agent 的全部挂起审批(运行时 stop / 成员移除前置):
   * 按「拒绝(回合已中止,指令未执行)」落定,绝不自动批准;返回收敛摘要供
   * 平台通告补送——等待工具结果的回合已死,人类稍后的决议必须换一条路送达。
   */
  cancelAllForAgent(agentId: string, reason: string): string[] {
    const notes: string[] = []
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.approval.agentId !== agentId) continue
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.approval.status = 'denied'
      entry.approval.comment = reason
      entry.approval.decidedAt = new Date().toISOString()
      this.remember(entry.approval)
      getHitlRegistry().resolve('dcw-approval', id, 'cancelled')
      entry.resolve({ approved: false, comment: reason, id })
      notes.push(`${entry.approval.kind.toUpperCase()} 审批 ${id}(${entry.approval.detail})已按拒绝收敛,指令未执行`)
    }
    return notes
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
  // 结构化单的签名 = schemaVersion=1 **且带 packages 方案集**:fail-closed 只该管
  // 多方案整包审批。其余带 payload 的审批单(如 recipe-gate 逐动作单:v2 配方
  // 参数写入/下发/试验/回退,单动作无 choice 语义)不得被本归一拦截 ——
  // 否则「批准」会被无 choice fail-closed 静默转拒绝(实测:e3d9aef 后 E2E M9-M11)。
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.packages)) {
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
