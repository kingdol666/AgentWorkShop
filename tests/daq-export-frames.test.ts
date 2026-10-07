/**
 * daq_export 帧节点导出单测(多源异构入库轮):
 *   - 向量帧节点:单 CSV 长表(ts_iso,ts_ms,point_index,value),升序,manifest 带 frames/points
 *   - 图像帧节点:frames/<node>/ 逐帧原文件落盘,manifest 带 saved/files/mime
 *   - 帧上限截断标记 truncated;标量节点路径零行为变化
 * 病根背景:帧只入 daq_frames 不入 daq_samples,此前按标量导出帧节点得到零行假象。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-daqexp-frames-test-'))
delete process.env.AW_BENCH_MODE

const { exportDaqDataset } = await import('../server/services/workshop/agents/industrial/daq-export')

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('向量帧节点:长表 CSV 升序 + manifest frames/points 计数', async () => {
  const dir = join(process.env.AW_HOME!, 'exp-vec')
  const base = 1_700_000_000_000
  const frames = [1, 0].map(off => ({ // 故意乱序传入,验证核心升序排序
    at: base + off * 1000,
    kind: 'vector' as const,
    points: off === 0 ? [1.5, 2.5, 3.5] : [4.5, 5.5],
    metrics: { avg: off === 0 ? 2.5 : 5 },
  }))
  const r = await exportDaqDataset({
    targets: ['dn-vec'],
    nodeOf: id => ({ id, name: '轮廓仪', unit: 'mm', lineId: 'ln-x', semantics: '厚度轮廓', signalKind: 'vector' }),
    readPoints: async () => [],
    readFrames: async () => frames,
    fromMs: base - 1,
    toMs: base + 60_000,
    rootDir: dir,
  })
  const entry = r.manifest.nodes[0] as Record<string, unknown>
  assert.equal(entry.kind, 'vector')
  assert.equal(entry.frames, 2)
  assert.equal(entry.points, 5)
  assert.equal(entry.file, 'frames/dn-vec.csv')
  const csv = readFileSync(join(r.dir, 'frames', 'dn-vec.csv'), 'utf8').trim().split(/\r?\n/)
  assert.equal(csv[0], 'ts_iso,ts_ms,point_index,value')
  assert.equal(csv.length - 1, 5)
  assert.ok(csv[1]!.includes(String(base)), '首行应为较早帧(升序)')
  assert.deepEqual(r.truncated, [])
})

test('图像帧节点:逐帧原文件落盘 + manifest saved/files/mime + 上限截断标记', async () => {
  const dir = join(process.env.AW_HOME!, 'exp-img')
  const base = 1_700_000_000_000
  let calls = 0
  const r = await exportDaqDataset({
    targets: ['dn-img'],
    nodeOf: id => ({ id, name: 'SAXS 相机', unit: '', lineId: 'ln-x', semantics: '二维散射图', signalKind: 'image' }),
    readPoints: async () => [],
    readFrames: async (_id, win) => Array.from({ length: 5 }, (_, i) => ({ at: win.fromMs + (i + 1) * 1000, kind: 'image' as const, meta: { objectKey: `k${i}` } })),
    readFrameContent: async (id, at) => {
      calls++
      return { data: PNG_1PX, mime: 'image/png', ...(id && at ? {} : {}) }
    },
    fromMs: base,
    toMs: base + 60_000,
    rootDir: dir,
    caps: { framesPerNode: 5 },
  })
  const entry = r.manifest.nodes[0] as Record<string, unknown>
  assert.equal(entry.kind, 'image')
  assert.equal(entry.frames, 5)
  assert.equal(entry.saved, 5)
  assert.equal(entry.mime, 'image/png')
  const frameDir = join(r.dir, 'frames', 'dn-img')
  const files = readdirSync(frameDir)
  assert.equal(files.length, 5)
  assert.ok(files.every(f => f.endsWith('.png')))
  assert.ok(existsSync(join(frameDir, files[0]!)))
  assert.equal(readFileSync(join(frameDir, files[0]!)).length, PNG_1PX.length)
  assert.ok(calls >= 5)
})

test('帧上限:超 framesPerNode 截断并标记 truncated;未提供 readFrames 时帧节点跳过不报错', async () => {
  const dir = join(process.env.AW_HOME!, 'exp-cap')
  const base = 1_700_000_000_000
  const r1 = await exportDaqDataset({
    targets: ['dn-cap'],
    nodeOf: id => ({ id, name: '相机', unit: '', lineId: 'ln-x', signalKind: 'image' }),
    readPoints: async () => [],
    readFrames: async (_id, win) => Array.from({ length: 6 }, (_, i) => ({ at: win.fromMs + i * 1000, kind: 'image' as const })),
    readFrameContent: async () => ({ data: PNG_1PX, mime: 'image/png' }),
    fromMs: base,
    toMs: base + 60_000,
    rootDir: dir,
    caps: { framesPerNode: 5 },
  })
  assert.deepEqual(r1.truncated, ['dn-cap'])
  const r2 = await exportDaqDataset({
    targets: ['dn-nofn'],
    nodeOf: id => ({ id, name: '相机', unit: '', lineId: 'ln-x', signalKind: 'image' }),
    readPoints: async () => [],
    fromMs: base,
    toMs: base + 60_000,
    rootDir: dir,
  })
  const entry = r2.manifest.nodes[0] as Record<string, unknown>
  assert.equal(entry.frames, 0)
  assert.match(String(entry.note), /readFrames/)
})
