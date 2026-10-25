/**
 * 本体测试夹具(非 *.test.ts,不会被测试 glob 收集)。
 * 场景:PVA 双拉线的控制导向本体切片 —— 可调压力/线速 + 质量目标膜厚 + 温区就绪状态。
 */
import type { EvidenceRecord, OntologyDraftDoc } from '../server/services/workshop/ontology/contracts'

export function evidence(level: EvidenceRecord['level'], id = `ev-${level}`): EvidenceRecord {
  if (level === 'validated_control') {
    return {
      id, level, source: { type: 'optimizer_run', runId: 'run-1', problemIrHash: 'ir-1', modelArtifactHash: 'mdl-1' },
      sourceRefHash: 'h-run', createdAt: '2026-10-24T00:00:00.000Z',
    }
  }
  if (level === 'observed_correlation') {
    return {
      id, level, source: { type: 'dataset_stats', datasetId: 'ds-1', sha256: 'abc' },
      sourceRefHash: 'h-ds', createdAt: '2026-10-24T00:00:00.000Z',
    }
  }
  return {
    id, level, source: { type: 'expert_note', author: 'engineer', noteId: 'note-1' },
    sourceRefHash: 'h-note', createdAt: '2026-10-24T00:00:00.000Z',
  }
}

export function buildDoc(): OntologyDraftDoc {
  return {
    schemaVersion: 1,
    name: 'PVA 双拉线本体',
    lineId: 'ln-pva-01',
    entities: [
      { key: 'pv.melt_pressure', kind: 'process_variable', name: '熔体压力', description: '', unit: 'bar', dimension: 'pressure', role: 'control', attrs: { dataType: 'number' } },
      { key: 'cv.thickness', kind: 'quality_variable', name: '平均膜厚', description: '', unit: 'mm', dimension: 'length', role: 'target', attrs: { dataType: 'number' } },
      { key: 'st.line_speed', kind: 'process_variable', name: '线速度', description: '', unit: 'm', dimension: 'length', role: 'control', attrs: { dataType: 'number' } },
      { key: 'st.thermal_ready', kind: 'process_variable', name: '温区稳定', description: '', unit: '', dimension: 'dimensionless', role: 'guard', attrs: { dataType: 'boolean' } },
    ],
    relations: [
      {
        id: 'rel-pressure-thickness',
        kind: 'influences',
        srcKey: 'pv.melt_pressure',
        dstKey: 'cv.thickness',
        status: 'validated',
        evidence: [evidence('validated_control', 'ev-rel')],
        properties: {
          sign: 'negative', gainPerUnit: -0.4, lagMs: 45000,
          evidenceTier: 'validated_control', variabilityChecked: true,
        },
      },
      {
        id: 'rel-speed-thickness',
        kind: 'influences',
        srcKey: 'st.line_speed',
        dstKey: 'cv.thickness',
        status: 'proposed',
        evidence: [evidence('candidate_influence', 'ev-speed')],
        properties: { evidenceTier: 'candidate_influence', variabilityChecked: false, transportDistanceM: 10, nominalSpeedMps: 0.5 },
      },
    ],
    rules: [
      {
        id: 'R-BOUND', key: 'thickness-window', kind: 'bound',
        dsl: { type: 'bound', variableKey: 'cv.thickness', min: 48, max: 52, unit: 'mm' },
        constraintLevel: 'hard', severity: 'error', status: 'approved_for_control',
        evidence: [evidence('validated_control', 'ev-bound')], description: '膜厚工艺窗',
        scope: { lineId: 'ln-pva-01', recipeId: 'rc-A', conditionId: '' },
      },
      {
        id: 'R-RATE', key: 'pressure-rate', kind: 'rate',
        dsl: { type: 'rate', variableKey: 'pv.melt_pressure', maxStep: 3, unit: 'bar' },
        constraintLevel: 'hard', severity: 'error', status: 'approved_for_control',
        evidence: [evidence('validated_control', 'ev-rate')], description: '压力单步上限',
        scope: { lineId: 'ln-pva-01', recipeId: 'rc-A', conditionId: '' },
      },
      {
        id: 'R-GUARD', key: 'thermal-before-speedup', kind: 'state_condition',
        dsl: {
          type: 'state_condition',
          when: { variableKey: 'st.thermal_ready', op: 'eq', value: false },
          forbid: { kind: 'positive_increment', variableKey: 'st.line_speed' },
          message: '温区未稳定,禁止提速',
        },
        constraintLevel: 'hard', severity: 'error', status: 'approved_for_control',
        evidence: [evidence('validated_control', 'ev-guard')], description: '温区未稳禁提速',
        scope: { lineId: 'ln-pva-01', recipeId: 'rc-A', conditionId: '' },
      },
      {
        id: 'R-INTERLOCK', key: 'e-stop-interlock', kind: 'interlock',
        dsl: { type: 'interlock', text: '急停回路动作时禁止任何写控' },
        constraintLevel: 'hard', severity: 'error', status: 'reviewed',
        evidence: [evidence('candidate_influence', 'ev-il')], description: '安全联锁归 PLC',
        scope: { lineId: 'ln-pva-01', recipeId: '', conditionId: '' },
      },
      {
        id: 'R-INFORMAL', key: 'operator-preference', kind: 'informal',
        dsl: { type: 'informal', text: '交接班前优先保持稳态' },
        constraintLevel: 'soft', severity: 'warn', status: 'proposed',
        evidence: [], description: '经验建议', scope: { lineId: '', recipeId: '', conditionId: '' },
      },
      {
        id: 'R-COUPLING', key: 'pressure-speed-coupling', kind: 'linear_coupling',
        dsl: { type: 'linear_coupling', variableKey: 'pv.melt_pressure', ofKey: 'st.line_speed', factor: 0.2 },
        constraintLevel: 'soft', severity: 'warn', status: 'proposed',
        evidence: [evidence('candidate_influence', 'ev-cp')], description: '压力与线速耦合',
        scope: { lineId: '', recipeId: '', conditionId: '' },
      },
    ],
    bindings: [
      {
        id: 'b-pressure', entityKey: 'pv.melt_pressure', platformKind: 'dcw_node', platformId: 'n-pressure',
        targetSub: '', scope: 'line:ln-pva-01', direction: 'write', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0,
      },
      {
        id: 'b-thickness', entityKey: 'cv.thickness', platformKind: 'daq_node', platformId: 'n-thickness',
        targetSub: '', scope: 'line:ln-pva-01', direction: 'read', unitDeclared: 'mm', unitTarget: 'mm', scale: 1, offset: 0,
      },
    ],
    note: '',
  }
}

/** 只保留一条规则的精简文档(避免多规则互相干扰) */
export function docWithRule(ruleIndex: number): OntologyDraftDoc {
  const doc = buildDoc()
  doc.rules = [doc.rules[ruleIndex]!]
  return doc
}
