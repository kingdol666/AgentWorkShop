/**
 * 2026-10-28 多专家审查整改 · 数采域 P1:
 *  A-P1-1 帧指标告警持续态不被每帧抹回 ok;
 *  A-P1-2 停线补种时间戳 = 补种时刻(不被乱序游标判 late);
 *  A-P1-3 外部 ingest 走 processFrameSample 同一 sink 管线(缩略图/派生指标/指纹)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
const testHome = mkdtempSync(join(tmpdir(), 'aw-mx-daq-'))
process.env.AW_HOME = testHome
delete process.env.AW_BENCH_MODE

const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { DaqNodeRuntime } = await import('../server/services/workshop/daq/daq-runtime')
const { retainedSeedPlan, RETAINED_SEED_MAX_AGE_MS } = await import('../server/services/workshop/daq/daq-controller/push')
const { getDaqController } = await import('../server/services/workshop/daq/daq-controller')
const { getDaqTemplateRegistry } = await import('../server/services/workshop/daq/daq-templates')
const { getObjectStore } = await import('../server/services/workshop/daq/objectstore')
const { encodePng } = await import('../server/services/workshop/daq/png-enc')

const iso = (ms: number) => new Date(ms).toISOString()

test('A-P1-1:帧指标 alarm 跨帧保持;恢复后回 ok', () => {
  const node = new DaqNode({ id: 'dn-frame', templateRef: 'cam-profile', name: 'frame-node', driver: 'mock' })
  node.state = 'offline'
  // 模拟网关 ingestFrame 的指标阈值边沿判定:第一帧越限 → 节点 alarm
  let metricAlarm = true
  const host = {
    defaults: () => ({ intervalMs: 1000, publishIntervalMs: 0 }),
    sample: () => null,
    publishSample: () => {},
    ingest: (n: DaqNode) => {
      if (metricAlarm) n.state = 'alarm'
      else if (n.state === 'alarm') n.state = 'ok'
    },
    broadcastError: () => {},
  }
  const rt = new DaqNodeRuntime(node, host as never)
  const frame = { kind: 'vector' as const, points: [1, 2, 3], metrics: { avg: 2 } }
  const t0 = Date.now()
  rt.onSample({ nodeId: node.id, templateRef: node.templateRef, value: 2, state: 'ok', at: iso(t0), frame })
  assert.equal(node.state, 'alarm')
  // 连续 3 帧仍在限外:节点态必须保持 alarm(旧实现每帧抹回 ok)
  for (let i = 1; i <= 3; i++) {
    rt.onSample({ nodeId: node.id, templateRef: node.templateRef, value: 2, state: 'ok', at: iso(t0 + i * 1000), frame })
    assert.equal(node.state, 'alarm', `第 ${i} 帧把 alarm 抹掉了`)
  }
  // 指标恢复 → ingest 侧回 ok,运行时不得再覆盖
  metricAlarm = false
  rt.onSample({ nodeId: node.id, templateRef: node.templateRef, value: 2, state: 'ok', at: iso(t0 + 5000), frame })
  assert.equal(node.state, 'ok')
})

test('A-P1-2:补种计划以补种时刻为时间戳,旧到达时刻不会被采用', () => {
  const now = Date.now()
  const stale = { runSeeded: false, lastValue: 88.5, lastAt: now - 5 * 60_000 }
  const plan = retainedSeedPlan(stale, now)
  assert.deepEqual(plan, { value: 88.5, atMs: now })
  assert.notEqual(plan!.atMs, stale.lastAt)

  // 已补种 / 无缓存 / 超龄 → 不补
  assert.equal(retainedSeedPlan({ ...stale, runSeeded: true }, now), null)
  assert.equal(retainedSeedPlan({ ...stale, lastValue: null }, now), null)
  assert.equal(retainedSeedPlan({ ...stale, lastAt: now - RETAINED_SEED_MAX_AGE_MS - 1 }, now), null)
})

test('A-P1-2:旧到达时刻会被运行时判 late,补种时刻通过(乱序游标语义)', () => {
  const node = new DaqNode({ id: 'dn-seed', templateRef: 'temp-thermocouple', name: 'seed-node', driver: 'mock', min: 0, max: 200 })
  const ingested: string[] = []
  const host = {
    defaults: () => ({ intervalMs: 1000, publishIntervalMs: 0 }),
    sample: () => null,
    publishSample: () => {},
    ingest: (_n: DaqNode, env: { at: string }) => { ingested.push(env.at) },
    broadcastError: () => {},
  }
  const rt = new DaqNodeRuntime(node, host as never)
  const t0 = Date.now()
  // 上一批次:游标推进到 t0
  assert.equal(rt.onSample({ nodeId: node.id, templateRef: node.templateRef, value: 60, state: 'ok', at: iso(t0) }), 'ok')
  // 停线缓存值的"到达时刻"在 t0 之前(甚至同一毫秒)→ late(旧实现的补种就是这条)
  assert.equal(rt.onSample({ nodeId: node.id, templateRef: node.templateRef, value: 61, state: 'ok', at: iso(t0) }), 'late')
  // 补种时刻(now = t0 + 1ms)→ ok 且入库
  assert.equal(rt.onSample({ nodeId: node.id, templateRef: node.templateRef, value: 61, state: 'ok', at: iso(t0 + 1) }), 'ok')
  assert.equal(ingested.length, 2)
})

test('A-P1-3:外部图像帧经 processFrameSample 生成缩略图与服务端指纹', async () => {
  const tplReg = getDaqTemplateRegistry()
  tplReg.registerPlugin({
    key: 'test-mx-image',
    name: '测试灰度图',
    signalKind: 'image',
    unit: 'px',
    decimals: 0,
    min: 0,
    max: 255,
    sink: { processors: [{ name: 'thumbnail', args: { width: 16 } }] },
    metrics: [],
  } as never)
  const controller = getDaqController()
  const node = new DaqNode({ id: 'dn-img', templateRef: 'test-mx-image', name: 'img', driver: 'mock', min: 0, max: 255, decimals: 0 })
  ;(controller as unknown as { repo: { insert(n: DaqNode): void } }).repo.insert(node)

  const w = 32
  const h = 16
  const px = new Uint8Array(w * h).fill(128)
  const png = encodePng(w, h, px)
  const processed = await controller.processExternalFrame(node, { kind: 'image', blob: png, mime: 'image/png', width: w, height: h }, Date.now())
  assert.ok(processed, '图像帧不应被管线拒绝')
  const frame = processed!.frame
  assert.equal(frame.kind, 'image')
  if (frame.kind !== 'image') assert.fail('kind 收窄失败')
  assert.ok(frame.objectKey, '主图应落对象存储')
  assert.ok(frame.thumbKey, '模板声明 thumbnail → 缩略图必须生成(旧实现外部推送直接跳过 sink 管线)')
  assert.equal(frame.width, w)
  assert.equal(frame.height, h)
  assert.match(String(frame.sha256), /^[0-9a-f]{64}$/)
  assert.equal(frame.size, png.length)
  const thumb = await getObjectStore().get(frame.thumbKey!)
  assert.ok(thumb && thumb.length > 0, '缩略图对象应可读回')
})

test('A-P1-3:外部向量帧的派生指标由模板 sink 产生(不信任请求自报)', async () => {
  const tplReg = getDaqTemplateRegistry()
  tplReg.registerPlugin({
    key: 'test-mx-vector',
    name: '测试向量',
    signalKind: 'vector',
    unit: 'mm',
    decimals: 2,
    min: 0,
    max: 100,
    sink: { processors: [{ name: 'derive-metric', args: { name: 'peak', op: 'max' } }] },
    metrics: [],
  } as never)
  const controller = getDaqController()
  const node = new DaqNode({ id: 'dn-vec', templateRef: 'test-mx-vector', name: 'vec', driver: 'mock', min: 0, max: 100, decimals: 2 })
  ;(controller as unknown as { repo: { insert(n: DaqNode): void } }).repo.insert(node)

  const points = [1, 5, 3, 9, 2]
  const processed = await controller.processExternalFrame(node, { kind: 'vector', points, metrics: { fake: 1 } }, Date.now())
  assert.ok(processed)
  const frame = processed!.frame
  if (frame.kind !== 'vector') assert.fail('kind 收窄失败')
  assert.equal(frame.metrics?.peak, 9, '模板 derive-metric 必须执行')
  assert.equal(frame.metrics?.fake, 1, '调用方提供的初值保留(可覆盖)')
  assert.deepEqual(frame.points, points)
})
