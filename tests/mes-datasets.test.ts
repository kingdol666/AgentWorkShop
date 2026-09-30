/**
 * MES CSV 数据集面单测(不联网):
 *   - 建表生效(SCHEMA_SQL 启动建出 mes_datasets / mes_fetch_jobs)
 *   - CSV 写入/RFC4180 转义/sha256/读回 roundtrip
 *   - stats 正确性(count/min/max/mean/stddev/首末 ts)
 *   - 失败路径(驱动抛错 → job/dataset 双 failed)
 *   - 重启遗留 running → 查询侧呈现 failed
 *   - 护栏(注入假 driver + 假节点/绑线):窗口>7d 拒、maxRows>5000 拒、
 *     授权过滤、频次限流(每 60s ≤6 次)、>2000 行走异步数据集
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import {
  createMesDatasetStore,
  csvEscapeField,
  parseCsvLine,
  type DcwFetchHistoryInput,
  type DcwFetchHistoryResult,
  type DcwHistoryRow,
  type MesCreateFetchJobInput,
  type MesHistoryDriver,
} from '../server/services/workshop/mes/mes-datasets'
import {
  createMesController,
  mesFetchRateCheck,
  mesFetchRateReset,
  MES_WINDOW_MAX_MS,
  MES_MAX_ROWS_CAP,
} from '../server/services/workshop/mes/mes-controller'
import type { MesNodeLike } from '../server/services/workshop/mes/mes-controller'

/** 轮询直至断言成立(异步取数为进程内 fire-and-forget) */
async function until<T>(fn: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v != null && v !== false) return v
    if (Date.now() - start > timeoutMs) throw new Error('轮询超时:异步取数未收敛')
    await new Promise(r => setTimeout(r, 10))
  }
}

/** 假 mes-rest 驱动(注入用;rows 一次性吐给 onRows,可配延迟/抛错/超发) */
function fakeDriver(rows: DcwHistoryRow[], opts: {
  delayMs?: number
  throwError?: string
  overshoot?: boolean // 发送超过 maxRows 的行数(测截断保护)
} = {}): MesHistoryDriver {
  return {
    kind: 'mes-rest',
    available: async () => true,
    write: async () => ({ ok: false, message: '测试驱动不写', raw: null, readback: null }),
    test: async () => ({ ok: true, message: 'ok' }),
    read: async () => ({ ok: true, message: 'ok', eng: 42.5, raw: 425 }),
    fetchHistory: async (input: DcwFetchHistoryInput): Promise<DcwFetchHistoryResult> => {
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      if (opts.throwError) throw new Error(opts.throwError)
      const cap = opts.overshoot ? input.maxRows + 50 : input.maxRows
      const batch = rows.slice(0, cap)
      await input.onRows(batch)
      return { rows: batch.length, complete: !opts.overshoot }
    },
  }
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mes-ds-test-'))
}

test('schema: mes_datasets / mes_fetch_jobs 随 SCHEMA_SQL 启动建出', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name)
    assert.ok(names.includes('mes_datasets'), 'mes_datasets 表必须建出')
    assert.ok(names.includes('mes_fetch_jobs'), 'mes_fetch_jobs 表必须建出')
  }
  finally { db.close() }
})

test('csv 原语:RFC4180 转义与解析 roundtrip', () => {
  assert.equal(csvEscapeField('plain'), 'plain')
  assert.equal(csvEscapeField('a,b'), '"a,b"')
  assert.equal(csvEscapeField('say "hi"'), '"say ""hi"""')
  assert.equal(csvEscapeField('line\r\nbreak'), '"line\r\nbreak"')
  // 转义后逐行解析还原
  const line = `${csvEscapeField('2026-09-29T00:00:00Z')},${csvEscapeField('a "x", y')}`
  assert.deepEqual(parseCsvLine(line), ['2026-09-29T00:00:00Z', 'a "x", y'])
})

