/**
 * mes_export 单测(不联网):指定目录落盘 + manifest/README 字段语义 + 路径逃逸拒绝。
 * 驱动/节点全注入,导出根用 AW_MES_EXPORT_ROOT 指到临时目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMesController } from '../server/services/workshop/mes/mes-controller'
import type { MesNodeLike } from '../server/services/workshop/mes/mes-controller'
import type { DcwFetchHistoryInput, DcwFetchHistoryResult, DcwHistoryRow } from '../server/services/workshop/dcw/drivers/shared'
import type { MesHistoryDriver } from '../server/services/workshop/mes/mes-datasets'

const FROM = '2026-10-19T00:00:00.000Z'
const TO = '2026-10-19T01:00:00.000Z'

function node(id: string, name: string, variant: string): MesNodeLike {
  return {
    id,
    name,
    driver: 'mes-rest',
    lineId: 'line-1',
    unit: variant === 'vector' ? 'um' : variant === 'image' ? 'gray' : 'MPa',
    min: 30,
    max: 40,
    enabled: true,
    driverConfig: {
      variant,
      desc: variant === 'vector' ? '膜厚断面扫描' : variant === 'image' ? 'CCD 表检帧' : '熔体压力',
      semantics: variant === 'vector' ? '沿模头横向的膜厚分布' : variant === 'image' ? '表面图像帧' : '挤出负荷',
      historyMap: JSON.stringify({
        path: `/api/${variant}`,
        response: {
          rowsPath: variant === 'image' ? 'data.frames[*]' : 'data.rows[*]',
          tsPath: 'ts',
          ...(variant === 'vector'
            ? { format: 'vector', valuesPath: 'profile', dictionaryPath: 'data.fields' }
            : variant === 'image'
              ? { format: 'image', dataPath: 'data', mimePath: 'mime', dictionaryPath: 'data.fields' }
              : { valuePath: 'value' }),
        },
      }),
    },
  }
}

function driver(): MesHistoryDriver {
  return {
    kind: 'mes-rest',
    available: async () => true,
    write: async () => ({ ok: false, message: 'not used', raw: null, readback: null }),
    test: async () => ({ ok: true, message: 'ok' }),
    read: async () => ({ ok: true, message: 'ok', eng: 1, raw: 1 }),
    fetchHistory: async (input: DcwFetchHistoryInput): Promise<DcwFetchHistoryResult> => {
      if (input.driverConfig.variant === 'image') {
        const rows: DcwHistoryRow[] = [
          { ts: '2026-10-19T00:00:00.000Z', data: Buffer.from('fake-a').toString('base64'), mime: 'image/png', record: { defects: 1 } },
          { ts: '2026-10-19T00:00:10.000Z', data: Buffer.from('fake-b').toString('base64'), mime: 'image/png', record: { defects: 0 } },
        ]
        await input.onRows(rows)
        return {
          rows: rows.length,
          complete: true,
          dictionary: [{ field: 'data', label: 'CCD 图像帧', description: 'PNG 像素' }],
        }
      }
      if (input.driverConfig.variant === 'vector') {
        const rows: DcwHistoryRow[] = [
          { ts: '2026-10-19T00:00:00.000Z', values: [35.1, 35.2, 35.3], record: { mean: 35.2 } },
          { ts: '2026-10-19T00:00:01.000Z', values: [35.2, 35.3, 35.4], record: { mean: 35.3 } },
        ]
        await input.onRows(rows)
        return {
          rows: rows.length,
          complete: true,
          dictionary: [{
            field: 'profile',
            label: '膜厚断面',
            unit: 'um',
            kind: 'vector',
            description: '沿模头横向的膜厚分布',
            points: [
              { field: 'v0', label: '模头点1', unit: 'um', index: 0 },
              { field: 'v1', label: '模头点2', unit: 'um', index: 1 },
              { field: 'v2', label: '模头点3', unit: 'um', index: 2 },
            ],
          }],
        }
      }
      const rows: DcwHistoryRow[] = [
        { ts: '2026-10-19T00:00:00.000Z', value: 0.82 },
        { ts: '2026-10-19T00:00:01.000Z', value: 0.83 },
      ]
      await input.onRows(rows)
      return { rows: rows.length, complete: true }
    },
  }
}

function controller(nodes: MesNodeLike[]) {
  return createMesController({
    nodes: () => nodes,
    boundNodeIds: () => new Set(nodes.map(n => n.id)),
    resolveDriver: () => driver(),
    nowMs: () => Date.parse('2026-10-19T00:30:00.000Z'),
    store: { createFetchJob: () => ({ jobId: 'j', datasetId: 'd' }) },
  })
}

test('mes_export:标量+向量导出到指定子目录,manifest/README 带单位/物理意义/逐点语义', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-mes-export-'))
  const prev = process.env.AW_MES_EXPORT_ROOT
  process.env.AW_MES_EXPORT_ROOT = root
  try {
    const c = controller([node('n-p', '熔体压力', 'scalar'), node('n-t', '熔体温度', 'scalar'), node('n-v', '测厚仪', 'vector')])
    const r = await c.exportData('agent-a', { ids: ['n-p', 'n-t', 'n-v'], from: FROM, to: TO, max_rows: 100, folder: 'line-1/batch-a', title: '批次A分析导出', note: '膜厚与压力联查' })
    assert.ok(!r.isError, r.text)
    const dir = join(root, 'line-1', 'batch-a')
    assert.equal(r.dir, dir)
    assert.ok(existsSync(join(dir, 'n-p', 'data.csv')))
    assert.ok(existsSync(join(dir, 'n-v', 'data.csv')))
    assert.ok(existsSync(join(dir, 'merged.csv')))
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      schema: string
      nodes: Array<{ id: string, unit: string, semantics: string, fields: Array<{ label: string, points?: Array<{ label: string }> }> }>
      merged_file: string
    }
    assert.equal(manifest.schema, 'aw.mes-export/1')
    const vec = manifest.nodes.find(n => n.id === 'n-v')!
    assert.equal(vec.unit, 'um')
    assert.equal(vec.semantics, '沿模头横向的膜厚分布')
    assert.equal(vec.fields[0]!.label, '膜厚断面')
    assert.equal(vec.fields[0]!.points?.[2]?.label, '模头点3')
    assert.ok(manifest.merged_file?.endsWith('merged.csv'))
    const readme = readFileSync(join(dir, 'README.md'), 'utf8')
    assert.match(readme, /物理意义/)
    assert.match(readme, /膜厚断面/)
    assert.match(readme, /模头点2/)
    // 向量宽表
    const vecCsv = readFileSync(join(dir, 'n-v', 'data.csv'), 'utf8').split(/\r?\n/)
    assert.equal(vecCsv[0], 'ts,v0,v1,v2')
    assert.equal(vecCsv[1], '2026-10-19T00:00:00.000Z,35.1,35.2,35.3')
  }
  finally {
    process.env.AW_MES_EXPORT_ROOT = prev
    rmSync(root, { recursive: true, force: true })
  }
})

test('mes_export:图像格式导出 frames/ 原文件 + records.jsonl 元数据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-mes-export-'))
  const prev = process.env.AW_MES_EXPORT_ROOT
  process.env.AW_MES_EXPORT_ROOT = root
  try {
    const c = controller([node('n-img', 'CCD相机', 'image')])
    const r = await c.exportData('agent-a', { ids: ['n-img'], from: FROM, to: TO, max_rows: 10, folder: 'images' })
    assert.ok(!r.isError, r.text)
    const dir = join(root, 'images')
    const frameDir = join(dir, 'n-img', 'frames')
    assert.ok(existsSync(frameDir))
    const files = readdirSync(frameDir)
    assert.equal(files.length, 2)
    assert.equal(readFileSync(join(frameDir, files[0]!), 'utf8'), 'fake-a')
    const jsonl = readFileSync(join(dir, 'n-img', 'records.jsonl'), 'utf8').trim().split('\n')
    assert.equal(jsonl.length, 2)
    const first = JSON.parse(jsonl[0]!) as { file: string, record: { defects: number } }
    assert.match(first.file, /^frames\//)
    assert.equal(first.record.defects, 1)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      nodes: Array<{ format: string, frames: { saved: number }, fields: Array<{ label: string }> }>
    }
    assert.equal(manifest.nodes[0]!.format, 'image')
    assert.equal(manifest.nodes[0]!.frames.saved, 2)
    assert.equal(manifest.nodes[0]!.fields[0]!.label, 'CCD 图像帧')
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /CCD 图像帧/)
  }
  finally {
    process.env.AW_MES_EXPORT_ROOT = prev
    rmSync(root, { recursive: true, force: true })
  }
})

test('mes_export:folder 路径逃逸被拒绝(不写出根目录)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-mes-export-'))
  const prev = process.env.AW_MES_EXPORT_ROOT
  process.env.AW_MES_EXPORT_ROOT = root
  try {
    const c = controller([node('n-p', '熔体压力', 'scalar')])
    const r = await c.exportData('agent-a', { ids: ['n-p'], from: FROM, to: TO, folder: '../escape' })
    assert.equal(r.isError, true)
    assert.match(r.text, /越出允许根目录/)
    assert.equal(existsSync(join(root, '..', 'escape')), false)
  }
  finally {
    process.env.AW_MES_EXPORT_ROOT = prev
    rmSync(root, { recursive: true, force: true })
  }
})
