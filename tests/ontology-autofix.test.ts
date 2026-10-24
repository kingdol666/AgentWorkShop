/**
 * 本体草稿自动修复 —— 纯函数验收:
 *  - 只做安全规范化(描述/量纲/作用域/悬空引用/重复 id/scale/证据不足状态回退);
 *  - 证据绝不伪造:缺证据的硬约束修复后仍然是错误;
 *  - 幂等:第二次运行零修复;
 *  - 有效文档不被改动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoFixDraftDoc } from '../server/services/workshop/ontology/autofix'
import type { OntologyDraftDoc } from '../server/services/workshop/ontology/contracts'
import { buildDoc, evidence } from './ontology-fixture'

function cleanDoc(): OntologyDraftDoc {
  const doc = buildDoc()
  doc.description = 'PVA 双拉线控制导向本体:压力/线速 → 膜厚,温区就绪守门'
  for (const entity of doc.entities) entity.description = `${entity.name}描述`
  for (const rule of doc.rules) {
    if (!rule.description) rule.description = `${rule.id} 描述`
    rule.scope.lineId = doc.lineId
  }
  for (const binding of doc.bindings) {
    const unit = doc.entities.find(e => e.key === binding.entityKey)?.unit ?? ''
    if (!binding.unitDeclared) binding.unitDeclared = unit
    if (!binding.unitTarget) binding.unitTarget = unit
  }
  return doc
}

test('有效文档:零修复,校验通过,原对象不被修改', () => {
  const doc = cleanDoc()
  const snapshot = JSON.stringify(doc)
  const { fixes, validation, doc: fixed } = autoFixDraftDoc(doc)
  assert.equal(fixes.length, 0, `不应有修复:${JSON.stringify(fixes)}`)
  assert.equal(validation.ok, true)
  assert.equal(JSON.stringify(doc), snapshot, '不得就地修改入参')
  assert.equal(JSON.stringify(fixed), snapshot)
})

test('补描述:文档/实体/规则描述一次补齐', () => {
  const doc = cleanDoc()
  doc.description = ''
  for (const entity of doc.entities) entity.description = ''
  for (const rule of doc.rules) rule.description = ''
  const { fixes, doc: fixed, validation } = autoFixDraftDoc(doc)
  const codes = new Set(fixes.map(f => f.code))
  assert.ok(codes.has('DOC_DESCRIPTION'))
  assert.ok(codes.has('ENTITY_DESCRIPTION'))
  assert.ok(codes.has('RULE_DESCRIPTION'))
  assert.ok(String(fixed.description).includes(doc.name))
  assert.ok(fixed.entities.every(e => e.description.length > 0))
  assert.ok(fixed.rules.every(r => r.description.length > 0))
  assert.equal(validation.ok, true)
})

test('量纲跟随单位:复合单位不强行声明量纲', () => {
  const doc = cleanDoc()
  doc.entities.push({
    key: 'pv.inject_speed', kind: 'process_variable', name: '注射速度', description: '注射速度',
    unit: 'mm/s', dimension: 'speed', role: 'control', attrs: { dataType: 'number' },
  })
  const { fixes, doc: fixed } = autoFixDraftDoc(doc)
  const entity = fixed.entities.find(e => e.key === 'pv.inject_speed')!
  assert.equal(entity.dimension, '', '复合单位 mm/s 应清空量纲(不主张相容性)')
  assert.ok(fixes.some(f => f.code === 'ENTITY_DIMENSION'))
})

test('作用域回填:规则与绑定的产线锚从文档继承', () => {
  const doc = cleanDoc()
  for (const rule of doc.rules) rule.scope.lineId = ''
  for (const binding of doc.bindings) binding.scope = ''
  const { fixes, doc: fixed } = autoFixDraftDoc(doc)
  assert.ok(fixed.rules.every(r => r.scope.lineId === doc.lineId))
  assert.ok(fixed.bindings.every(b => b.scope === `line:${doc.lineId}`))
  assert.ok(fixes.filter(f => f.code === 'SCOPE_LINE').length >= 2)
})

test('悬空引用与重复 id:确定性修复且保留不同内容的两份', () => {
  const doc = cleanDoc()
  doc.relations.push({
    id: 'rel-orphan', kind: 'influences', srcKey: 'pv.melt_pressure', dstKey: 'cv.missing',
    status: 'proposed', evidence: [], properties: { evidenceTier: 'candidate_influence', variabilityChecked: false },
  })
  doc.bindings.push({
    id: 'b-orphan', entityKey: 'cv.missing', platformKind: 'daq_node', platformId: 'dn-x',
    targetSub: '', scope: `line:${doc.lineId}`, direction: 'read', unitDeclared: 'mm', unitTarget: 'mm', scale: 1, offset: 0,
  })
  // 同 id 不同内容 → 保两份;完全重复 → 去重
  doc.relations.push({ ...doc.relations[0]! })
  doc.relations.push({ ...doc.relations[0]!, properties: { ...doc.relations[0]!.properties, gainPerUnit: -0.9 } })
  const { fixes, doc: fixed } = autoFixDraftDoc(doc)
  assert.ok(!fixed.relations.some(r => r.id === 'rel-orphan'), '悬空关系应移除')
  assert.ok(!fixed.bindings.some(b => b.id === 'b-orphan'), '悬空绑定应移除')
  assert.ok(fixes.some(f => f.code === 'ORPHAN_RELATION') && fixes.some(f => f.code === 'ORPHAN_BINDING'))
  const dupIds = fixed.relations.filter(r => r.id.startsWith('rel-pressure-thickness')).map(r => r.id)
  assert.ok(new Set(dupIds).size === dupIds.length, 'id 必须唯一')
  assert.ok(dupIds.length >= 2, '不同内容的两份都应保留(改 id)')
})

test('证据不足的控制级状态回退(证据不伪造)', () => {
  const doc = cleanDoc()
  const rule = doc.rules[0]!
  rule.kind = 'bound'
  rule.dsl = { type: 'bound', variableKey: 'cv.thickness', min: 4.5, max: 5.5, unit: 'mm' }
  rule.constraintLevel = 'hard'
  rule.status = 'approved_for_control'
  rule.evidence = [evidence('candidate_influence', 'ev-cand')]
  const { fixes, doc: fixed } = autoFixDraftDoc(doc)
  const after = fixed.rules[0]!
  assert.equal(after.status, 'validated')
  assert.ok(fixes.some(f => f.code === 'RULE_STATUS_DOWNGRADE'))
  // 证据缺失仍是错误 —— 修复器不能替人产生 validated_control
  const validation = autoFixDraftDoc(fixed).validation
  assert.equal(validation.ok, false)
})

test('幂等:修复一次后第二次零修复', () => {
  const doc = cleanDoc()
  doc.description = ''
  for (const entity of doc.entities) entity.description = ''
  const first = autoFixDraftDoc(doc)
  assert.ok(first.fixes.length > 0)
  const second = autoFixDraftDoc(first.doc)
  assert.equal(second.fixes.length, 0, `第二次不应再修:${JSON.stringify(second.fixes)}`)
})
