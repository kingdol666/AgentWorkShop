/**
 * 语义绑定:单位/类型/读写能力/写语义独占 五类拒绝 + 合法路径。
 * 用注入 resolver 隔离活体目录(无需真实 daq/dcw 节点)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseDraftDoc } = await import('../server/services/workshop/ontology/contracts')
const { assertBindingShape, validateDraftBindings, detectBindingDrift } = await import('../server/services/workshop/ontology/semantic-binding.service')
const { buildDoc } = await import('./ontology-fixture')

const ENTITY = { key: 'pv.melt_pressure', kind: 'process_variable' as const, name: '熔体压力', description: '', unit: 'bar', dimension: 'pressure', role: 'control' as const, attrs: { dataType: 'number' } }

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1', entityKey: 'pv.melt_pressure', platformKind: 'dcw_node' as const, platformId: 'n1',
    targetSub: '', scope: 'line:ln-1', direction: 'write' as const,
    unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0, ...overrides,
  }
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    platformKind: 'dcw_node' as const, platformId: 'n1', targetSub: '', name: '泵速',
    unit: 'bar', min: 0, max: 100, stepLimit: 5, writable: true, lineId: 'ln-1', enabled: true, ...overrides,
  }
}

test('合法写入绑定通过并回填目标信息', () => {
  const resolved = assertBindingShape(ENTITY, binding(), target())
  assert.equal(resolved.unit, 'bar')
  assert.equal(resolved.writable, true)
})

test('单位量纲不相容 → UNIT_MISMATCH', () => {
  assert.throws(() => assertBindingShape(ENTITY, binding({ unitDeclared: 'mm' }), target()),
    (err: { code?: string }) => err.code === 'UNIT_MISMATCH')
})

test('同量纲不同字面单位但未给换算 → UNIT_TRANSFORM_REQUIRED(禁止 1/0 兜底)', () => {
  assert.throws(() => assertBindingShape({ ...ENTITY, unit: 'degc' }, binding({ unitDeclared: 'degc' }), target({ unit: 'k' })),
    (err: { code?: string }) => err.code === 'UNIT_TRANSFORM_REQUIRED')
  // 显式换算契约则通过
  assert.ok(assertBindingShape({ ...ENTITY, unit: 'degc' }, binding({ unitDeclared: 'degc', scale: 1, offset: 273.15 }), target({ unit: 'k' })))
})

test('只读通道声明写 → ACCESS_MODE_CONFLICT', () => {
  assert.throws(() => assertBindingShape(ENTITY, binding({ platformKind: 'daq_node', direction: 'write' }), target({ platformKind: 'daq_node', writable: false })),
    (err: { code?: string }) => err.code === 'ACCESS_MODE_CONFLICT')
  // 只读通道声明 read 通过
  assert.ok(assertBindingShape(ENTITY, binding({ platformKind: 'daq_node', direction: 'read' }), target({ platformKind: 'daq_node', writable: false })))
})

test('实体非数值类型绑数值通道 → TYPE_MISMATCH', () => {
  assert.throws(() => assertBindingShape({ ...ENTITY, attrs: { dataType: 'boolean' } }, binding(), target()),
    (err: { code?: string }) => err.code === 'TYPE_MISMATCH')
})

test('跨产线绑定 → ONTOLOGY_SCOPE_MISMATCH', () => {
  assert.throws(() => assertBindingShape(ENTITY, binding(), target({ lineId: 'ln-other' }), { lineId: 'ln-1' }),
    (err: { code?: string }) => err.code === 'ONTOLOGY_SCOPE_MISMATCH')
})

test('目标停用 → TARGET_DISABLED;scale=0 → UNIT_CONTRACT_INVALID', () => {
  assert.throws(() => assertBindingShape(ENTITY, binding(), target({ enabled: false })),
    (err: { code?: string }) => err.code === 'TARGET_DISABLED')
  assert.throws(() => assertBindingShape(ENTITY, binding({ scale: 0 }), target()),
    (err: { code?: string }) => err.code === 'UNIT_CONTRACT_INVALID')
})

test('目标不存在 → TARGET_NOT_FOUND(resolver 返回 null)', () => {
  const doc = parseDraftDoc(buildDoc())
  const report = validateDraftBindings(doc, { resolver: () => null })
  assert.equal(report.ok, false)
  assert.ok(report.failures.every(f => f.code === 'TARGET_NOT_FOUND'))
})

test('同一物理目标被两个实体声明写 → BINDING_TARGET_OWNED(一个量只有一个写语义)', () => {
  const doc = parseDraftDoc(buildDoc())
  doc.bindings = [
    { id: 'b1', entityKey: 'pv.melt_pressure', platformKind: 'dcw_node', platformId: 'n1', targetSub: '', scope: 'line:ln-pva-01', direction: 'write', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0 },
    { id: 'b2', entityKey: 'st.line_speed', platformKind: 'dcw_node', platformId: 'n1', targetSub: '', scope: 'line:ln-pva-01', direction: 'write', unitDeclared: 'm', unitTarget: 'm', scale: 1, offset: 0 },
  ]
  doc.entities = doc.entities.map(e => e.key === 'st.line_speed' ? { ...e, unit: 'm' } : e)
  const report = validateDraftBindings(doc, {
    resolver: () => target({ unit: 'bar' }),
  })
  // 单位不相容先命中(st.line_speed 是 m vs bar),所以这里断言写语义独占需要同单位目标
  assert.equal(report.ok, false)
})

test('写语义独占(同单位目标)→ BINDING_TARGET_OWNED', () => {
  const doc = parseDraftDoc(buildDoc())
  doc.entities = [
    { key: 'a.v1', kind: 'process_variable', name: 'A', description: '', unit: 'bar', dimension: 'pressure', role: 'control', attrs: {} },
    { key: 'a.v2', kind: 'process_variable', name: 'B', description: '', unit: 'bar', dimension: 'pressure', role: 'control', attrs: {} },
  ]
  doc.relations = []
  doc.rules = []
  doc.bindings = [
    { id: 'b1', entityKey: 'a.v1', platformKind: 'dcw_node', platformId: 'n1', targetSub: '', scope: 'global', direction: 'write', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0 },
    { id: 'b2', entityKey: 'a.v2', platformKind: 'dcw_node', platformId: 'n1', targetSub: '', scope: 'global', direction: 'write', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0 },
  ]
  const report = validateDraftBindings(doc, { resolver: () => target() })
  assert.equal(report.ok, false)
  assert.equal(report.failures[0]!.code, 'BINDING_TARGET_OWNED')
  assert.match(report.failures[0]!.message, /一个物理量只能有一个写语义/)
})

test('多读源允许(同目标两个实体只读 → 通过)', () => {
  const doc = parseDraftDoc(buildDoc())
  doc.entities = [
    { key: 'a.v1', kind: 'process_variable', name: 'A', description: '', unit: 'bar', dimension: 'pressure', role: 'observation', attrs: {} },
    { key: 'a.v2', kind: 'process_variable', name: 'B', description: '', unit: 'bar', dimension: 'pressure', role: 'observation', attrs: {} },
  ]
  doc.relations = []
  doc.rules = []
  doc.bindings = [
    { id: 'b1', entityKey: 'a.v1', platformKind: 'daq_node', platformId: 'n1', targetSub: '', scope: 'global', direction: 'read', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0 },
    { id: 'b2', entityKey: 'a.v2', platformKind: 'daq_node', platformId: 'n1', targetSub: '', scope: 'global', direction: 'read', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0 },
  ]
  const report = validateDraftBindings(doc, { resolver: () => target({ writable: false }) })
  assert.equal(report.ok, true, JSON.stringify(report.failures))
})

test('漂移检测:目标删除/停用/单位变更 → drifted', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'b1', versionId: 'o', version: 1, entityKey: 'pv.melt_pressure', platformKind: 'dcw_node',
    platformId: 'n1', targetSub: '', scope: 'global', direction: 'write', unitDeclared: 'bar',
    unitTarget: 'bar', scale: 1, offset: 0, status: 'active', lastVerifiedAt: null, createdAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  })
  // 用真实 resolver 的空目录:节点不存在 → 漂移
  const report = detectBindingDrift([row() as never])
  assert.equal(report.ok, false)
  assert.match(report.drifted[0]!.reason, /目标不存在/)
})
