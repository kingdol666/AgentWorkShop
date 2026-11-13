/**
 * Goal 完成门的独立证据判定（Channel 任务）。
 *
 * 背景（2026-11-13 实机）：injection 闭环任务 PV=31.35g（目标 32.5±0.35）、
 * 缩痕 2.003>1.5，但 Lead 直接 complete_task，任务被置 COMPLETED —— 完成门只看
 * Agent 自述，没有独立数据面复核。本模块把「任务书里的目标带」解析成机器判据，
 * 要求 complete_task 携带目标 DAQ 节点，并用 **DAQ 控制器实时读数**（非 Agent 传值）
 * 复算；无目标带的任务不受影响。
 *
 * 纯函数：不读 DB / 网络，便于单测；运行时探针在 goal-completion-runtime.ts。
 */

export interface GoalTargetBand {
  target: number
  tol: number
  raw: string
}

export interface GoalCompletionGuard {
  nodeId: string
  min?: number
  max?: number
}

export interface GoalCompletionVerification {
  nodeId: string
  guards: GoalCompletionGuard[]
}

export interface LatestGoalReading {
  value: number | null
  atMs: number | null
  quality?: string | null
}

export interface GoalCompletionInput {
  title: string
  description: string
  /** complete_task 的 verification 参数（对象或 JSON 字符串） */
  verification: unknown
  readLatest: (nodeId: string) => LatestGoalReading | null
  /** 调用者与任务接收者可见的 DAQ 节点（绑定面并集） */
  allowedNodeIds: Set<string>
  nowMs?: number
  /** 读数最大年龄（默认 60s；工业闭环复测通常 ≤ 数秒） */
  freshnessMs?: number
}

export interface GoalCompletionEvidence {
  nodeId: string
  measured: number
  atMs: number
  target: number
  tol: number
  guards: Array<{ nodeId: string, measured: number, min?: number, max?: number }>
}

export type GoalCompletionResult
  = | { ok: true, skipped: true }
    | { ok: true, skipped: false, evidence: GoalCompletionEvidence }
    | { ok: false, reason: string }

export interface GoalCompletionTaskLike {
  title?: string
  description?: string
  assigneeId?: string
  /** 子任务接收者：Lead 收口父任务时，写操作可能发生在其 worker 子任务上 */
  relatedAssigneeIds?: string[]
}

export type GoalCompletionVerifier = (
  task: GoalCompletionTaskLike,
  args: Record<string, unknown>,
) => GoalCompletionResult

const TARGET_BAND_RE = /(-?\d+(?:\.\d+)?)\s*(?:±|\+\/-|\+-)\s*(\d+(?:\.\d+)?)/

/** 从任务标题/描述解析 `目标±容差`；无此形态 → null（不启用完成门）。 */
export function parseTargetBand(text: string): GoalTargetBand | null {
  const m = text.match(TARGET_BAND_RE)
  if (!m) return null
  const target = Number(m[1])
  const tol = Number(m[2])
  if (!Number.isFinite(target) || !Number.isFinite(tol) || tol <= 0) return null
  return { target, tol, raw: m[0] }
}

function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function normalizeVerification(raw: unknown): GoalCompletionVerification | null {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    }
    catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const nodeId = String(obj.node_id ?? obj.nodeId ?? '').trim()
  if (!nodeId) return null
  const guardsRaw = Array.isArray(obj.guards) ? obj.guards : []
  const guards: GoalCompletionGuard[] = []
  for (const g of guardsRaw) {
    if (typeof g !== 'object' || g === null) return null
    const row = g as Record<string, unknown>
    const guardNode = String(row.node_id ?? row.nodeId ?? '').trim()
    if (!guardNode) return null
    const min = asFiniteNumber(row.min)
    const max = asFiniteNumber(row.max)
    if (min === undefined && max === undefined) return null
    guards.push({ nodeId: guardNode, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) })
  }
  return { nodeId, guards }
}

