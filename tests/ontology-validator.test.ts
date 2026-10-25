/**
 * 本体文档校验(纯函数)负例集:每个 fail-closed 分支至少一条断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseDraftDoc, RULE_ERROR_CODES } = await import('../server/services/workshop/ontology/contracts')
const { validateDraftDoc } = await import('../server/services/workshop/ontology/validator')
const { buildDoc } = await import('./ontology-fixture')

function issuesOf(mutate: (doc: ReturnType<typeof buildDoc>) => void) {
  const doc = buildDoc()
  mutate(doc)
  const report = validateDraftDoc(parseDraftDoc(doc))
  return { report, codes: report.issues.map(i => i.code) }
}

test('合法夹具通过校验(0 error)', () => {
  const report = validateDraftDoc(parseDraftDoc(buildDoc()))
  assert.equal(report.ok, true, JSON.stringify(report.issues.filter(i => i.severity === 'error')))
  assert.equal(report.stats.entities, 4)
  assert.equal(report.stats.rules, 6)
  assert.equal(report.stats.byState.approved_for_control, 3)
})

test('悬空关系引用 → ONTOLOGY_UNKNOWN_ENTITY', () => {
  const { codes } = issuesOf((doc) => {
    doc.relations[0]!.dstKey = 'nope.missing'
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.UNKNOWN_ENTITY))
})

test('实体 key 重复 → ONTOLOGY_INVALID', () => {
  const { codes } = issuesOf((doc) => {
    doc.entities.push({ ...doc.entities[0]! })
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.INVALID))
})

test('实体单位与声明量纲不相容 → ONTOLOGY_UNIT_MISMATCH(℃ 归一路径)', () => {
  const { codes } = issuesOf((doc) => {
    doc.entities.push({
      key: 'pv.temp', kind: 'process_variable', name: '温度', description: '', unit: '℃',
      dimension: 'pressure', role: 'state', attrs: {},
    })
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.UNIT_MISMATCH))
})

test('关系证据档高于证据级别 → ONTOLOGY_EVIDENCE_INSUFFICIENT', () => {
  const { codes } = issuesOf((doc) => {
    doc.relations[1]!.properties.evidenceTier = 'validated_control'
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT))
})

test('未验证关系携带增益/时滞 → ONTOLOGY_EVIDENCE_INSUFFICIENT(增益只来自受控验证)', () => {
  const { codes } = issuesOf((doc) => {
    doc.relations[1]!.properties.gainPerUnit = 0.5
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT))
})

test('硬约束缺 validated_control 证据 → ONTOLOGY_EVIDENCE_INSUFFICIENT', () => {
  const { codes } = issuesOf((doc) => {
    doc.rules[0]!.evidence = []
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT))
})

test('规则 kind 与 DSL 形态不一致 → ONTOLOGY_INVALID', () => {
  const { codes } = issuesOf((doc) => {
    doc.rules[0]!.kind = 'rate'
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.INVALID))
})

test('规则引用不存在的实体 → ONTOLOGY_UNKNOWN_ENTITY', () => {
  const { codes } = issuesOf((doc) => {
    doc.rules[1]!.dsl = { type: 'rate', variableKey: 'ghost.var', maxStep: 1 }
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.UNKNOWN_ENTITY))
})

test('界区间为空(min>max) → ONTOLOGY_RULE_CONFLICT', () => {
  const { codes } = issuesOf((doc) => {
    doc.rules[0]!.dsl = { type: 'bound', variableKey: 'cv.thickness', min: 60, max: 50 }
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.RULE_CONFLICT))
})

test('绑定引用不存在的实体 → ONTOLOGY_UNKNOWN_ENTITY', () => {
  const { codes } = issuesOf((doc) => {
    doc.bindings[0]!.entityKey = 'ghost.entity'
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.UNKNOWN_ENTITY))
})

test('绑定单位与目标单位量纲不相容 → ONTOLOGY_UNIT_MISMATCH', () => {
  const { codes } = issuesOf((doc) => {
    doc.bindings[0]!.unitTarget = 'mm'
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.UNIT_MISMATCH))
})

test('绑定 scale=0 → ONTOLOGY_INVALID(禁止兜底)', () => {
  const { codes } = issuesOf((doc) => {
    doc.bindings[0]!.scale = 0
  })
  assert.ok(codes.includes(RULE_ERROR_CODES.INVALID))
})

test('复杂非线性表达式 → 提示不可执行(UNSUPPORTED_FORM,warning 不阻断)', () => {
  const doc = buildDoc()
  doc.rules = [{
    id: 'R-NL', key: 'nl', kind: 'nonlinear',
    dsl: { type: 'nonlinear', variableKey: 'cv.thickness', expression: 'sqrt(a)/b*c+1' },
    constraintLevel: 'soft', severity: 'warn', status: 'proposed',
    evidence: [], description: '', scope: { lineId: '', recipeId: '', conditionId: '' },
  }]
  const report = validateDraftDoc(parseDraftDoc(doc))
  assert.ok(report.issues.some(i => i.code === RULE_ERROR_CODES.UNSUPPORTED_FORM && i.severity === 'warning'))
  assert.equal(report.ok, true)
})

test('Schema 拒绝非法实体 key(点分小写规范)', () => {
  const doc = buildDoc()
  doc.entities[0]!.key = 'Bad Key!'
  assert.throws(() => parseDraftDoc(doc))
})
