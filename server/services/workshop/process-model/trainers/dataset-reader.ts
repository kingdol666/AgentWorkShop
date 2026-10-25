/**
 * 数据集读取器(训练器共用):读 manifest + f32 数组,并提供反归一化。
 * 训练在**物理单位**上做辨识,归一化统计只作为来源元数据导出(避免把训练统计
 * 误当成模型语义)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DatasetView {
  dir: string
  manifest: Record<string, unknown>
  H: number
  P: number
  nAll: number
  nCtrl: number
  nTgt: number
  N: number
  allNodes: string[]
  controlNodes: string[]
  targetNodes: string[]
  norm: { x: { mean: number[], std: number[] }, u: { mean: number[], std: number[] }, y: { mean: number[], std: number[] } }
  x: Float32Array
  u: Float32Array
  y: Float32Array
  split: { train: number, val: number, test: number, trainRunIds: string[], valRunIds: string[], testRunIds: string[] }
  /** 切分块契约(SW2.3):v2 manifest 提供;v1 旧数据集为 [](等价于按 run 切分的隐含行为) */
  blocks: Array<{ blockId: string, runId: string, split: 'train' | 'val' | 'test', purgeBeforeSteps: number, purgeAfterSteps: number, uniqueSteps: number }>
  beatMs: number
}

export function readDataset(dir: string): DatasetView {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const shapes = manifest.shapes as { x: [number, number, number], u: [number, number, number], y: [number, number, number] }
  const split = manifest.split as DatasetView['split']
  const norm = manifest.norm as DatasetView['norm']
  const [N, H, nAll] = shapes.x
  const [, P, nCtrl] = shapes.u
  const nTgt = shapes.y[2]
  const readF32 = (name: string, expected: number): Float32Array => {
    const buf = readFileSync(join(dir, 'arrays', name))
    const arr = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
    if (arr.length !== expected) throw new Error(`数据集 ${name} 长度 ${arr.length} 与 manifest 期望 ${expected} 不一致`)
    return arr
  }
  return {
    dir, manifest, H, P, nAll, nCtrl, nTgt, N,
    allNodes: manifest.allNodes as string[],
    controlNodes: manifest.controlNodes as string[],
    targetNodes: manifest.targetNodes as string[],
    norm,
    x: readF32('x.f32', N * H * nAll),
    u: readF32('u.f32', N * P * nCtrl),
    y: readF32('y.f32', N * P * nTgt),
    split,
    blocks: Array.isArray((split as Record<string, unknown>).blocks)
      ? (split as unknown as { blocks: DatasetView['blocks'] }).blocks
      : [],
    beatMs: Number(manifest.beatMs),
  }
}

/** 取第 n 个窗口、历史第 h 步、列 j 的物理值。 */
export function pvX(ds: DatasetView, n: number, h: number, j: number): number {
  const raw = ds.x[(n * ds.H + h) * ds.nAll + j] ?? 0
  return raw * (ds.norm.x.std[j] ?? 1) + (ds.norm.x.mean[j] ?? 0)
}
export function pvU(ds: DatasetView, n: number, p: number, j: number): number {
  const raw = ds.u[(n * ds.P + p) * ds.nCtrl + j] ?? 0
  return raw * (ds.norm.u.std[j] ?? 1) + (ds.norm.u.mean[j] ?? 0)
}
export function pvY(ds: DatasetView, n: number, p: number, j: number): number {
  const raw = ds.y[(n * ds.P + p) * ds.nTgt + j] ?? 0
  return raw * (ds.norm.y.std[j] ?? 1) + (ds.norm.y.mean[j] ?? 0)
}

export function splitRange(ds: DatasetView, part: 'train' | 'val' | 'test'): { start: number, end: number } {
  if (part === 'train') return { start: 0, end: ds.split.train }
  if (part === 'val') return { start: ds.split.train, end: ds.split.train + ds.split.val }
  return { start: ds.split.train + ds.split.val, end: ds.split.train + ds.split.val + ds.split.test }
}
