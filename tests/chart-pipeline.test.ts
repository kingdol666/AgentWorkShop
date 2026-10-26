/**
 * EDA 管道前端工具单测 —— transform 沙箱/字段推断/聚合/直方图/通用 option。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { runTransform, deriveFields, aggregateRows, histogramBins, buildPipelineOption, seriesToRows } = await import('../app/utils/chart-pipeline')

const ROWS = [
  { at: '2026-10-26T01:00:00Z', line: 'A', 克重: 32.5, 飞边率: 0.02 },
  { at: '2026-10-26T01:01:00Z', line: 'A', 克重: 32.7, 飞边率: 0.03 },
  { at: '2026-10-26T01:02:00Z', line: 'B', 克重: 33.1, 飞边率: 0.05 },
  { at: '2026-10-26T01:03:00Z', line: 'B', 克重: 32.9, 飞边率: 0.04 },
]

test('runTransform:filter/聚合/异常/非数组 全收敛', async () => {
  const kept = runTransform(ROWS, 'function transform(rows) { return rows.filter(r => r.line === "A") }')
  assert.equal(kept.rows.length, 2)
  assert.equal(kept.error, '')
  const grouped = runTransform(ROWS, `function transform(rows) {
    const m = new Map()
    for (const r of rows) { const g = m.get(r.line) ?? []; g.push(r.克重); m.set(r.line, g) }
    return [...m.entries()].map(([line, vs]) => ({ line, 克重: vs.reduce((a,b)=>a+b,0)/vs.length }))
  }`)
  assert.equal(grouped.rows.length, 2)
  assert.equal(runTransform(ROWS, 'function transform(rows) { throw new Error("boom") }').error, 'Error: boom')
  assert.match(runTransform(ROWS, 'function transform(rows) { return 42 }').error, /必须返回数组/)
  assert.equal(runTransform(ROWS, '').rows.length, 4)
})

test('deriveFields:数值列判定(6 成以上数值)', async () => {
  const fs = deriveFields(ROWS)
  const at = fs.find(f => f.name === 'at')
  const weight = fs.find(f => f.name === '克重')
  assert.equal(at?.numeric, false)
  assert.equal(weight?.numeric, true)
})

test('aggregateRows:分组 avg 系列拆分与命名', async () => {
  const cfg = { xField: 'line', yFields: ['克重'], groupField: '', agg: 'avg', title: '', yMin: null, yMax: null, refLine: null }
  const { categories, series } = aggregateRows(ROWS, cfg as never)
  assert.deepEqual(categories, ['A', 'B'])
  assert.equal(series.get('克重')?.[0], 32.6)
  const cfg2 = { ...cfg, groupField: 'at' } as never
  const s2 = aggregateRows(ROWS, cfg2).series
  assert.equal(s2.size, 4)
})

test('histogramBins:计数守恒', async () => {
  const { counts } = histogramBins(ROWS, '克重', 4)
  assert.equal(counts.reduce((a, b) => a + b, 0), 4)
})

test('seriesToRows:接受 daq/query 的 {at,v} 与兼容 {x,y}', async () => {
  const t0 = Date.UTC(2026, 9, 26, 1, 0, 0)
  const rows = seriesToRows(
    [
      { nodeId: 'n1', name: 'Part Weight', points: [{ at: t0, v: 32.5 }, { at: t0 + 1000, v: 32.7 }] },
      { nodeId: 'n2', points: [{ x: new Date(t0).toISOString(), y: 0.03 }] },
      { nodeId: 'n3', name: 'bad', points: [{ at: 'not-a-date', v: 1 }, { at: t0, v: Number.NaN }] },
    ],
    s => s.name ?? s.nodeId,
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0].at, new Date(t0).toISOString())
  assert.equal(rows[0]['Part Weight'], 32.5)
  assert.equal(rows[0].n2, 0.03)
  assert.equal(rows[1]['Part Weight'], 32.7)
  assert.equal(rows[0].bad, undefined)
})

test('buildPipelineOption:line/bar/pie/histogram 形状', async () => {
  const cfg = { xField: 'line', yFields: ['克重'], groupField: '', agg: 'avg', title: 'T', yMin: null, yMax: null, refLine: 32.85 }
  const line = buildPipelineOption('line', cfg as never, ROWS)
  const lineSeries = line.series as Array<{ type: string, markLine?: { data: unknown[] } }>
  assert.equal(lineSeries[0].type, 'line')
  assert.equal(lineSeries[0].markLine?.data.length, 1)
  const bar = buildPipelineOption('bar', cfg as never, ROWS)
  assert.equal((bar.series as Array<{ type: string }>)[0].type, 'bar')
  const pie = buildPipelineOption('pie', { ...cfg, yFields: ['克重'] } as never, ROWS)
  const pieSeries = pie.series as Array<{ type: string, data: unknown[] }>
  assert.equal(pieSeries[0].type, 'pie')
  assert.equal(pieSeries[0].data.length, 4)
  const hist = buildPipelineOption('histogram', { ...cfg, yFields: ['克重'] } as never, ROWS)
  assert.equal((hist.series as Array<{ type: string }>)[0].type, 'bar')
  assert.equal((hist.xAxis as { data: string[] }).data.length, 20)
})
