// mes-rest 写驱动单测:本地 node:http(127.0.0.1 随机端口)模拟 MES,
// 覆盖 读提取 / 写 ack / MES 侧量程拒绝 / cursor 分页历史 / SSRF 内网防护 / 协议白名单 / test() 试读。
// 全程只打本测试自起的随机端口服务,绝不触真实 MES;allowPrivateHost 记得传 'true'(表单值为字符串)。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mesRestDcwDriver } from '../server/services/workshop/dcw/drivers/mes-rest'

// ── mock MES(读 /current、写 /params/{name}/setpoint、历史 /history cursor 分页) ──

let server: Server
let base = '' // http://127.0.0.1:<随机端口>
const writes: Array<{ url: string, body: { value?: number } }> = []

before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock')
      const reply = (code: number, data: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      // 当前值:{data:{value:42.5, ts:<epoch_ms>}}
      if (url.pathname === '/current' || /^\/params\/[^/]+\/current$/.test(url.pathname)) {
        return reply(200, { data: { value: 42.5, ts: Date.now() } })
      }
      // 写:value ≤ 100 受理(201 + ack),超 MES 侧量程 → 400
      if (/^\/params\/[^/]+\/setpoint$/.test(url.pathname) && req.method === 'POST') {
        const body = JSON.parse(raw || '{}') as { value?: number }
        writes.push({ url: req.url ?? '', body })
        if (typeof body.value !== 'number' || !Number.isFinite(body.value)) return reply(400, { error: 'bad value' })
        if (body.value > 100) return reply(400, { error: 'out of range', limit: 100 })
        return reply(201, { ack: true, applied: body.value })
      }
      // 历史:cursor 分页(第 1 页 3 行 nextCursor='p2';第 2 页 2 行 nextCursor=null)
      if (url.pathname === '/history') {
        const t = Date.now()
        if (!url.searchParams.get('cursor')) {
          return reply(200, { data: { rows: [{ v: 1, ts: t }, { v: 2, ts: t + 1000 }, { v: 3, ts: t + 2000 }], nextCursor: 'p2' } })
        }
        if (url.searchParams.get('cursor') === 'p2') {
          return reply(200, { data: { rows: [{ v: 4, ts: t + 3000 }, { v: 5, ts: t + 4000 }], nextCursor: null } })
        }
        return reply(400, { error: 'bad cursor' })
      }
      return reply(404, { error: `no route: ${req.method} ${req.url}` })
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>(r => server.close(() => r()))
})

// ── driverConfig 组装(映射为 text 字段:JSON 字符串) ──

const READ_MAP = JSON.stringify({
  path: '/params/{name}/current',
  query: { name: 'TEMP_SP' },
  response: { valuePath: 'data.value', tsPath: 'data.ts', tsFormat: 'epoch_ms' },
})
const WRITE_MAP = JSON.stringify({
  method: 'POST',
  path: '/params/{name}/setpoint',
  query: { name: 'TEMP_SP' },
  bodyTemplate: { value: '{{value}}' },
  successOn: [200, 201],
  response: { ackPath: 'ack' },
})
const HISTORY_MAP = JSON.stringify({
  path: '/history',
  query: { name: 'TEMP_SP' },
  response: { rowsPath: 'data.rows[*]', valuePath: 'v', tsPath: 'ts', nextCursorPath: 'data.nextCursor' },
  pageSize: 3,
})

function cfg(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { baseUrl: base, allowPrivateHost: 'true', writeMap: WRITE_MAP, historyMap: HISTORY_MAP, ...extra }
}

function writeInput(eng: number, tolerance = 0.5) {
  return { eng, tolerance, domain: { min: 0, max: 100 }, driverConfig: cfg({ readMap: READ_MAP }) }
}

// ── 用例 ──

test('mes-rest read: valuePath 提取 42.5,消息携带 ts', async () => {
  const r = await mesRestDcwDriver.read!({ domain: { min: 0, max: 100 }, driverConfig: cfg({ readMap: READ_MAP }) })
  assert.equal(r.ok, true)
  assert.equal(r.eng, 42.5)
  assert.equal(r.raw, 42.5)
  assert.match(r.message, /MES 读数 42\.5,ts=\d{4}-\d{2}-\d{2}T/)
})

test('mes-rest write: 2xx + ackPath 真值 → ok;{name} 占位符与 {{value}} 插值正确', async () => {
  const n0 = writes.length
  const input = { ...writeInput(88.5), driverConfig: cfg() } // 无 readMap → 以 ack 为准
  const r = await mesRestDcwDriver.write(input)
  assert.equal(r.ok, true)
  assert.equal(r.readback, null)
  assert.match(r.message, /无回读映射,以 MES ack 为准/)
  assert.equal(writes.length, n0 + 1)
  const hit = writes[writes.length - 1]!
  assert.equal(hit.body.value, 88.5) // {{value}} → 工程值(number 直出)
  assert.match(hit.url, /^\/params\/TEMP_SP\/setpoint/) // {name} 从 query 注入且不再进查询串
})

test('mes-rest write: 超 MES 侧量程(HTTP 400)→ ok=false 且状态分类文案', async () => {
  const r = await mesRestDcwDriver.write(writeInput(120))
  assert.equal(r.ok, false)
  assert.match(r.message, /HTTP 400/)
  assert.equal(r.readback, null)
})

test('mes-rest fetchHistory: cursor 分页 2 页共 5 行,complete=true', async () => {
  const batches: Array<Array<{ ts: string, value: number }>> = []
  const r = await mesRestDcwDriver.fetchHistory!({
    driverConfig: cfg(),
    fromIso: '2026-01-01T00:00:00.000Z',
    toIso: '2026-01-01T01:00:00.000Z',
    maxRows: 100,
    onRows: (rows) => { batches.push(rows) },
  })
  assert.equal(r.rows, 5)
  assert.equal(r.complete, true)
  const all = batches.flat()
  assert.deepEqual(all.map(x => x.value), [1, 2, 3, 4, 5])
  for (const row of all) assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/)
})

test('mes-rest: 未开 allowPrivateHost 访问 127.0.0.1 → 拒绝且文案含 allowPrivateHost', async () => {
  await assert.rejects(
    () => mesRestDcwDriver.write({ ...writeInput(50), driverConfig: cfg({ allowPrivateHost: 'false' }) }),
    /allowPrivateHost/,
  )
})

test('mes-rest: baseUrl ftp:// → 拒绝(仅 http/https)', async () => {
  await assert.rejects(
    () => mesRestDcwDriver.write({ ...writeInput(50), driverConfig: cfg({ baseUrl: 'ftp://mes.example.com' }) }),
    /http\/https/,
  )
})

test('mes-rest test: 试读 42.5 返回 ok 与耗时', async () => {
  const r = await mesRestDcwDriver.test(cfg({ readMap: READ_MAP }))
  assert.equal(r.ok, true)
  assert.match(r.message, /试读 42\.5 \(\d+ms\)/)
})