function readReading(
  nodeId: string,
  input: GoalCompletionInput,
  nowMs: number,
  freshnessMs: number,
): { ok: true, value: number, atMs: number } | { ok: false, reason: string } {
  if (!input.allowedNodeIds.has(nodeId)) {
    return { ok: false, reason: `节点 ${nodeId} 不在你的 DAQ 授权绑定面内；请用 my_industrial_nodes 确认可用节点` }
  }
  const reading = input.readLatest(nodeId)
  if (!reading || reading.value === null || !Number.isFinite(reading.value)) {
    return { ok: false, reason: `节点 ${nodeId} 无独立实时读数（未采样/未绑定/控制器不可用），不能证明已达标` }
  }
  if (reading.atMs === null || !Number.isFinite(reading.atMs)) {
    return { ok: false, reason: `节点 ${nodeId} 的独立读数缺少时间戳，无法判断新鲜度` }
  }
  const age = nowMs - reading.atMs
  if (age < -5_000) {
    return { ok: false, reason: `节点 ${nodeId} 的独立读数时间在未来（时钟异常），按未证实处理` }
  }
  if (age > freshnessMs) {
    return { ok: false, reason: `节点 ${nodeId} 的独立读数已过期（${Math.round(age / 1000)}s > ${Math.round(freshnessMs / 1000)}s），请先复测` }
  }
  if (reading.quality != null && reading.quality !== 'good') {
    return { ok: false, reason: `节点 ${nodeId} 的独立读数质量为 ${reading.quality}（需 good），按未证实处理` }
  }
  return { ok: true, value: reading.value, atMs: reading.atMs }
}

/**
 * 判定 complete_task 是否具备独立完成证据。
 * - 任务书无 `目标±容差`：跳过（不影响纯分析/无量化目标的任务）；
 * - 有目标带但缺 verification：拒绝；
 * - 目标节点不在授权面 / 读数缺失 / 过期 / quality≠good / 越带：拒绝；
 * - guards 若提供，逐条按同一口径复核（只收紧，不放松）。
 */
export function evaluateGoalCompletion(input: GoalCompletionInput): GoalCompletionResult {
  const band = parseTargetBand(`${input.title}\n${input.description}`)
  if (!band) return { ok: true, skipped: true }
  const verification = normalizeVerification(input.verification)
  if (!verification) {
    return {
      ok: false,
      reason: `任务书目标为 ${band.raw}：complete_task 必须携带 verification={node_id:<目标 DAQ 节点>, guards:[{node_id,min?,max?}]}，由平台用独立读数复算`,
    }
  }
  const nowMs = input.nowMs ?? Date.now()
  const freshnessMs = input.freshnessMs ?? 60_000
  const target = readReading(verification.nodeId, input, nowMs, freshnessMs)
  if (!target.ok) return target
  if (Math.abs(target.value - band.target) > band.tol) {
    return {
      ok: false,
      reason: `目标未达成：${verification.nodeId} 独立读数 ${target.value}，目标 ${band.target}±${band.tol}（带 ${band.target - band.tol}~${band.target + band.tol}）；请继续调整并复测，或如实报告未达成`,
    }
  }
  const guardEvidence: GoalCompletionEvidence['guards'] = []
  for (const g of verification.guards) {
    const reading = readReading(g.nodeId, input, nowMs, freshnessMs)
    if (!reading.ok) return reading
    if (g.min !== undefined && reading.value < g.min) {
      return { ok: false, reason: `守卫未满足：${g.nodeId} 独立读数 ${reading.value} < 下限 ${g.min}` }
    }
    if (g.max !== undefined && reading.value > g.max) {
      return { ok: false, reason: `守卫未满足：${g.nodeId} 独立读数 ${reading.value} > 上限 ${g.max}` }
    }
    guardEvidence.push({ nodeId: g.nodeId, measured: reading.value, ...(g.min === undefined ? {} : { min: g.min }), ...(g.max === undefined ? {} : { max: g.max }) })
  }
  return {
    ok: true,
    skipped: false,
    evidence: {
      nodeId: verification.nodeId,
      measured: target.value,
      atMs: target.atMs,
      target: band.target,
      tol: band.tol,
      guards: guardEvidence,
    },
  }
}
