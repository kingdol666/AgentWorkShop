/**
 * E5 Commonality —— 坏批次共性分析(bad run 集合 × 因子的交叉统计 + lift)。
 *
 * bad 集 = 特征违例行涉及的全部 run(FDC violated=1;SPC 判异走 ops 审计不入本表,
 * 后续项);因子 = node / chamber(E8 节点可选字段)/ recipe / hour(批次开始小时桶)。
 * lift = P(bad|factor) / P(bad):>1 表示该因子取值下坏批占比高于基线。
 * 查询形状:全部 GROUP BY 聚合,TS 只算占比(评审判定:纯封装)。
 */
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { edaDb } from './eda-db'
import { getDaqNodeRepo } from '../daq/daq-node.repo'

export type CommonalityFactor = 'node' | 'chamber' | 'recipe' | 'hour'

export interface CommonalityRow {
  factor: string
  factorValue: string
  runsTotal: number
  runsBad: number
  badRate: number
  lift: number
}

export class CommonalityError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function commonality(user: ResolvedUser, args: {
  lineId: string
  factor: CommonalityFactor
}): { factor: CommonalityFactor, baselineBadRate: number, runsTotal: number, rows: CommonalityRow[] } {
  if (lineMode(user, args.lineId) === 'none') {
    throw new CommonalityError(403, `产线 ${args.lineId} 不在你的可读范围内。`)
  }
  const db = edaDb()
  const runsTotal = Number((db.prepare('SELECT COUNT(*) AS c FROM eda_runs WHERE line_id = ?').get(args.lineId) as { c: number }).c)
  if (runsTotal === 0) return { factor: args.factor, baselineBadRate: 0, runsTotal: 0, rows: [] }
  // 坏批集:该线特征违例行涉及的 run(去重)
  const badSet = new Set(
    (db.prepare(`SELECT DISTINCT f.run_id FROM eda_run_features f JOIN eda_runs r ON r.id = f.run_id
      WHERE r.line_id = ? AND f.violated = 1`).all(args.lineId) as Array<{ run_id: string }>).map(x => x.run_id),
  )
  const baselineBadRate = badSet.size / runsTotal
  const rows: CommonalityRow[] = []
  if (args.factor === 'node' || args.factor === 'chamber') {
    const nodes = getDaqNodeRepo().all().filter(n => n.lineId === args.lineId)
    const valueOf = (nodeId: string): string | null => {
      const n = nodes.find(x => x.id === nodeId)
      if (!n) return null
      if (args.factor === 'node') return n.id
      return (n as unknown as { chamber?: string }).chamber || null
    }
    // 特征行面聚合:每个因子的涉及 run 数与违例 run 数
    const feats = db.prepare(`SELECT f.node_id, f.run_id, f.violated FROM eda_run_features f JOIN eda_runs r ON r.id = f.run_id
      WHERE r.line_id = ?`).all(args.lineId) as Array<{ node_id: string, run_id: string, violated: number }>
    const byFactor = new Map<string, { runs: Set<string>, bad: Set<string> }>()
    for (const f of feats) {
      const v = valueOf(f.node_id)
      if (!v) continue
      const a = byFactor.get(v) ?? { runs: new Set<string>(), bad: new Set<string>() }
      a.runs.add(f.run_id)
      if (f.violated === 1 && badSet.has(f.run_id)) a.bad.add(f.run_id)
      byFactor.set(v, a)
    }
    for (const [v, a] of byFactor) {
      const badRate = a.runs.size ? a.bad.size / a.runs.size : 0
      rows.push({ factor: args.factor, factorValue: v, runsTotal: a.runs.size, runsBad: a.bad.size, badRate: Number(badRate.toFixed(4)), lift: Number((badRate / baselineBadRate || 0).toFixed(4)) })
    }
  }
  else if (args.factor === 'recipe') {
    const feats = db.prepare(`SELECT r.recipe_id, f.run_id, f.violated FROM eda_run_features f JOIN eda_runs r ON r.id = f.run_id
      WHERE r.line_id = ?`).all(args.lineId) as Array<{ recipe_id: string, run_id: string, violated: number }>
    const byRecipe = new Map<string, { runs: Set<string>, bad: Set<string> }>()
    for (const f of feats) {
      const a = byRecipe.get(f.recipe_id) ?? { runs: new Set<string>(), bad: new Set<string>() }
      a.runs.add(f.run_id)
      if (f.violated === 1 && badSet.has(f.run_id)) a.bad.add(f.run_id)
      byRecipe.set(f.recipe_id, a)
    }
    for (const [v, a] of byRecipe) {
      const badRate = a.runs.size ? a.bad.size / a.runs.size : 0
      rows.push({ factor: 'recipe', factorValue: v, runsTotal: a.runs.size, runsBad: a.bad.size, badRate: Number(badRate.toFixed(4)), lift: Number((badRate / baselineBadRate || 0).toFixed(4)) })
    }
  }
  else {
    // hour:批次开始小时桶(全 run 面,不依赖特征行)
    const runs = db.prepare('SELECT id, started_at FROM eda_runs WHERE line_id = ?').all(args.lineId) as Array<{ id: string, started_at: string }>
    const byHour = new Map<string, { runs: Set<string>, bad: Set<string> }>()
    for (const r of runs) {
      const h = String(r.started_at).slice(11, 13)
      const a = byHour.get(h) ?? { runs: new Set<string>(), bad: new Set<string>() }
      a.runs.add(r.id)
      if (badSet.has(r.id)) a.bad.add(r.id)
      byHour.set(h, a)
    }
    for (const [v, a] of byHour) {
      const badRate = a.runs.size ? a.bad.size / a.runs.size : 0
      rows.push({ factor: 'hour', factorValue: v, runsTotal: a.runs.size, runsBad: a.bad.size, badRate: Number(badRate.toFixed(4)), lift: Number((badRate / baselineBadRate || 0).toFixed(4)) })
    }
  }
  rows.sort((a, b) => b.lift - a.lift)
  return { factor: args.factor, baselineBadRate: Number(baselineBadRate.toFixed(4)), runsTotal, rows }
}
