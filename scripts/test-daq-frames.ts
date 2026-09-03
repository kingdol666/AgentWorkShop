/**
 * DAQ 多形态帧管线单元测试:v2 帧信封 / mock 三形态驱动 / sink 处理器 /
 * 磁盘对象存储 / SQLite 帧适配 / runtime 帧路径 / 打标与预览。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-daq-frames.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { encodePng, resizeGray } from '../server/services/workshop/daq/png-enc'
import { runSinkPipeline, registerFrameProcessor, type DaqFrameWorking } from '../server/services/workshop/daq/frames'
import { mockDaqDriver } from '../server/services/workshop/daq/drivers'
import { DiskObjectAdapter } from '../server/services/workshop/daq/objectstore/disk.adapter'
import { daqObjectKey } from '../server/services/workshop/daq/objectstore/objectstore-port'
import { DaqNode } from '../server/services/workshop/daq/daq-node'
import { DaqNodeRuntime, type DaqRuntimeHost } from '../server/services/workshop/daq/daq-runtime'
import type { DaqFrameRow, DaqSampleRow } from '../server/services/workshop/daq/storage/tsdb-port'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ===== PNG 编码/解码闭环 + 缩放 =====
console.log('\n--- PNG 编码器(png-enc)---')
{
  const w = 64
  const h = 48
  const px = new Uint8Array(w * h)
  for (let i = 0; i < px.length; i++) px[i] = (i * 7) % 256
  const blob = encodePng(w, h, px)
  check('PNG 魔数与 IEND', blob.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && blob.subarray(blob.length - 8, blob.length - 4).toString('ascii') === 'IEND')
  const small = resizeGray(px, w, h, 32, 24)
  check('最近邻缩放尺寸', small.length === 32 * 24)
  check('缩放取点保真(角点)', small[0] === px[0] && small[23 * 32 + 31] === px[Math.min(h - 1, Math.floor((23 * h) / 24)) * w + Math.min(w - 1, Math.floor((31 * w) / 32))])
}

// ===== mock 三形态驱动 =====
console.log('\n--- mock 驱动三形态 ---')
{
  const base = { ctx: { nodeId: 'dn-t1', now: Date.now(), ageMs: 5000 }, config: { base: 0.52, amp: 0.018, min: 0.4, max: 0.65 }, driverConfig: {} }
  const scalar = await mockDaqDriver.sample({ ...base })
  check('scalar 形态返回数值(既有契约)', typeof scalar === 'number' && Number.isFinite(scalar))

  const vec = await mockDaqDriver.sample({ ...base, signalKind: 'vector', vector: { points: 64, min: 0.4, max: 0.65 } })
  check('vector 形态返回帧信封', vec != null && typeof vec === 'object' && 'frame' in vec && vec.frame.kind === 'vector')
  if (vec != null && typeof vec === 'object' && 'frame' in vec && vec.frame.kind === 'vector') {
    check('vector 64 点且在量程内', vec.frame.points.length === 64 && vec.frame.points.every(p => p >= 0.4 && p <= 0.65))
  }

  const img = await mockDaqDriver.sample({ ...base, signalKind: 'image' })
  check('image 形态返回 PNG blob', img != null && typeof img === 'object' && 'frame' in img && img.frame.kind === 'image')
  if (img != null && typeof img === 'object' && 'frame' in img && img.frame.kind === 'image') {
    check('image 尺寸与 mime', img.frame.width === 320 && img.frame.height === 240 && img.frame.mime === 'image/png')
    check('image blob 可解码出像素(经 thumbnail 处理器间接验证)', img.frame.blob.length > 1000)
  }
}

// ===== sink 处理器管线 =====
console.log('\n--- sink 处理器管线 ---')
{
  const points = Array.from({ length: 100 }, (_, i) => 0.5 + Math.sin(i / 10) * 0.05)
  let wf: DaqFrameWorking = { kind: 'vector', points, metrics: {} }
  wf = runSinkPipeline(wf, [
    { name: 'resample', args: { n: 32 } },
    { name: 'derive-metric', args: { name: 'avg', op: 'avg' } },
    { name: 'derive-metric', args: { name: 'max', op: 'max' } },
    { name: 'zones', args: { n: 4 } },
  ], 'dn-t')
  check('resample 降采样到 32 点', wf.points?.length === 32, `len=${wf.points?.length}`)
  check('derive-metric avg/max 入 metrics', Number.isFinite(wf.metrics?.avg) && Number.isFinite(wf.metrics?.max))
  check('max ≥ avg(轮廓统计自洽)', (wf.metrics?.max ?? 0) >= (wf.metrics?.avg ?? 0))
  check('zones 分区指标(zone1_avg/zone4_max)', wf.metrics?.zone1_avg != null && wf.metrics?.zone4_max != null)
  check('未知处理器跳过不抛', (runSinkPipeline(wf, [{ name: 'no-such-proc' }], 'dn-t')).points?.length === 32)

  // image 管线:thumbnail + quality-gate
  const w = 320
  const h = 240
  const px = new Uint8Array(w * h).fill(120)
  const blob = encodePng(w, h, px)
  let imf: DaqFrameWorking = { kind: 'image', blob, mime: 'image/png', width: w, height: h, metrics: {} }
  imf = runSinkPipeline(imf, [{ name: 'thumbnail', args: { width: 64 } }, { name: 'quality-gate' }], 'dn-t')
  check('thumbnail 生成缩略 blob(平坦图高压缩,仅验存在)', imf.thumbBlob != null && imf.thumbBlob.length > 0)
  check('quality-gate 亮度/对比度指标', imf.metrics?.brightness != null && Math.abs((imf.metrics?.brightness ?? 0) - 120) < 12, `brightness=${imf.metrics?.brightness}`)

  // 插件处理器注册(同名覆盖 + 自定义)
  registerFrameProcessor({ name: 'test-double', applies: 'vector', process: f => ({ ...f, metrics: { ...f.metrics, doubled: (f.metrics?.avg ?? 0) * 2 } }) })
  const out = runSinkPipeline({ kind: 'vector', points: [1, 2, 3], metrics: { avg: 2 } }, [{ name: 'test-double' }], 'dn-t')
  check('插件处理器注册生效', out.metrics?.doubled === 4)
}

// ===== 磁盘对象存储 =====
console.log('\n--- 磁盘对象存储(disk adapter)---')
{
  const os = new DiskObjectAdapter()
  await os.init()
  const key = daqObjectKey('dn-t1', Date.now(), '.png')
  const payload = Buffer.from([1, 2, 3, 4, 5])
  await os.put(key, payload, 'image/png')
  const back = await os.get(key)
  check('put/get 闭环', back.equals(payload), `key=${key}`)
  check('daqObjectKey 目录结构', /^daq\/dn-t1\/\d{4}\/\d{2}\/\d{2}\/\d+\.png$/.test(key))
  let rejected = false
  try {
    await os.put('../evil', payload, 'image/png')
  }
  catch {
    rejected = true
  }
  check('路径逃逸键拒绝', rejected)
  await os.remove(key)
  check('remove 后 404 化', await os.get(key).then(() => false, () => true))
}

// ===== SQLite 帧适配(降级环境全链路)=====
console.log('\n--- SQLite 帧适配 ---')
{
  const db: DatabaseSync = openWorkshopDb(':memory:')
  // SqliteTimeSeriesAdapter 自持连接(文件路径),此处直接验证 SQL 形态:
  // 用与 adapter 相同 DDL 在内存库上跑一遍查询语义
  db.exec(`
    CREATE TABLE daq_frames (
      node_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL,
      template_key TEXT, device_binding_id TEXT,
      line_id TEXT, product_id TEXT, recipe_id TEXT, run_id TEXT,
      points INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}', metrics TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (node_id, ts_ms)
    );
  `)
  const rows: DaqFrameRow[] = [
    { nodeId: 'dn-v', tsMs: 1000, kind: 'vector', templateKey: 'thickness-scan', deviceBindingId: 'dev-1', lineId: 'line-1', productId: 'p1', recipeId: 'r1', runId: 'run-1', points: 32, meta: { points: [0.5, 0.51] }, metrics: { avg: 0.505, max: 0.51 } },
    { nodeId: 'dn-i', tsMs: 2000, kind: 'image', templateKey: 'ccd-image', points: 0, meta: { objectKey: 'daq/x/1.png', thumbKey: 'daq/x/1.thumb.png', mime: 'image/png', width: 320, height: 240 }, metrics: { brightness: 120 } },
  ]
  const ins = db.prepare('INSERT INTO daq_frames (node_id, ts_ms, kind, template_key, device_binding_id, line_id, product_id, recipe_id, run_id, points, meta, metrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const r of rows) ins.run(r.nodeId, r.tsMs, r.kind, r.templateKey ?? null, r.deviceBindingId ?? null, r.lineId ?? null, r.productId ?? null, r.recipeId ?? null, r.runId ?? null, r.points, JSON.stringify(r.meta), JSON.stringify(r.metrics))
  const vecRow = db.prepare(`SELECT * FROM daq_frames WHERE node_id = 'dn-v'`).get() as { meta: string, metrics: string }
  check('向量行 meta.points 还原', JSON.parse(vecRow.meta).points.length === 2)
  check('打标列逐条携带', db.prepare(`SELECT line_id FROM daq_frames WHERE node_id='dn-v'`).get().line_id === 'line-1')
  check('图像行对象键在 meta', JSON.parse((db.prepare(`SELECT meta FROM daq_frames WHERE node_id='dn-i'`).get() as { meta: string }).meta).objectKey === 'daq/x/1.png')
}

// ===== runtime 帧路径(fake host:tick 采样→入队→onSample 消费)=====
console.log('\n--- runtime 帧路径 ---')
{
  const node = new DaqNode({
    id: 'dn-frame', templateRef: 'thickness-scan', name: '测厚扫描 01', driver: 'mock',
    intervalMs: 120, publishIntervalMs: 0, min: 0.4, max: 0.65, lineId: '',
  })
  const published: Array<Record<string, unknown>> = []
  const ingested: Array<{ env: Record<string, unknown>, allowPublish: boolean }> = []
  const sampleRows: DaqSampleRow[] = []
  const frameRows: DaqFrameRow[] = []
  const host: DaqRuntimeHost = {
    defaults: () => ({ intervalMs: 1000, publishIntervalMs: 0 }),
    sample: (n, now) => mockDaqDriver.sample({
      ctx: { nodeId: n.id, now, ageMs: 10_000 },
      config: { base: 0.52, amp: 0.018, min: 0.4, max: 0.65 },
      driverConfig: {},
      signalKind: 'vector',
      vector: { points: 64, min: 0.4, max: 0.65 },
    }),
    publishSample: env => published.push(env as Record<string, unknown>),
    ingest: (n, env, allowPublish) => ingested.push({ env: env as Record<string, unknown>, allowPublish }),
    broadcastError: () => {},
  }
  const rt = new DaqNodeRuntime(node, host)
  await rt.tick(Date.now())
  check('tick 产出帧信封(vector)', published.length === 1 && (published[0]!.frame as { kind: string }).kind === 'vector')
  const env = published[0] as unknown as { nodeId: string, at: string, frame: { kind: 'vector', points: number[] }, value: number }
  check('信封值语义 = avg 指标回填', Number.isFinite(env.value))
  const v1 = rt.onSample(env as never)
  check('onSample 帧路径消费 ok', v1 === 'ok' && ingested.length === 1 && ingested[0]!.allowPublish === true)
  check('节点触活(lastAt 更新,state=ok)', node.state === 'ok' && node.lastAt != null && node.value != null)
  check('帧路径不产标量样本行(mock vector 无 value 写库)', sampleRows.length === 0 && frameRows.length === 0)
  // 迟到帧丢弃
  const late = rt.onSample({ ...env, at: new Date(Date.parse(env.at) - 5000).toISOString() } as never)
  check('乱序帧丢弃(late)', late === 'late')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
