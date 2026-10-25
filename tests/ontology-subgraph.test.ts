/**
 * 本体子图 BFS 纯核心单测 —— 不依赖 DB / 框架,断言全部确定性。
 * 种子:G = 计划中的 canonical 5 实体/5 关系;E = G + 孤立点/自环/平行边/反向边。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSubgraphAround, parseSubgraphOptions,
  type SubgraphGraphData,
} from '../server/services/workshop/ontology/subgraph.core'

function entity(key: string, kind: string, role?: string, unit = ''): SubgraphGraphData['entities'][number] {
  return { key, kind, name: key, description: `${key} 描述`, unit, role }
}

function relation(id: string, kind: string, srcKey: string, dstKey: string): SubgraphGraphData['relations'][number] {
  return { id, kind, srcKey, dstKey, evidenceTier: 'candidate_influence' }
}

const G: SubgraphGraphData = {
  entities: [
    entity('mv.hold_pressure', 'actuator', 'control', 'bar'),
    entity('mv.hold_time', 'actuator', 'control', 's'),
    entity('pv.melt_temp', 'process_variable', 'state', 'degC'),
    entity('qv.part_weight', 'quality_variable', 'target', 'g'),
    entity('qv.flash_rate', 'quality_variable', 'target', '%'),
  ],
  relations: [
    relation('r-hp-w', 'influences', 'mv.hold_pressure', 'qv.part_weight'),
    relation('r-hp-f', 'influences', 'mv.hold_pressure', 'qv.flash_rate'),
    relation('r-hp-mt', 'influences', 'mv.hold_pressure', 'pv.melt_temp'),
    relation('r-mt-w', 'influences', 'pv.melt_temp', 'qv.part_weight'),
    relation('r-ht-w', 'influences', 'mv.hold_time', 'qv.part_weight'),
  ],
  bindings: [
    { entityKey: 'mv.hold_pressure', platformKind: 'dcw_node', platformId: 'dw-1', direction: 'write', status: 'active', unitDeclared: 'bar', unitTarget: 'bar' },
    { entityKey: 'qv.part_weight', platformKind: 'daq_node', platformId: 'dn-1', direction: 'read' },
  ],
}

const E: SubgraphGraphData = {
  entities: [...G.entities, entity('iso.only', 'process_variable', 'state')],
  relations: [
    ...G.relations,
    relation('r-hp-w-alt', 'basedOn', 'mv.hold_pressure', 'qv.part_weight'),
    relation('r-w-hp-bound', 'constrainedBy', 'qv.part_weight', 'mv.hold_pressure'),
    relation('r-f-loop', 'influences', 'qv.flash_rate', 'qv.flash_rate'),
  ],
  bindings: G.bindings,
}

const META = { ontologyId: 'ont-graph', version: 1, lineId: 'ln-graph-01' }

function keysOf(result: ReturnType<typeof buildSubgraphAround>): string[] {
  return result.nodes.map(n => n.key)
}

function hopsOf(result: ReturnType<typeof buildSubgraphAround>): Record<string, number> {
  return Object.fromEntries(result.nodes.map(n => [n.key, n.hop]))
}

function edgeMap(result: ReturnType<typeof buildSubgraphAround>): Record<string, [number, string]> {
  return Object.fromEntries(result.edges.map(e => [e.id, [e.hop, e.direction]]))
}

test('A1 hops=1/both:4 节点 + 4 诱导边,center.hop=0', () => {
  const r = buildSubgraphAround('mv.hold_pressure', G, META, { hops: 1, direction: 'both' })
  assert.deepEqual(keysOf(r), ['mv.hold_pressure', 'pv.melt_temp', 'qv.flash_rate', 'qv.part_weight'])
  assert.deepEqual(hopsOf(r), { 'mv.hold_pressure': 0, 'pv.melt_temp': 1, 'qv.flash_rate': 1, 'qv.part_weight': 1 })
  assert.deepEqual(r.edges.map(e => e.id), ['r-hp-f', 'r-hp-mt', 'r-hp-w', 'r-mt-w'])
  assert.deepEqual(edgeMap(r), { 'r-hp-f': [1, 'out'], 'r-hp-mt': [1, 'out'], 'r-hp-w': [1, 'out'], 'r-mt-w': [1, 'lateral'] })
  assert.equal(r.center.hop, 0)
  assert.equal(r.truncated, false)
})

test('A2 hops=2:新增 mv.hold_time(hop2)与 r-ht-w(hop2);r-mt-w 仍是 hop1', () => {
  const r = buildSubgraphAround('mv.hold_pressure', G, META, { hops: 2, direction: 'both' })
  assert.deepEqual(keysOf(r), ['mv.hold_pressure', 'pv.melt_temp', 'qv.flash_rate', 'qv.part_weight', 'mv.hold_time'])
  assert.equal(hopsOf(r)['mv.hold_time'], 2)
  assert.equal(hopsOf(r)['qv.part_weight'], 1)
  assert.equal(edgeMap(r)['r-ht-w']![0], 2)
  assert.equal(edgeMap(r)['r-ht-w']![1], 'in')
  assert.equal(edgeMap(r)['r-mt-w']![0], 1)
  assert.equal(r.edges.length, 5)
})

test('A3 孤立实体:nodes 只含 center,edges 为空', () => {
  const r = buildSubgraphAround('iso.only', E, META, { hops: 1 })
  assert.deepEqual(keysOf(r), ['iso.only'])
  assert.deepEqual(r.edges, [])
  assert.deepEqual(r.center.bindings, [])
  assert.equal(r.truncated, false)
})

test('direction=in:只收敛入边方向的邻居与边', () => {
  const r = buildSubgraphAround('qv.part_weight', G, META, { hops: 1, direction: 'in' })
  assert.deepEqual(keysOf(r), ['qv.part_weight', 'mv.hold_pressure', 'mv.hold_time', 'pv.melt_temp'])
  assert.deepEqual(r.edges.map(e => e.id), ['r-hp-w', 'r-ht-w', 'r-mt-w'])
  assert.ok(r.edges.every(e => e.direction === 'in'))
})

test('direction=out:只保留正向跨跳边(横边与反向边都排除)', () => {
  const r = buildSubgraphAround('mv.hold_pressure', E, META, { hops: 1, direction: 'out' })
  assert.deepEqual(r.edges.map(e => e.id), ['r-hp-f', 'r-hp-mt', 'r-hp-w', 'r-hp-w-alt'])
  assert.equal(r.edges.some(e => e.id === 'r-w-hp-bound'), false)
  assert.equal(r.edges.some(e => e.id === 'r-mt-w'), false)
})

test('自环:只出现一次、方向 loop、不扩展队列', () => {
  const r = buildSubgraphAround('qv.flash_rate', E, META, { hops: 2, direction: 'both' })
  const loops = r.edges.filter(e => e.id === 'r-f-loop')
  assert.equal(loops.length, 1)
  assert.equal(loops[0]!.direction, 'loop')
  assert.equal(loops[0]!.hop, 0)
})

test('平行边(同端点不同 predicate)按 id 全部保留', () => {
  const r = buildSubgraphAround('mv.hold_pressure', E, META, { hops: 1, direction: 'both' })
  const ids = r.edges.map(e => e.id)
  assert.ok(ids.includes('r-hp-w'))
  assert.ok(ids.includes('r-hp-w-alt'))
})

test('limit 截断:节点数=limit、truncated=true、center 必在', () => {
  const r = buildSubgraphAround('mv.hold_pressure', G, META, { hops: 1, direction: 'both', limit: 2 })
  assert.equal(r.nodes.length, 2)
  assert.equal(r.truncated, true)
  assert.equal(r.nodes[0]!.key, 'mv.hold_pressure')
})

test('limit 充足:truncated=false', () => {
  const r = buildSubgraphAround('mv.hold_pressure', G, META, { hops: 1, direction: 'both', limit: 50 })
  assert.equal(r.truncated, false)
  assert.equal(r.nodes.length, 4)
})

test('kinds 过滤同时作用于遍历与输出', () => {
  const none = buildSubgraphAround('mv.hold_pressure', G, META, { hops: 1, kinds: ['precedes'] })
  assert.deepEqual(keysOf(none), ['mv.hold_pressure'])
  assert.deepEqual(none.edges, [])
  const only = buildSubgraphAround('mv.hold_pressure', G, META, { hops: 1, kinds: ['influences'] })
  assert.equal(only.edges.length, 4)
})

test('排序确定:nodes 按 (hop,key),edges 按 (hop,id)', () => {
  const r = buildSubgraphAround('mv.hold_pressure', E, META, { hops: 2, direction: 'both' })
  const nodeKeys = r.nodes.map(n => `${n.hop}:${n.key}`)
  assert.deepEqual(nodeKeys, [...nodeKeys].sort((a, b) => {
    const [ha, ka] = a.split(':')
    const [hb, kb] = b.split(':')
    return (Number(ha) - Number(hb)) || ka!.localeCompare(kb!)
  }))
  const edgeKeys = r.edges.map(e => `${e.hop}:${e.id}`)
  assert.deepEqual(edgeKeys, [...edgeKeys].sort((a, b) => {
    const [ha, ia] = a.split(':')
    const [hb, ib] = b.split(':')
    return (Number(ha) - Number(hb)) || ia!.localeCompare(ib!)
  }))
})

test('bindings 只挂在 center 上,保留状态与单位', () => {
  const r = buildSubgraphAround('mv.hold_pressure', G, META)
  assert.equal(r.center.bindings.length, 1)
  assert.equal(r.center.bindings[0]!.status, 'active')
  assert.equal(r.center.bindings[0]!.unitTarget, 'bar')
  assert.equal(r.nodes.some(n => 'bindings' in n), false)
})

test('中心实体缺失 → 404 ONTOLOGY_SUBGRAPH_ENTITY_NOT_FOUND', () => {
  assert.throws(
    () => buildSubgraphAround('missing.key', G, META),
    (e: unknown) => (e as { status?: number, code?: string }).status === 404
      && (e as { code?: string }).code === 'ONTOLOGY_SUBGRAPH_ENTITY_NOT_FOUND',
  )
})

test('参数校验:hops/direction/kinds/limit 非法 → 422 对应错误码', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ hops: 0 }, 'ONTOLOGY_SUBGRAPH_HOPS_INVALID'],
    [{ hops: 4 }, 'ONTOLOGY_SUBGRAPH_HOPS_INVALID'],
    [{ hops: 1.5 }, 'ONTOLOGY_SUBGRAPH_HOPS_INVALID'],
    [{ hops: 'abc' }, 'ONTOLOGY_SUBGRAPH_HOPS_INVALID'],
    [{ direction: 'sideways' }, 'ONTOLOGY_SUBGRAPH_DIRECTION_INVALID'],
    [{ kinds: 'not_a_kind' }, 'ONTOLOGY_SUBGRAPH_KIND_INVALID'],
    [{ kinds: '' }, 'ONTOLOGY_SUBGRAPH_KIND_INVALID'],
    [{ limit: 0 }, 'ONTOLOGY_SUBGRAPH_LIMIT_INVALID'],
    [{ limit: 201 }, 'ONTOLOGY_SUBGRAPH_LIMIT_INVALID'],
    [{ limit: 'abc' }, 'ONTOLOGY_SUBGRAPH_LIMIT_INVALID'],
  ]
  for (const [raw, code] of cases) {
    assert.throws(
      () => parseSubgraphOptions(raw),
      (e: unknown) => (e as { status?: number, code?: string }).status === 422 && (e as { code?: string }).code === code,
      `${JSON.stringify(raw)} 应抛 ${code}`,
    )
  }
})

test('parseSubgraphOptions 缺省:hops=1/direction=both/kinds=null/limit=50', () => {
  assert.deepEqual(parseSubgraphOptions({}), { hops: 1, direction: 'both', kinds: null, limit: 50 })
})

test('kinds 支持逗号分隔与去重', () => {
  const opts = parseSubgraphOptions({ kinds: 'influences, precedes,influences' })
  assert.deepEqual(opts.kinds, ['influences', 'precedes'])
})

test('BFS 不死循环:A→B→A 环', () => {
  const cyclic: SubgraphGraphData = {
    entities: [entity('a.x', 'process_variable', 'state'), entity('b.y', 'process_variable', 'state')],
    relations: [relation('r-ab', 'influences', 'a.x', 'b.y'), relation('r-ba', 'influences', 'b.y', 'a.x')],
    bindings: [],
  }
  const r = buildSubgraphAround('a.x', cyclic, META, { hops: 3, direction: 'both' })
  assert.equal(r.nodes.length, 2)
  assert.equal(r.edges.length, 2)
})

test('悬空关系(端点不存在)被跳过而非抛错', () => {
  const dangling: SubgraphGraphData = {
    entities: G.entities,
    relations: [...G.relations, relation('r-ghost', 'influences', 'mv.hold_pressure', 'ghost.key')],
    bindings: [],
  }
  const r = buildSubgraphAround('mv.hold_pressure', dangling, META, { hops: 1 })
  assert.equal(r.edges.some(e => e.id === 'r-ghost'), false)
  assert.equal(r.nodes.length, 4)
})
