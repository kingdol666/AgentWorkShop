/**
 * PR17 M4-12 ProjectWatchdog + HealthBoard（plan S7/D17/§7.5）。
 *
 * 独立于项目循环：外部扫描 active 项目 —— 预算燃烧/连续无进展/重复决策；
 * 发现即写 ledger（trigger=watchdog）+ HealthBoard 降级 + 通知 effect
 * （dedupe 按「发现+小时桶」防风暴）；连续升级去重由 dedupe_key 保证。
 * 自身 dead-man：每次扫描写 watchdog 心跳；启动时 markAllStale 清理上次运行遗留。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ProjectKernelRepo } from '../db/project-kernel.repo'

export interface WatchdogOptions {
  nowMs?: () => number
  /** 无进展判定窗口（ms）：ledger 尾部时间早于 now-窗口 且有在飞工作项。 */
  noProgressMs?: number
  /** 重复决策窗口（ms）：同 decision_type 计数阈值。 */
  repeatedDecisionMs?: number
  repeatedDecisionThreshold?: number
}

export interface WatchdogFinding {
  type: 'budget_burn' | 'no_progress' | 'repeated_decision'
  detail: string
  evidence: Array<Record<string, unknown>>
}

const WI_INFLIGHT = `SELECT id, title, state, deadline_at AS deadlineAt, exec_budget_minutes AS execBudgetMinutes, trace_id AS traceId FROM project_work_items
  WHERE project_id = ? AND state IN ('DISPATCHED','RUNNING','DISPATCHING')`

const DECISION_COUNTS = `SELECT decision_type AS type, COUNT(*) AS n FROM project_decisions
  WHERE project_id = ? AND created_at >= ? GROUP BY decision_type HAVING n >= ?`

export function createProjectWatchdog(db: DatabaseSync, kernel: ProjectKernelRepo, options: WatchdogOptions = {}) {
  const nowMs = options.nowMs ?? (() => Date.now())
  const noProgressMs = options.noProgressMs ?? 30 * 60_000
  const repeatedDecisionMs = options.repeatedDecisionMs ?? 60 * 60_000
  const repeatedDecisionThreshold = options.repeatedDecisionThreshold ?? 3

  const iso = (ms: number) => new Date(ms).toISOString()
  const hourBucket = () => Math.floor(nowMs() / 3_600_000)

  const scanProject = (projectId: string, planVersion: number): WatchdogFinding[] => {
    const findings: WatchdogFinding[] = []
    const inflight = db.prepare(WI_INFLIGHT).all(projectId) as Array<{ id: string, title: string, state: string, deadlineAt: string | null, execBudgetMinutes?: number | null, traceId: string }>

    // 预算燃烧：在飞工作项已过 deadline（reconcile 会收敛为 OVERDUE/BLOCKED；
    // watchdog 在两 tick 之间仍可提前捕获并升级）。
    const overdue = inflight.filter(w => w.deadlineAt && Date.parse(w.deadlineAt) < nowMs())
    if (overdue.length > 0) {
      findings.push({
        type: 'budget_burn',
        detail: `${overdue.length} 个在飞工作项已超执行预算`,
        evidence: overdue.map(w => ({ workItemId: w.id, title: w.title, deadlineAt: w.deadlineAt })),
      })
    }

    // 连续无进展：有在飞但 ledger 长时间无新条目。
    // P1-6：固定 30min 阈值对长预算任务（60min 预算合法静默 >30min）必然误报——
    // 改为按工作项预算比例（0.75×budget，钳位 [10min, 6h]），取在飞项中最敏感阈值；
    // options.noProgressMs 显式提供时保持固定阈值（兼容既有测试与调用方）。
    if (inflight.length > 0) {
      const lastAt = kernel.ledger.lastAt(projectId)
      const lastMs = lastAt ? Date.parse(lastAt) : Number.NEGATIVE_INFINITY
      const quietMs = nowMs() - lastMs
      let thresholdMs = noProgressMs
      if (!options.noProgressMs) {
        const thresholds = inflight.map(w => Math.min(6 * 3_600_000, Math.max(10 * 60_000, 0.75 * (Number(w.execBudgetMinutes) || 60) * 60_000)))
        thresholdMs = thresholds.length > 0 ? Math.min(...thresholds) : noProgressMs
      }
      if (quietMs > thresholdMs) {
        findings.push({
          type: 'no_progress',
          detail: `在飞 ${inflight.length} 项但账本已 ${Math.round(quietMs / 60_000)} 分钟无进展（阈值 ${Math.round(thresholdMs / 60_000)} 分钟）`,
          evidence: [{ lastLedgerAt: lastAt, inflight: inflight.length, thresholdMs }],
        })
      }
    }

    // 重复决策：窗口内同类型决策数达到阈值（leader 循环/flapping 信号）。
    const repeated = db.prepare(DECISION_COUNTS).all(projectId, iso(nowMs() - repeatedDecisionMs), repeatedDecisionThreshold) as Array<{ type: string, n: number }>
    if (repeated.length > 0) {
      findings.push({
        type: 'repeated_decision',
        detail: repeated.map(r => `${r.type}×${r.n}`).join(', '),
        evidence: repeated.map(r => ({ decisionType: r.type, count: r.n })),
      })
    }

    for (const f of findings) {
      kernel.ledger.append({
        projectId,
        planVersion,
        stepNo: 0,
        triggerType: 'watchdog',
        summary: `watchdog:${f.type}`,
        facts: f.evidence,
        assessment: { stuck: true, finding: f.type, reason: f.detail },
        nextAction: '升级 owner 检查（人工决定暂停/重规划/继续）',
        evidence: f.evidence,
        traceId: `watchdog:${projectId}:${f.type}`,
      })
      kernel.effects.enqueue({
        projectId,
        dedupeKey: `watchdog:${f.type}:${hourBucket()}`,
        kind: 'notify',
        payload: { title: `项目看门狗告警:${f.type}`, finding: f.type, detail: f.detail, evidence: f.evidence },
        traceId: `watchdog:${projectId}:${f.type}`,
      })
    }
    if (findings.length > 0) {
      kernel.health.heartbeat(projectId, 'watchdog', false, findings.map(f => f.type).join(','))
    }
    return findings
  }

  return {
    scanProject,
    heartbeat: (projectId: string) => kernel.health.heartbeat(projectId, 'watchdog', true),
    /** dead-man：把上次进程遗留的健康行标记 stale（新进程接管前不再声称健康）。 */
    deadManSweep: (projectId: string) => kernel.health.markAllStale(projectId),
  }
}
