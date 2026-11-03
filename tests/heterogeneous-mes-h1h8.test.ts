/**
 * H1–H8(2026-11-03)单测:多源异构数据 & MES 接入面的纯函数/注入面。
 *
 * 覆盖:
 *  - H2 节点级 sink 覆盖(向量网格按点位可配)+ 配置期校验;
 *  - H3 导出环境/工况列(opt-in,默认列契约不变);
 *  - H5 MES 图像帧归档到对象存储 + daq_frames(统一帧检索面);
 *  - H1 MES 历史 → TSDB 桥(批次打标/幂等/批次窗外/向量重采样/图像归档/全局开关);
 *  - H8 映射模板库(目录/应用/形状校验/未知模板)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-h1h8-'))
process.env.AGENTWORKSHOP_TEST = '1'

const { applySinkOverrides, runSinkPipeline, validateSinkOverrides } = await import('../server/services/workshop/daq/frames')
const { exportDaqDataset } = await import('../server/services/workshop/agents/industrial/daq-export')
const { bridgeMesHistory, archiveMesImageRows, mesBridgeEnabled, resamplePoints, imageDimsOf } = await import('../server/services/workshop/mes/mes-bridge')
type MesBridgeNode = import('../server/services/workshop/mes/mes-bridge').MesBridgeNode
const { listMesTemplates, applyMesTemplate } = await import('../server/services/workshop/mes/mes-templates')

const PNGB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ============================================================
// 注入假件
// ============================================================

function node(id: string, format: 'scalar' | 'vector' | 'image', lineId = 'L1'): MesBridgeNode {
  return {
    id,
    name: `MES ${id}`,
    driver: 'mes-rest',
    lineId,
    unit: 'mm',
    min: 0,
    max: 100,
    enabled: true,
    driverConfig: {
      historyMap: JSON.stringify({
        path: '/h',
        response: format === 'vector'
          ? { rowsPath: 'rows[*]', tsPath: 'ts', valuesPath: 'profile', format: 'vector' }
          : format === 'image'
            ? { rowsPath: 'rows[*]', tsPath: 'ts', dataPath: 'data', mimePath: 'mime', format: 'image' }
            : { rowsPath: 'rows[*]', tsPath: 'ts', valuePath: 'value', format: 'scalar' },
      }),
    },
  }
}

interface SampleRow { nodeId: string, tsMs: number, value: number, state: string, lineId?: string | null, productId?: string | null, recipeId?: string | null, runId?: string | null }
interface FrameRow { nodeId: string, tsMs: number, kind: 'vector' | 'image', lineId?: string | null, productId?: string | null, recipeId?: string | null, runId?: string | null, points: number, meta: Record<string, unknown>, metrics: Record<string, number> }

function fakeTsdb(samples: SampleRow[], frames: FrameRow[]) {
  return {
    async writeSamples(rows: SampleRow[]) {
      for (const r of rows) if (!samples.some(x => x.nodeId === r.nodeId && x.tsMs === r.tsMs)) samples.push(r)
    },
    async writeFrames(rows: FrameRow[]) {
      for (const r of rows) if (!frames.some(x => x.nodeId === r.nodeId && x.tsMs === r.tsMs)) frames.push(r)
    },
    async query(nodeId: string, opts: { fromMs?: number, toMs?: number, limit?: number }) {
      return samples
        .filter(r => r.nodeId === nodeId && r.tsMs >= (opts.fromMs ?? 0) && r.tsMs <= (opts.toMs ?? Date.now()))
        .sort((a, b) => a.tsMs - b.tsMs)
        .slice(0, opts.limit ?? 5000)
        .map(r => ({ at: r.tsMs, value: r.value, state: r.state }))
    },
    async queryFrames(nodeId: string, opts: { fromMs?: number, toMs?: number, limit?: number }) {
      return frames
        .filter(r => r.nodeId === nodeId && r.tsMs >= (opts.fromMs ?? 0) && r.tsMs <= (opts.toMs ?? Date.now()))
        .sort((a, b) => b.tsMs - a.tsMs)
        .slice(0, opts.limit ?? 100)
        .map(r => ({
          at: r.tsMs,
          kind: r.kind,
          points: r.points,
          meta: r.meta,
          metrics: r.metrics,
          lineId: r.lineId ?? null,
          productId: r.productId ?? null,
          recipeId: r.recipeId ?? null,
          runId: r.runId ?? null,
        }))
    },
  }
}

function fakeDriver(byNode: Record<string, Array<Record<string, unknown>>>) {
  return {
    async fetchHistory(input: { driverConfig: Record<string, unknown>, fromIso: string, toIso: string, maxRows: number, onRows: (rows: unknown[]) => void }) {
      const key = String(input.driverConfig.nodeKey ?? '')
      const rows = byNode[key] ?? []
      await input.onRows(rows.slice(0, input.maxRows))
      return { rows: Math.min(rows.length, input.maxRows), complete: rows.length <= input.maxRows }
    },
  }
}

const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const RUN = {
  runId: 'rr-1',
  lineId: 'L1',
  productId: 'P1',
  recipeId: 'RC1',
  startedAt: '2026-11-03T10:00:00.000Z',
  endedAt: '2026-11-03T11:00:00.000Z',
}

// ============================================================
// H2:节点级 sink 覆盖
// ============================================================

test('H2 sink 覆盖:模板 resample n=64 被节点 resamplePoints=8 覆盖,校验拒绝坏配置', () => {
  const steps = [{ name: 'resample', args: { n: 64 } }, { name: 'derive-metric', args: { name: 'avg', op: 'avg' } }]
  const merged = applySinkOverrides(steps, { sinkOverrides: JSON.stringify({ resample: { n: 8 } }) })!
  assert.equal((merged[0]!.args as { n: number }).n, 8)
  // 未覆盖的步骤原样
  assert.deepEqual(merged[1]!.args, steps[1]!.args)
  // 数值简写
  const shorthand = applySinkOverrides(steps, { resamplePoints: 16 })!
  assert.equal((shorthand[0]!.args as { n: number }).n, 16)
  // 运行时管线:64 点被重采样到 8 点
  const src = Array.from({ length: 64 }, (_, i) => i)
  const out = runSinkPipeline({ kind: 'vector', points: src }, merged, 'dn-test')
  assert.equal(out.points?.length, 8)
  // 配置期校验
  assert.match(validateSinkOverrides({ sinkOverrides: '{bad json' }) ?? '', /不是合法 JSON/)
  assert.match(validateSinkOverrides({ sinkOverrides: '[1,2]' }) ?? '', /JSON 对象/)
  assert.match(validateSinkOverrides({ sinkOverrides: JSON.stringify({ foo: 3 }) }) ?? '', /不支持数值简写/)
  assert.match(validateSinkOverrides({ resamplePoints: 1 }) ?? '', /2~4096/)
  assert.equal(validateSinkOverrides({ sinkOverrides: JSON.stringify({ resample: { n: 32 } }) }), null)
})

test('H2 重采样算法边界:目标点数=源点数不复制,2 点线性插值', () => {
  assert.deepEqual(resamplePoints([1, 2, 3], 3), [1, 2, 3])
  assert.deepEqual(resamplePoints([0, 10], 3), [0, 5, 10])
  assert.deepEqual(resamplePoints([], 4), [])
})

// ============================================================
// H3:导出环境/工况列
// ============================================================

test('H3 导出:with_context 开启时 CSV 追加 line/run/product/recipe 列;默认保持旧列契约', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-h3-'))
  const t0 = 1_700_000_000_000
  const points = [
    { at: t0, value: 1.5, state: 'ok' },
    { at: t0 + 1000, value: 1.6, state: 'ok' },
  ]
  const nodeOf = (id: string) => ({ id, name: id, unit: 'mm', lineId: 'L1', min: 0, max: 10 })
  const base = {
    targets: ['n1'],
    nodeOf,
    readPoints: async () => points,
    fromMs: t0 - 1,
    toMs: t0 + 5000,
    rootDir: root,
    now: () => t0,
  }
  const plain = await exportDaqDataset(base)
  const plainCsv = readFileSync(join(plain.dir, 'nodes', 'n1.csv'), 'utf8').split('\r\n')
  assert.equal(plainCsv[0], 'ts_iso,ts_ms,value,state')
  assert.equal(plainCsv[1]!.split(',').length, 4)

  const withCtx = await exportDaqDataset({
    ...base,
    withContext: true,
    contextOf: (_nodeId: string, lineId: string, ts: number) => (ts <= t0 + 500
      ? { lineId, runId: 'rr-1', productId: 'P1', recipeId: 'RC1' }
      : null),
  })
  const ctxCsv = readFileSync(join(withCtx.dir, 'nodes', 'n1.csv'), 'utf8').split('\r\n')
  assert.equal(ctxCsv[0], 'ts_iso,ts_ms,value,state,line_id,run_id,product_id,recipe_id')
  assert.equal(ctxCsv[1]!.split(',')[4], 'L1')
  assert.equal(ctxCsv[1]!.split(',')[5], 'rr-1')
  // 窗口外只给 line_id(批次列空)
  assert.equal(ctxCsv[2]!.split(',')[4], 'L1')
  assert.equal(ctxCsv[2]!.split(',')[5], '')
  const manifest = JSON.parse(readFileSync(join(withCtx.dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.context.enabled, true)
  assert.deepEqual(manifest.nodes[0].context_columns, ['line_id', 'run_id', 'product_id', 'recipe_id'])
})

// ============================================================
// H1:MES 历史 → TSDB
// ============================================================

test('H1 标量桥接:批次窗口内打全标、窗口外只打线标;重复桥接幂等', async () => {
  const samples: SampleRow[] = []
  const frames: FrameRow[] = []
  const n = node('mes-s', 'scalar')
  ;(n.driverConfig as Record<string, unknown>).nodeKey = 'n1'
  const rows = [
    { ts: '2026-11-03T10:10:00.000Z', value: 12.5 },
    { ts: '2026-11-03T10:20:00.000Z', value: 13.5 },
    { ts: '2026-11-03T11:30:00.000Z', value: 99.9 }, // 批次窗外
  ]
  const deps = {
    nodes: () => [n],
    resolveDriver: () => fakeDriver({ n1: rows }),
    tsdb: () => fakeTsdb(samples, frames),
    objectStore: () => ({ put: async () => {} }),
    runById: () => RUN,
    now: () => NOW,
  }
  const first = await bridgeMesHistory({
    nodeIds: ['mes-s'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T12:00:00.000Z', runId: 'rr-1',
  }, deps)
  assert.equal(first.ok, true, first.text)
  assert.equal(first.totals.inserted, 3)
  assert.equal(first.nodes[0]!.outsideRunWindow, 1)
  assert.equal(samples.length, 3)
  assert.equal(samples[0]!.runId, 'rr-1')
  assert.equal(samples[0]!.productId, 'P1')
  assert.equal(samples[1]!.runId, 'rr-1')
  assert.equal(samples[2]!.runId, null)
  assert.equal(samples[2]!.lineId, 'L1')

  const second = await bridgeMesHistory({
    nodeIds: ['mes-s'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T12:00:00.000Z', runId: 'rr-1',
  }, deps)
  assert.equal(second.totals.duplicates, 3)
  assert.equal(second.totals.inserted, 0)
  assert.equal(samples.length, 3)
})

test('H1 向量桥接:resample_to 统一网格,frame.meta.points 与指标落库', async () => {
  const samples: SampleRow[] = []
  const frames: FrameRow[] = []
  const n = node('mes-v', 'vector')
  ;(n.driverConfig as Record<string, unknown>).nodeKey = 'v1'
  const deps = {
    nodes: () => [n],
    resolveDriver: () => fakeDriver({ v1: [{ ts: '2026-11-03T10:30:00.000Z', values: [1, 2, 3, 4], record: { lane: 'A', mean: 2.5 } }] }),
    tsdb: () => fakeTsdb(samples, frames),
    objectStore: () => ({ put: async () => {} }),
    runById: () => RUN,
    now: () => NOW,
  }
  const r = await bridgeMesHistory({
    nodeIds: ['mes-v'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T11:00:00.000Z', resampleTo: 2, runId: 'rr-1',
  }, deps)
  assert.equal(r.ok, true, r.text)
  assert.equal(frames.length, 1)
  const fr = frames[0]!
  assert.equal(fr.kind, 'vector')
  assert.equal(fr.points, 2)
  assert.deepEqual(fr.meta.points, [1, 4])
  assert.equal(fr.metrics.avg, 2.5)
  assert.equal(fr.meta.source, 'mes')
  assert.equal((fr.meta.record as Record<string, unknown>).lane, 'A')
  assert.equal(fr.runId, 'rr-1')
})

test('H1 图像桥接:对象存储 put + sha256/size/尺寸入 frame.meta', async () => {
  const samples: SampleRow[] = []
  const frames: FrameRow[] = []
  const puts: Array<{ key: string, bytes: number }> = []
  const n = node('mes-i', 'image')
  ;(n.driverConfig as Record<string, unknown>).nodeKey = 'i1'
  const deps = {
    nodes: () => [n],
    resolveDriver: () => fakeDriver({ i1: [{ ts: '2026-11-03T10:40:00.000Z', data: PNGB64, mime: 'image/png', record: { defects: 2 } }] }),
    tsdb: () => fakeTsdb(samples, frames),
    objectStore: () => ({ put: async (key: string, data: Buffer) => { puts.push({ key, bytes: data.length }) } }),
    runById: () => RUN,
    now: () => NOW,
  }
  const r = await bridgeMesHistory({
    nodeIds: ['mes-i'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T11:00:00.000Z', runId: 'rr-1',
  }, deps)
  assert.equal(r.ok, true, r.text)
  assert.equal(puts.length, 1)
  assert.match(puts[0]!.key, /^daq\/mes-i\/2026\/11\/03\//)
  const fr = frames[0]!
  assert.equal(fr.kind, 'image')
  assert.equal(fr.meta.mime, 'image/png')
  assert.equal(fr.meta.width, 1)
  assert.equal(fr.meta.height, 1)
  assert.equal(typeof fr.meta.sha256, 'string')
  assert.equal(fr.metrics.defects, 2)
})

test('H1 试运行不写库;table 格式明确拒绝;全局开关关闭', async () => {
  const samples: SampleRow[] = []
  const frames: FrameRow[] = []
  const n = node('mes-s2', 'scalar')
  ;(n.driverConfig as Record<string, unknown>).nodeKey = 'n2'
  const deps = {
    nodes: () => [n],
    resolveDriver: () => fakeDriver({ n2: [{ ts: '2026-11-03T10:10:00.000Z', value: 1 }] }),
    tsdb: () => fakeTsdb(samples, frames),
    objectStore: () => ({ put: async () => {} }),
    runById: () => RUN,
    now: () => NOW,
  }
  const dry = await bridgeMesHistory({
    nodeIds: ['mes-s2'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T11:00:00.000Z', dryRun: true,
  }, deps)
  assert.equal(dry.totals.inserted, 1)
  assert.equal(samples.length, 0)

  const tableNode = node('mes-t', 'scalar')
  tableNode.driverConfig = { historyMap: JSON.stringify({ path: '/h', response: { rowsPath: 'rows[*]', tsPath: 'ts', format: 'table' } }) }
  const noTable = await bridgeMesHistory({
    nodeIds: ['mes-t'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T11:00:00.000Z',
  }, { ...deps, nodes: () => [tableNode] })
  assert.equal(noTable.nodes[0]!.error !== undefined, true)
  assert.match(noTable.nodes[0]!.error!, /table|include/)

  process.env.AW_MES_BRIDGE = '0'
  try {
    assert.equal(mesBridgeEnabled({}), false)
    const off = await bridgeMesHistory({ nodeIds: ['mes-s2'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T11:00:00.000Z' }, deps)
    assert.equal(off.ok, false)
    assert.match(off.text, /AW_MES_BRIDGE=0/)
  }
  finally {
    delete process.env.AW_MES_BRIDGE
  }
})

test('H1 无批次上下文:只打线标并在回包提示;缺 lineId 拒绝', async () => {
  const samples: SampleRow[] = []
  const frames: FrameRow[] = []
  const n = node('mes-s3', 'scalar')
  ;(n.driverConfig as Record<string, unknown>).nodeKey = 'n3'
  const deps = {
    nodes: () => [n],
    resolveDriver: () => fakeDriver({ n3: [{ ts: '2026-11-03T10:10:00.000Z', value: 1 }] }),
    tsdb: () => fakeTsdb(samples, frames),
    objectStore: () => ({ put: async () => {} }),
    runById: () => undefined,
    activeRun: () => null,
    now: () => NOW,
  }
  const r = await bridgeMesHistory({ nodeIds: ['mes-s3'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T11:00:00.000Z' }, deps)
  assert.equal(r.ok, true, r.text)
  assert.equal(samples[0]!.runId, null)
  assert.match(r.text, /未解析到批次/)

  const noLine = node('mes-s4', 'scalar', '')
  ;(noLine.driverConfig as Record<string, unknown>).nodeKey = 'n4'
  const bad = await bridgeMesHistory({ nodeIds: ['mes-s4'], fromIso: '2026-11-03T10:00:00.000Z', toIso: '2026-11-03T11:00:00.000Z' }, { ...deps, nodes: () => [noLine] })
  assert.equal(bad.nodes[0]!.error !== undefined, true)
  assert.match(bad.nodes[0]!.error!, /未分配产线/)
})

// ============================================================
// H5:MES 图像帧归档到统一帧检索面
// ============================================================

test('H5 图像归档:对象键同构 + frame.meta.source=mes;已存在则跳过', async () => {
  const samples: SampleRow[] = []
  const frames: FrameRow[] = []
  const puts: string[] = []
  const n = node('mes-i2', 'image')
  const deps = {
    tsdb: () => fakeTsdb(samples, frames),
    objectStore: () => ({ put: async (key: string) => { puts.push(key) } }),
    runById: () => RUN,
    activeRun: () => RUN,
    now: () => NOW,
  }
  const rows = [{ ts: '2026-11-03T10:40:00.000Z', data: PNGB64, mime: 'image/png', record: { defects: 1 } }]
  const first = await archiveMesImageRows(n, rows, deps)
  assert.deepEqual(first, { archived: 1, skipped: 0, failed: 0 })
  assert.equal(puts.length, 1)
  assert.equal(frames[0]!.meta.source, 'mes')
  assert.equal(frames[0]!.runId, 'rr-1')
  const second = await archiveMesImageRows(n, rows, deps)
  assert.deepEqual(second, { archived: 0, skipped: 1, failed: 0 })
  assert.equal(frames.length, 1)
})

test('H5 图像头部解析:1x1 PNG 尺寸正确;损坏头部返回 0', () => {
  const buf = Buffer.from(PNGB64, 'base64')
  assert.deepEqual(imageDimsOf(buf, 'image/png'), { width: 1, height: 1 })
  assert.deepEqual(imageDimsOf(Buffer.from('not-an-image'), 'image/png'), { width: 0, height: 0 })
})

// ============================================================
// H8:映射模板库
// ============================================================

test('H8 模板目录:6 个模板,能力位与形态声明齐全', () => {
  const list = listMesTemplates()
  assert.equal(list.length, 6)
  const ids = list.map(t => t.id)
  for (const id of ['rest-scalar', 'rest-scalar-wrapped', 'rest-cursor-paged', 'rest-vector-profile', 'rest-image-frame', 'opcenter-style']) {
    assert.ok(ids.includes(id), `缺模板 ${id}`)
  }
  const scalar = list.find(t => t.id === 'rest-scalar')!
  assert.equal(scalar.capabilities.read && scalar.capabilities.write && scalar.capabilities.history, true)
  const img = list.find(t => t.id === 'rest-image-frame')!
  assert.deepEqual(img.formats, ['image'])
})

test('H8 模板应用:生成三段映射并通过形状校验;未知模板 404', () => {
  const r = applyMesTemplate('rest-scalar', { baseUrl: 'http://mes.example:8080', tag: 'LINE1.TEMP', secretRef: 'line1.mes', pathPrefix: '/api/v2' })
  assert.equal(r.validation.ok, true, r.validation.message)
  assert.equal(r.driverConfig.baseUrl, 'http://mes.example:8080')
  assert.equal(r.driverConfig.secretRef, 'line1.mes')
  assert.match(String(r.driverConfig.readMap), /LINE1\.TEMP/)
  assert.match(String(r.driverConfig.historyMap), /rows\[\*\]/)
  assert.ok(r.nextSteps.some(s => /mes_fetch/.test(s)))

  const vec = applyMesTemplate('rest-vector-profile', { baseUrl: 'http://mes.example', tag: 'THK', valuesPath: 'thickness' })
  assert.equal(vec.validation.ok, true, vec.validation.message)
  assert.match(String(vec.driverConfig.historyMap), /"valuesPath":"thickness"/)

  assert.throws(() => applyMesTemplate('no-such-template', { baseUrl: 'http://x', tag: 'T' }), /未知 MES 映射模板/)
  assert.throws(() => applyMesTemplate('rest-scalar', { tag: 'T' }), /baseUrl 必填/)
})

test('H8 模板应用:缺 tag 明确报错(不生成半成品配置)', () => {
  assert.throws(() => applyMesTemplate('rest-scalar', { baseUrl: 'http://x' }), /tag 必填/)
})
