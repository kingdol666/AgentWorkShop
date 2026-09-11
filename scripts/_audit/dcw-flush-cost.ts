/**
 * 审计实验 4 —— DCW 落盘放大成本(只读:仅读真实 data/*.json,写入 scripts/_audit/.tmp)。
 *
 * 运行:node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-flush-cost.ts
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { saveJsonFileAtomic } from '../../server/services/workshop/json-store.mjs'

const TMP = new URL('./.tmp/', import.meta.url).pathname.replace(/^\//, '')
mkdirSync(TMP, { recursive: true })

const rows = (f: string): unknown => JSON.parse(readFileSync(`server/data/${f}`, 'utf-8'))

const nodes = rows('dcws.json') as Array<Record<string, unknown>>
const writes = rows('dcw-writes.json') as Array<Record<string, unknown>>

function bench(label: string, data: unknown, target: string, iters: number): void {
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) saveJsonFileAtomic(target, data)
  const dt = performance.now() - t0
  const size = statSync(target).size
  // JSON.stringify 单独计量(纯 CPU,事件循环阻塞部分)
  const t1 = performance.now()
  for (let i = 0; i < iters; i++) JSON.stringify(data, null, 2)
  const ds = performance.now() - t1
  console.log(
    `  ${label}: flushNow 全量落盘 per-op=${(dt / iters).toFixed(1)}ms`
    + ` (其中 JSON.stringify(pretty) ${(ds / iters).toFixed(1)}ms), 文件=${(size / 1024).toFixed(1)}KB,`
    + ` iters=${iters}`,
  )
  console.log(`    记录数=${Array.isArray(data) ? data.length : Object.keys(data as object).length}`)
}

console.log('=== 真实数据规模下的落盘成本(与生产 server/data/*.json 同形) ===')
bench('dcws.json(节点快照;每次写值/读值后防抖落盘 dcw-controller.ts:179,235)', nodes, `${TMP}/dcws.json`, 20)
bench('dcw-writes.json(写历史;每次下发后防抖落盘 dcw-controller.ts:193)', writes, `${TMP}/dcw-writes.json`, 20)

const readInt = nodes.map(n => Number(n.readIntervalMs)).filter(v => Number.isFinite(v) && v > 0)
const perSec = readInt.reduce((a, v) => a + (1000 / v), 0)
console.log('\n=== 生产规模推算 ===')
console.log(`  配置了周期读的节点=${readInt.length},合计周期读频率=${perSec.toFixed(1)} 次/秒`)
console.log(`  每次周期读 executeRead 尾部调用 repo.flushDebounced()(dcw-controller.ts:235)`)
console.log(`  防抖窗 1.5s(dcw-node.repo.ts:60-66)→ 稳态下 dcws.json 全量重写≈每 1.5s 一次`)
