/**
 * 本体学习闭环(科学探索计划 P6,docs/plans/2026-11-02-scientific-exploration-plan.md):
 *  - backfillInterventionEvidence:干预台账的判定(效应/CI/MDE/欠功效/混杂)回灌 ontology_evidence,
 *    以 intervention_events.id 为 source_ref(可追溯、幂等:同一干预不重复登记);
 *  - resolveCouplingFromOntology:供 P5 通道 B 查询"该 actuator→target 有没有耦合路径",
 *    三值返回:true=有边;false=已发布本体存在但明确无边;null=未发布本体(unknown,不拦)。
 * 只追加证据,**不改本体版本**(版本变更仍走 draft→approve→publish 人工链)。
 */
import { createHash } from 'node:crypto'
import { getOntologyRepo } from '../ontology/repo'
import type { InterventionEventRow } from './intervention-ledger'

function hashOf(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

/** 干预判定 → 证据等级(观测证据,不是人工断言) */
function evidenceLevelOf(verdict: string): string {
  if (verdict === 'identifiable_effect' || verdict === 'no_resolvable_effect') return 'observed'
  if (verdict === 'underpowered' || verdict === 'confounded') return 'observed_weak'
  return 'observed_unassessed'
}

export interface BackfillResult {
  appended: boolean
  reason: string
  evidenceId?: string
  ontologyId?: string
}

/**
 * 回灌一次干预判定到本体证据账本(targetKind=relation,targetKey=`src->dst`)。
 * 幂等:source_ref = 干预 id,已存在同 sourceRef 的行则跳过。
 */
export function backfillInterventionEvidence(event: InterventionEventRow): BackfillResult {
  if (!event.targetNodeId) return { appended: false, reason: '干预无 targetNodeId(非判读路径),不登记耦合证据' }
  if (event.verdict === 'pending' || event.verdict === 'unassessed') {
    return { appended: false, reason: `判定 ${event.verdict} 未收口,不登记证据` }
  }
  const repo = getOntologyRepo()
  const version = repo.latestPublishedForLine(event.lineId)
  if (!version) return { appended: false, reason: '该产线无已发布本体,证据暂存于干预台账(发布后可按台账回填)' }
  const targetKey = `${event.nodeId}->${event.targetNodeId}`
  const existing = repo.listEvidence(version.id, { targetKind: 'relation', targetKey, limit: 500 })
  if (existing.some(e => e.sourceRef === event.id)) {
    return { appended: false, reason: '已登记(幂等跳过)', ontologyId: version.id }
  }
  const id = `ev-intv-${event.id}`
  const detail = {
    interventionId: event.id,
    verdict: event.verdict,
    effect: event.effect,
    ciLow: event.ciLow,
    ciHigh: event.ciHigh,
    mde: event.mde,
    fromValue: event.fromValue,
    toValue: event.toValue,
    path: event.path,
    ts: event.ts,
    note: event.verdict === 'no_resolvable_effect'
      ? '窗口充分的负结论:该步幅下无可分辨效应(不是失败)'
      : event.verdict === 'underpowered'
        ? '欠功效:当前步幅/窗长不足,不能据此判定有无耦合'
        : event.verdict === 'confounded'
          ? '被混杂:档位与时间不可分,不能据此判定有无耦合'
          : '效应可分辨(CI 不含 0)',
  }
  repo.appendEvidence({
    id,
    ontologyId: version.id,
    targetKind: 'relation',
    targetKey,
    level: evidenceLevelOf(event.verdict),
    sourceType: 'intervention',
    sourceRef: event.id,
    sourceRefHash: hashOf(JSON.stringify(detail)),
    detailJson: JSON.stringify(detail),
    createdBy: event.actor || 'system',
    createdAt: new Date().toISOString(),
  })
  return { appended: true, reason: '已登记', evidenceId: id, ontologyId: version.id }
}

export interface OntologyCouplingResolution {
  /** true=存在耦合路径;false=本体明确无路径;null=未声明/无已发布本体 */
  hasCouplingPath: boolean | null
  evidence: string[]
  ontologyId?: string
  version?: number
  /** 该耦合的证据支持/否证计数(来自 intervention 回灌) */
  supportCount: number
  refuteCount: number
}

/**
 * P5 通道 B:查询已发布本体里 control→target 的耦合路径。
 * 关系匹配:predicate ∈ influences/actuates 且 src/dst 命中(节点 id → 语义绑定 entity_key 兜底)。
 * 有已发布版本但找不到边 → hasCouplingPath=false(明确断言"无路径",这是可证伪的一等事实)。
 */
export function resolveCouplingFromOntology(lineId: string, controlNodeId: string, targetNodeId: string): OntologyCouplingResolution {
  const repo = getOntologyRepo()
  const version = repo.latestPublishedForLine(lineId)
  if (!version) return { hasCouplingPath: null, evidence: [], supportCount: 0, refuteCount: 0 }
  const keyOf = (kind: 'dcw' | 'daq', nodeId: string): string[] => {
    const keys = [nodeId]
    try {
      for (const b of repo.listBindingsByTarget(kind, nodeId)) if (b.entityKey) keys.push(String(b.entityKey))
    }
    catch { /* 绑定表不可读 → 仅按节点 id 匹配 */ }
    return keys
  }
  const srcs = keyOf('dcw', controlNodeId)
  const dsts = keyOf('daq', targetNodeId)
  const relations = repo.listRelations(version.id, version.version)
  // 注意:repo 把 predicate 列映射为关系对象的 kind 字段(不是 predicate)
  const hits = relations.filter(r => (r.kind === 'influences' || r.kind === 'actuates')
    && srcs.includes(String(r.srcKey)) && dsts.includes(String(r.dstKey)))
  const targetKey = `${controlNodeId}->${targetNodeId}`
  const ledger = repo.listEvidence(version.id, { targetKind: 'relation', targetKey, limit: 500 })
  const verdictOf = (detailJson: string): string | undefined => {
    try {
      return (JSON.parse(detailJson) as { verdict?: string }).verdict
    }
    catch {
      return undefined
    }
  }
  const supportCount = ledger.filter(e => verdictOf(e.detailJson) === 'identifiable_effect').length
  const refuteCount = ledger.filter(e => verdictOf(e.detailJson) === 'no_resolvable_effect').length
  const evidence = [
    ...hits.map(h => `relation ${h.kind}:${h.srcKey}→${h.dstKey}(${h.status})`),
    ...(supportCount ? [`干预证据支持 ${supportCount} 次(效应可分辨)`] : []),
    ...(refuteCount ? [`干预证据否证 ${refuteCount} 次(无可分辨效应)`] : []),
  ]
  return {
    hasCouplingPath: hits.length > 0,
    evidence,
    ontologyId: version.id,
    version: version.version,
    supportCount,
    refuteCount,
  }
}
