/**
 * 配对评测落库(2026-11-10 审计:RSI bench 门 provenance)。
 *
 * 背景:promote→active 曾直接接受客户端自报的 `bench {pValue, primaryDelta, costDelta}`,
 * 与任何一次 harness-ab 运行没有绑定 —— 同一份数字可喂给任意 profile 并双双过门。
 *
 * 这里把评测落成**台账行**:
 *  - 服务端用 `perSeed` 复算 primaryDelta / costDelta,与客户端自报值不一致直接拒绝
 *    (汇总值不能脱离逐 seed 原始数据存在);
 *  - 记录 per-seed 明细与 artifact 摘要,供审计/复盘;
 *  - promote→active 只能引用本表 run id(绑定 channel + profile + 新鲜度 + 样本量)。
 *
 * 残留(如实):perSeed 本身仍由客户端提供,真正的"不可能伪造"需要服务端执行 bench
 * (runner allowlist + 服务端拉起 harness-ab)。本轮先做到可追溯、可复算、可绑定。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createHarnessBenchRunRepo, type HarnessBenchRunRow } from '../db/harness-bench.repo'
import { PROFILE_GATE } from './gates'

export interface BenchSeedRow {
  seed: number
  a: number
  b: number
  costA?: number
  costB?: number
}

export interface BenchArtifactInput {
  profileId: string
  baselineProfileId?: string
  /** 未做显著性检验时为 null */
  pValue?: number | null
  /** 客户端自报汇总值(必须与 perSeed 复算一致) */
  primaryDelta?: number
  costDelta?: number
  seeds?: number[]
  perSeed: BenchSeedRow[]
  excluded?: number
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const round = (x: number): number => Math.round(x * 1e6) / 1e6

/** Deterministic one-sided paired sign-test p-value; client-supplied pValue is never trusted. */
function pairedSignPValue(rows: BenchSeedRow[]): number {
  const deltas = rows.map(r => Number(r.a) - Number(r.b)).filter(Number.isFinite)
  const nonTies = deltas.filter(d => d !== 0)
  if (nonTies.length === 0) return 1
  const positives = nonTies.filter(d => d > 0).length
  let probability = 0
  for (let k = positives; k <= nonTies.length; k++) {
    probability += factorial(nonTies.length) / (factorial(k) * factorial(nonTies.length - k))
      * (0.5 ** nonTies.length)
  }
  return round(Math.min(1, probability))
}

function factorial(n: number): number {
  let out = 1
  for (let i = 2; i <= n; i++) out *= i
  return out
}

export function recordBenchRun(
  db: DatabaseSync,
  input: { channelId: string, actor: string, artifact: BenchArtifactInput },
): { ok: true, run: HarnessBenchRunRow } | { ok: false, reasons: string[] } {
  const a = input.artifact
  const rows = Array.isArray(a.perSeed) ? a.perSeed : []
  if (rows.length < PROFILE_GATE.minPairs) {
    return { ok: false, reasons: [`有效配对 ${rows.length} < 下限 ${PROFILE_GATE.minPairs}`] }
  }
  const bad = rows.find(r => ![r?.a, r?.b].every(v => typeof v === 'number' && Number.isFinite(v)))
  if (bad) return { ok: false, reasons: [`perSeed 存在非数值样本(seed=${bad?.seed ?? '?'})`] }

  const meanA = mean(rows.map(r => Number(r.a)))
  const meanB = mean(rows.map(r => Number(r.b)))
  const primaryDelta = round(meanA - meanB)
  const hasCost = rows.every(r => typeof r.costA === 'number' && typeof r.costB === 'number')
  const costDelta = hasCost
    ? round(mean(rows.map(r => Number(r.costB))) - mean(rows.map(r => Number(r.costA))))
    : round(Number(a.costDelta ?? 0))

  if (a.primaryDelta !== undefined && Math.abs(round(Number(a.primaryDelta)) - primaryDelta) > 1e-6) {
    return { ok: false, reasons: [`primaryDelta 与 perSeed 复算不一致(自报 ${a.primaryDelta} / 复算 ${primaryDelta})`] }
  }
  if (a.costDelta !== undefined && Math.abs(round(Number(a.costDelta)) - costDelta) > 1e-6) {
    return { ok: false, reasons: [`costDelta 与 perSeed 复算不一致(自报 ${a.costDelta} / 复算 ${costDelta})`] }
  }
  const pValue = a.pValue === null || a.pValue === undefined ? null : Number(a.pValue)
  if (pValue !== null && (!Number.isFinite(pValue) || pValue < 0 || pValue > 1)) {
    return { ok: false, reasons: [`pValue 必须是 [0,1] 或 null，收到 ${String(a.pValue)}`] }
  }

  const artifactSha256 = createHash('sha256').update(JSON.stringify({ kind: 'harness-ab-paired', perSeed: rows, seeds: a.seeds ?? [] })).digest('hex')
  const repo = createHarnessBenchRunRepo(db)
  const now = new Date().toISOString()
  try {
    const run = repo.create({
      channelId: input.channelId,
      profileId: a.profileId,
      baselineProfileId: a.baselineProfileId ?? '',
      kind: 'harness-ab-paired',
      status: 'completed',
      pValue: pairedSignPValue(rows),
      primaryDelta,
      costDelta,
      pairs: rows.length,
      excluded: Number(a.excluded ?? 0) || 0,
      seedsJson: JSON.stringify(a.seeds ?? rows.map(r => r.seed)),
      perSeedJson: JSON.stringify(rows),
      artifactSha256,
      createdBy: input.actor,
      createdAt: now,
      completedAt: now,
    })
    return { ok: true, run }
  }
  catch (err) {
    // UNIQUE(profile_id, artifact_sha256):同一次评测不得重复导入
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reasons: [`落库失败(可能重复导入同一 artifact)：${msg.slice(0, 160)}`] }
  }
}

/** promote→active 的 provenance 校验:同频道、同 profile、已完成、样本量足、未过期 */
export function resolveBenchRunForPromote(
  db: DatabaseSync,
  input: { channelId: string, profileId: string, benchRunId: string },
): { ok: true, run: HarnessBenchRunRow } | { ok: false, reasons: string[] } {
  const run = createHarnessBenchRunRepo(db).get(input.benchRunId)
  if (!run) return { ok: false, reasons: ['benchRunId 不存在(必须先落库配对评测)'] }
  if (run.channelId !== input.channelId) return { ok: false, reasons: ['bench run 不属于该频道'] }
  if (run.profileId !== input.profileId) return { ok: false, reasons: ['bench run 不是该 profile 的评测'] }
  if (run.status !== 'completed') return { ok: false, reasons: [`bench run 状态 ${run.status} 不可用`] }
  if (run.pairs < PROFILE_GATE.minPairs) return { ok: false, reasons: [`bench 样本量 ${run.pairs} < ${PROFILE_GATE.minPairs}`] }
  const at = Date.parse(run.completedAt ?? run.createdAt)
  if (Number.isFinite(at) && Date.now() - at > PROFILE_GATE.maxAgeDays * 86_400_000) {
    return { ok: false, reasons: [`bench run 已过期(>${PROFILE_GATE.maxAgeDays} 天),请重新评测`] }
  }
  return { ok: true, run }
}
