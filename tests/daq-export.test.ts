// daq_export 导出核心单测:全内存注入 readPoints,验证分页拉全 / 去重排序 /
// CSV 行内容 / manifest 结构(节点映射+上下文+统计)/ 截断护栏 / 文件落盘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportDaqDataset, type ExportNodeMeta } from '../server/services/workshop/agents/industrial/daq-export'

const ROOT = mkdtempSync(join(tmpdir(), 'aw-daqexp-'))

const nodeOf = (id: string): ExportNodeMeta => ({
  id,
  name: `节点-${id}`,
  unit: '℃',
  lineId: 'line-a',
  min: 0,
  max: 100,
  warnLow: 5,
  warnHigh: 95,
  intervalMs: 1000,
  decimals: 1,
  semantics: '烘箱温度设定:升高使成膜更均匀',
})

/** 内存伪 tsdb:遵守 limit 与窗口,页大小可配(模拟适配器分页行为) */
function makeReader(all: Array<{ at: number, value: number, state?: string }>, pageSize: number) {
  return async (_nodeId: string, w: { fromMs: number, toMs: number, limit: number }) => {
    const cap = Math.min(w.limit, pageSize)
    return all.filter(p => p.at >= w.fromMs && p.at <= w.toMs).slice(0, cap)
  }
}

test('daq_export:跨页拉全(12000 点 3 页)不丢不重,CSV 与 manifest 落盘正确', async () => {
  const t0 = 1_700_000_000_000
  const all = Array.from({ length: 12_000 }, (_, i) => ({
    at: t0 + i * 1000,
    value: 50 + Math.sin(i / 50) * 10,
    state: i === 100 ? 'alarm' : 'ok',
  }))
  const r = await exportDaqDataset({
    targets: ['n1'],
    nodeOf,
    readPoints: makeReader(all, 5000),
    fromMs: t0 - 1,
    toMs: t0 + 12_000 * 1000,
    title: '单元测试数据集',
    note: '验证分页拉全',
    lines: [{ lineId: 'line-a', lineName: '示范产线', description: '测试线', runId: 'run-1', recipeId: 'rcp-1', recipeName: '配方A', recipeVersion: 3, daqWindows: [{ nodeId: 'n1', min: 40, max: 60 }] }],
    rootDir: ROOT,
    now: () => t0,
  })
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0]!.rows, 12_000)
  assert.equal(r.totalRows, 12_000)
  assert.ok(r.exportId.startsWith('daqexp-'))

  const csv = readFileSync(join(r.dir, 'nodes', 'n1.csv'), 'utf8')
  const lines = csv.split('\r\n')
  assert.equal(lines[0], 'ts_iso,ts_ms,value,state')
  assert.equal(lines.length, 12_001) // 表头 + 12000 行
  const first = lines[1]!.split(',')
  assert.equal(Number(first[1]), t0)
  assert.equal(first[3], 'ok')
  const alarmLine = lines.find(l => l.endsWith(',alarm'))
  assert.ok(alarmLine, 'alarm 行在 CSV 中')
  // 排序严格递增(无重复时间戳)
  const tsCol = lines.slice(1).map(l => Number(l.split(',')[1]))
  for (let i = 1; i < tsCol.length; i++) assert.ok(tsCol[i]! > tsCol[i - 1]!, '时间戳严格递增')

  const manifest = JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'aw.daq-export/1')
  assert.equal(manifest.export_id, r.exportId)
  assert.equal(manifest.title, '单元测试数据集')
  assert.equal(manifest.note, '验证分页拉全')
  assert.equal(manifest.nodes.length, 1)
  const mn = manifest.nodes[0]
  assert.equal(mn.id, 'n1')
  assert.equal(mn.unit, '℃')
  assert.equal(mn.range.min, 0)
  assert.equal(mn.semantics.includes('烘箱温度设定'), true)
  assert.equal(mn.rows, 12_000)
  assert.equal(mn.state_summary.alarm, 1)
  assert.equal(mn.state_summary.ok, 11_999)
  assert.ok(mn.value_range_observed.max > 55)
  assert.equal(manifest.lines[0].recipeName, '配方A')
  assert.equal(manifest.lines[0].daqWindows[0].max, 60)
  assert.equal(manifest.totals.rows, 12_000)
  assert.deepEqual(manifest.truncated_nodes, [])
  assert.ok(String(manifest.usage).includes('diag_run'))
})

test('daq_export:未知节点跳过;截断护栏命中时标注 truncated_nodes 且行数受限', async () => {
  const t0 = 1_700_000_000_000
  // 永远满页返回同一段 → 触发页数上限(注入小上限)
  let calls = 0
  const endless = async (_id: string, w: { limit: number }) => {
    calls++
    return Array.from({ length: w.limit }, (_, i) => ({ at: w.fromMs + i, value: 1 }))
  }
  const r = await exportDaqDataset({
    targets: ['n1', 'ghost'],
    nodeOf: id => (id === 'n1' ? nodeOf(id) : undefined),
    readPoints: endless,
    fromMs: t0,
    toMs: t0 + 100_000,
    rootDir: ROOT,
    now: () => t0,
    caps: { pagesPerNode: 3, totalRows: 1_000_000 },
  })
  assert.equal(r.files.length, 1) // ghost 无元数据被跳过
  assert.deepEqual(r.truncated, ['n1'])
  assert.ok(calls <= 4) // 3 页拉满即停
  const manifest = JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.truncated_nodes, ['n1'])
})

test('daq_export:空窗口导出仍产出 manifest(0 节点行)且不抛', async () => {
  const t0 = 1_700_000_000_000
  const r = await exportDaqDataset({
    targets: ['n1'],
    nodeOf,
    readPoints: makeReader([], 5000),
    fromMs: t0,
    toMs: t0 + 1000,
    rootDir: ROOT,
    now: () => t0,
  })
  assert.equal(r.files[0]!.rows, 0)
  const manifest = JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.totals.rows, 0)
  assert.equal(existsSync(join(r.dir, 'nodes', 'n1.csv')), true)
})

test('清理临时目录', () => {
  rmSync(ROOT, { recursive: true, force: true })
})