test('roundtrip:CSV 写入/转义/sha256/读回(head/stats/rows 分页)', async () => {
  const dir = tmpDir()
  const db = openWorkshopDb(':memory:')
  try {
    // ts 含逗号/引号样本,验证转义;数值覆盖小数
    const rows: DcwHistoryRow[] = [
      { ts: '2026-09-29T00:00:00Z', value: 1.5 },
      { ts: '2026-09-29T00:01:00Z', value: 2.5 },
      { ts: 'a,b "ts"', value: 3 },
      { ts: '2026-09-29T00:03:00Z', value: 4.5 },
    ]
    const store = createMesDatasetStore(db, dir, { resolveDriver: () => fakeDriver(rows, { delayMs: 5 }) })
    const { jobId, datasetId } = store.createFetchJob({
      nodeId: 'node-1', fromIso: '2026-09-29T00:00:00Z', toIso: '2026-09-29T01:00:00Z',
      maxRows: 100, agentId: 'agent-a', lineId: 'line-1', nodeName: '反应釜温度',
    })
    const job = await until(() => {
      const j = store.jobStatus(jobId)
      return j && j.status !== 'running' ? j : null
    })
    assert.equal(job.status, 'done')
    assert.equal(job.rows, rows.length)

    const meta = store.datasetMeta(datasetId)
    assert.ok(meta, 'dataset 元数据必须存在')
    assert.equal(meta!.status, 'ready')
    assert.equal(meta!.rows, rows.length)
    // sha256 与文件字节一致(独立重算)
    const fileBytes = readFileSync(meta!.filePath)
    assert.equal(meta!.sha256, createHash('sha256').update(fileBytes).digest('hex'))
    // CSV 原文逐字节:表头 + CRLF 行(含转义样本)
    const expected = 'ts,value\r\n'
      + '2026-09-29T00:00:00Z,1.5\r\n'
      + '2026-09-29T00:01:00Z,2.5\r\n'
      + '"a,b ""ts""",3\r\n'
      + '2026-09-29T00:03:00Z,4.5\r\n'
    assert.equal(fileBytes.toString('utf8'), expected)

    // head:列名 + 总行数 + 前 5 行预览
    const head = store.readDataset(datasetId, 'head')
    assert.deepEqual(head.head.columns, ['ts', 'value'])
    assert.equal(head.head.totalRows, 4)
    assert.equal(head.head.preview.length, 4)

    // stats:count/min/max/mean/stddev(采样 n-1)/首末 ts
    const stats = store.readDataset(datasetId, 'stats').stats
    assert.equal(stats.count, 4)
    assert.equal(stats.min, 1.5)
    assert.equal(stats.max, 4.5)
    assert.equal(stats.mean, 2.875)
    // 样本方差 = ((1.5-2.875)² + (2.5-2.875)² + (3-2.875)² + (4.5-2.875)²) / 3 = 4.6875/3
    assert.ok(Math.abs(stats.stddev! - 1.25) < 1e-9, `stddev=${stats.stddev}`)
    assert.equal(stats.firstTs, '2026-09-29T00:00:00Z')
    assert.equal(stats.lastTs, '2026-09-29T00:03:00Z')

    // rows 分页:offset 起 20 行
    const page = store.readDataset(datasetId, 'rows', 2).rowsView
    assert.equal(page.offset, 2)
    assert.equal(page.total, 4)
    assert.equal(page.rows.length, 2)
    assert.deepEqual(page.rows[0], ['a,b "ts"', '3'])
    // 清单含该数据集
    assert.ok(store.listDatasets(10).some(d => d.id === datasetId))
  }
  finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('截断保护:驱动超发也被 maxRows 封顶', async () => {
  const dir = tmpDir()
  const db = openWorkshopDb(':memory:')
  try {
    const rows: DcwHistoryRow[] = Array.from({ length: 30 }, (_, i) => ({ ts: `2026-09-29T00:${String(i % 60).padStart(2, '0')}:00Z`, value: i }))
    const store = createMesDatasetStore(db, dir, { resolveDriver: () => fakeDriver(rows, { overshoot: true }) })
    const { jobId } = store.createFetchJob({ nodeId: 'n', maxRows: 10, agentId: 'a' })
    const job = await until(() => {
      const j = store.jobStatus(jobId)
      return j && j.status !== 'running' ? j : null
    })
    assert.equal(job.status, 'done')
    assert.equal(job.rows, 10, '落盘行数必须被 maxRows 截断')
  }
  finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('失败路径:驱动抛错 → job=failed + dataset=failed + error', async () => {
  const dir = tmpDir()
  const db = openWorkshopDb(':memory:')
  try {
    const store = createMesDatasetStore(db, dir, { resolveDriver: () => fakeDriver([], { throwError: 'MES 连接超时' }) })
    const { jobId, datasetId } = store.createFetchJob({ nodeId: 'n', fromIso: 'a', toIso: 'b', maxRows: 10, agentId: 'a' })
    const job = await until(() => {
      const j = store.jobStatus(jobId)
      return j && j.status !== 'running' ? j : null
    })
    assert.equal(job.status, 'failed')
    assert.ok(job.error.includes('MES 连接超时'))
    const meta = await until(() => {
      const m = store.datasetMeta(datasetId)
      return m && m.status === 'failed' ? m : null
    })
    assert.ok(meta.error.includes('MES 连接超时'))
  }
  finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重启遗留 running 账本 → 查询侧呈现 failed(不自动续跑)', () => {
  const dir = tmpDir()
  const db = openWorkshopDb(':memory:')
  try {
    const store = createMesDatasetStore(db, dir, { resolveDriver: () => fakeDriver([]) })
    // 手工插入上一进程的 running 账本(createdAt 早于本进程 bootedAt)
    db.prepare(`INSERT INTO mes_fetch_jobs (id, dataset_id, agent_id, status, rows, error, created_at, updated_at)
      VALUES ('j-old', 'd-old', 'a', 'running', 0, '', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`).run()
    db.prepare(`INSERT INTO mes_datasets (id, line_id, node_id, node_name, from_ts, to_ts, rows, sha256, file_path, status, error, created_by, created_at)
      VALUES ('d-old', '', 'n', '', NULL, NULL, 0, '', ?, 'running', '', 'a', '2020-01-01T00:00:00.000Z')`).run(join(dir, 'd-old.csv'))
    assert.equal(store.jobStatus('j-old')!.status, 'failed')
    assert.equal(store.datasetMeta('d-old')!.status, 'failed')
  }
  finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================
// 护栏单测(注入假 driver/节点/绑线,不联网)
// ============================================================

function guardDeps(opts: {
  storeCalls?: Array<Record<string, unknown>>
  now?: { ms: number }
  driver?: MesHistoryDriver
}) {
  const nodes: MesNodeLike[] = [
    { id: 'node-1', name: '反应釜温度', driver: 'mes-rest', lineId: 'line-1', unit: '℃', min: 0, max: 200, enabled: true, driverConfig: { desc: '釜内温度', readMap: 'TIC101', writeMap: 'TIC101.SV', historyMap: 'h1' } },
    { id: 'node-2', name: '邻线点位', driver: 'mes-rest', lineId: 'line-2', unit: 'kPa', min: 0, max: 10, enabled: true, driverConfig: {} },
    { id: 'node-3', name: '普通数控', driver: 'modbus-tcp', lineId: 'line-1', unit: '℃', min: 0, max: 100, enabled: true, driverConfig: {} },
  ]
  return {
    store: {
      createFetchJob: (input: MesCreateFetchJobInput) => {
        opts.storeCalls!.push(input as unknown as Record<string, unknown>)
        return { jobId: `mesjob-${opts.storeCalls!.length}`, datasetId: `mesds-${opts.storeCalls!.length}` }
      },
    },
    nodes: () => nodes,
    boundNodeIds: (agentId: string) => new Set(agentId === 'agent-a' ? ['node-1'] : []),
    resolveDriver: () => opts.driver ?? fakeDriver([]),
    nowMs: () => {
      opts.now!.ms += 1000
      return opts.now!.ms
    },
  }
}

const T0 = Date.parse('2026-09-29T00:00:00Z')

test('护栏:窗口 > 7 天被拒 / from-to 必须成对 / maxRows > 5000 被拒', async () => {
  mesFetchRateReset()
  const now = { ms: T0 }
  const ctl = createMesController(guardDeps({ storeCalls: [], now }))

  // 窗口 8 天 > 7 天上限
  const r8d = await ctl.fetch('agent-a', { ids: ['node-1'], from: new Date(T0).toISOString(), to: new Date(T0 + MES_WINDOW_MAX_MS + 3_600_000).toISOString(), max_rows: 100 })
  assert.equal(r8d.isError, true)
  assert.ok(r8d.text.includes('7 天'))

  // 窗口恰好 7 天:护栏放行(进入内联模式)
  const r7d = await ctl.fetch('agent-a', { ids: ['node-1'], from: new Date(T0).toISOString(), to: new Date(T0 + MES_WINDOW_MAX_MS).toISOString(), max_rows: 100 })
  assert.equal(r7d.isError, undefined)

  // from/to 不成对
  const rpair = await ctl.fetch('agent-a', { ids: ['node-1'], from: new Date(T0).toISOString() })
  assert.equal(rpair.isError, true)
  assert.ok(rpair.text.includes('成对'))

  // maxRows 超硬上限
  const rRows = await ctl.fetch('agent-a', { ids: ['node-1'], from: new Date(T0).toISOString(), to: new Date(T0 + 3_600_000).toISOString(), max_rows: MES_MAX_ROWS_CAP + 1 })
  assert.equal(rRows.isError, true)
  assert.ok(rRows.text.includes('5000'))
})

test('护栏:授权过滤 —— ids 必须是调用者可见(绑线)的 mes-rest 节点', async () => {
  mesFetchRateReset()
  const now = { ms: T0 }
  const ctl = createMesController(guardDeps({ storeCalls: [], now }))

  const rUnbound = await ctl.fetch('agent-a', { ids: ['node-2'] }) // mes-rest 但未绑定
  assert.equal(rUnbound.isError, true)
  assert.ok(rUnbound.text.includes('无权'))

  const rNotMes = await ctl.fetch('agent-a', { ids: ['node-3'] }) // 绑定线内但非 mes-rest
  assert.equal(rNotMes.isError, true)
  assert.ok(rNotMes.text.includes('mes-rest'))

  const rNone = await ctl.fetch('agent-b', { ids: ['node-1'] }) // 完全无绑线
  assert.equal(rNone.isError, true)

  const rEmpty = await ctl.fetch('agent-a', { ids: [] })
  assert.equal(rEmpty.isError, true)
})

test('护栏:频次限流 —— 每 60s 第 7 次被拒,窗口滑过后恢复', async () => {
  mesFetchRateReset()
  assert.equal(mesFetchRateCheck('agent-x', 1000), true)
  for (let i = 1; i < 6; i++) assert.equal(mesFetchRateCheck('agent-x', 1000 + i * 1000), true, `第 ${i + 1} 次应放行`)
  assert.equal(mesFetchRateCheck('agent-x', 7000), false, '第 7 次必须被限流')
  // 60s 窗口滑过(首次时间戳 1000 出窗)
  assert.equal(mesFetchRateCheck('agent-x', 61_000 + 1000), true, '窗口滑过后应恢复')

  // 控制器级:连续 6 次放行,第 7 次拒
  mesFetchRateReset()
  const now = { ms: T0 }
  const ctl = createMesController(guardDeps({ storeCalls: [], now }))
  for (let i = 0; i < 6; i++) {
    const r = await ctl.fetch('agent-a', { ids: ['node-1'] })
    assert.equal(r.isError, undefined, `第 ${i + 1} 次快照应放行`)
  }
  const r7 = await ctl.fetch('agent-a', { ids: ['node-1'] })
  assert.equal(r7.isError, true)
  assert.ok(r7.text.includes('频繁'))
})

test('取数模式:无 from/to=快照;≤2000 行=内联统计;>2000 行=异步数据集', async () => {
  mesFetchRateReset()
  const now = { ms: T0 }
  const storeCalls: Array<Record<string, unknown>> = []
  const rows: DcwHistoryRow[] = Array.from({ length: 10 }, (_, i) => ({ ts: new Date(T0 + i * 60_000).toISOString(), value: 20 + i }))
  const ctl = createMesController(guardDeps({ storeCalls, now, driver: fakeDriver(rows) }))

  // 快照:内联直读当前值
  const snap = await ctl.fetch('agent-a', { ids: ['node-1'] })
  assert.equal(snap.mode, 'snapshot')
  assert.ok(snap.text.includes('42.5'))
  assert.equal(storeCalls.length, 0, '快照不落数据集')

  // 内联:统计 + ≤3 行采样,原文不进 text
  const inline = await ctl.fetch('agent-a', { ids: ['node-1'], from: new Date(T0).toISOString(), to: new Date(T0 + 3_600_000).toISOString(), max_rows: 100 })
  assert.equal(inline.mode, 'inline')
  assert.ok(inline.text.includes('mean'))
  const sampleCount = (inline.text.match(/^\s+采样/m) ?? [''])[0] ? (inline.text.split('采样')[1]?.split('|').length ?? 0) : 0
  assert.ok(sampleCount <= 3, `采样不得超过 3 行,实际 ${sampleCount}`)
  assert.ok(!inline.text.includes('2026-09-29T00:05'), '采样之外的行级原文不得进入 text')
  assert.equal(inline.data?.stats?.[0]?.stats.count, 10)
  assert.equal(storeCalls.length, 0, '内联模式不落数据集')

  // 异步:>2000 行 → createFetchJob,回 job_id/dataset_id
  const async1 = await ctl.fetch('agent-a', { ids: ['node-1'], from: new Date(T0).toISOString(), to: new Date(T0 + 3_600_000).toISOString(), max_rows: 3000 })
  assert.equal(async1.mode, 'async')
  assert.equal(async1.data?.dataset_ids?.length, 1)
  assert.ok(async1.text.includes('mes_datasets'))
  assert.ok(async1.text.includes('勿轮询'))
  assert.equal(storeCalls.length, 1)
  assert.equal(storeCalls[0]!.maxRows, 3000)
  assert.equal(storeCalls[0]!.nodeId, 'node-1')
  assert.equal(storeCalls[0]!.agentId, 'agent-a')
})

test('目录:只列 mes-rest 节点,q/line_id 过滤 + 语义面完整', async () => {
  const now = { ms: T0 }
  const ctl = createMesController(guardDeps({ storeCalls: [], now }))
  const all = await ctl.catalog({})
  assert.equal(all.total, 2)
  const e1 = all.entries.find(e => e.id === 'node-1')!
  assert.equal(e1.name, '反应釜温度')
  assert.equal(e1.unit, '℃')
  assert.equal(e1.min, 0)
  assert.equal(e1.max, 200)
  assert.equal(e1.desc, '釜内温度')
  assert.equal(e1.readable, true)
  assert.equal(e1.writable, true)
  assert.equal(e1.historyable, true)
  assert.ok(!all.entries.some(e => e.id === 'node-3'), '非 mes-rest 节点不得入目录')

  const byLine = await ctl.catalog({ line_id: 'line-2' })
  assert.deepEqual(byLine.entries.map(e => e.id), ['node-2'])

  const byQ = await ctl.catalog({ q: '反应釜' })
  assert.deepEqual(byQ.entries.map(e => e.id), ['node-1'])

  const byDesc = await ctl.catalog({ q: '釜内温度' }) // desc 子串也命中
  assert.deepEqual(byDesc.entries.map(e => e.id), ['node-1'])
})
