/**
 * TSDB 查询契约单测(2026-10-07 区间取数轮回归锁):
 *   - query()(raw 与 bucket 两条路径)必须返回**时间正序(ASC)** —— 与 queryTagged 同契约。
 *     病根:两适配器曾 ORDER BY ts DESC,消费方(daq_query 最新/最近序列、daq_export
 *     lastAt+1 游标续页、AML 预测 grid.slice(-H))全按升序假设 —— 降序下「最新」实为
 *     窗口最旧桶、导出超 5000 行静默截断(只留最新段)、AML 喂过期历史(实测取证见
 *     docs/audit/2026-10-07-mes-range-tsdb-acquisition-report.md)。
 *   - daq_export 分页在 >5000 样本窗口必须取全(游标续页依赖升序)。
 * 夹具:AW_HOME 指临时目录,SqliteTimeSeriesAdapter 真库真查;导出核心注入 readPoints。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tsdb-order-test-'))
delete process.env.AW_BENCH_MODE

const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
const { exportDaqDataset } = await import('../server/services/workshop/agents/industrial/daq-export')
const { mkdirSync, readFileSync } = await import('node:fs')

test('契约:query() raw 路径时间正序(ASC),窗口超 limit 截取最旧段', async () => {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  const base = 1_700_000_000_000
  const rows = Array.from({ length: 12 }, (_, i) => ({ nodeId: 'n-ord', tsMs: base + i * 1000, value: i, state: 'ok' }))
  await a.writeSamples(rows)
  const pts = await a.query('n-ord', { fromMs: base - 1, toMs: base + 60_000, limit: 5 })
  assert.equal(pts.length, 5)
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i]!.at > pts[i - 1]!.at, '必须严格递增')
  assert.equal(pts[0]!.value, 0, '窗口最旧段在前(limit 截断取最旧)')
  assert.equal(pts[4]!.value, 4)
})

test('契约:query() bucket 路径时间正序(ASC)', async () => {
  const a = new SqliteTimeSeriesAdapter()
  await a.init()
  const base = 1_700_000_000_000
  const rows = Array.from({ length: 10 }, (_, i) => ({ nodeId: 'n-bkt', tsMs: base + i * 1000, value: i, state: 'ok' }))
  await a.writeSamples(rows)
  const pts = await a.query('n-bkt', { fromMs: base - 1, toMs: base + 60_000, bucketMs: 2000, limit: 100 })
  assert.equal(pts.length, 5)
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i]!.at > pts[i - 1]!.at, '桶必须严格递增')
  assert.equal(pts[0]!.cnt, 2, '2s 桶含 2 个 1s 样本')
})

test('导出:>5000 样本窗口游标续页取全(CSV 行数 == 样本数,不静默截断)', async () => {
  const total = 5300
  const base = 1_700_000_000_000
  const readPoints = async (_id: string, win: { fromMs: number, toMs: number, limit: number }) => {
    // 模拟升序适配器:返回 [fromMs, toMs] 内前 limit 个 1s 样本
    const first = Math.max(win.fromMs, base)
    const out: Array<{ at: number, value?: number, state?: string }> = []
    for (let t = first; t <= Math.min(win.toMs, base + (total - 1) * 1000) && out.length < win.limit; t += 1000) {
      out.push({ at: t, value: (t - base) / 1000, state: 'ok' })
    }
    return out
  }
  const dir = join(process.env.AW_HOME!, 'export-test')
  mkdirSync(dir, { recursive: true })
  const r = await exportDaqDataset({
    targets: ['n-big'],
    nodeOf: id => ({ id, name: id, unit: 'x', lineId: 'ln-x' }),
    readPoints,
    fromMs: base - 1,
    toMs: base + total * 1000,
    rootDir: dir,
  })
  assert.equal(r.totalRows, total, `导出应取全 ${total} 行`)
  const csv = readFileSync(join(r.dir, r.files[0]!.file), 'utf8').trim().split(/\r?\n/)
  assert.equal(csv.length - 1, total)
  assert.deepEqual(r.truncated, [], '不得标记截断')
})
