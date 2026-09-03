/**
 * DaqFrame 处理器注册表 —— 实时下沉处理(sink pipeline)的执行面。
 *
 * 模板 `sink.processors` 声明有序步骤,采样后、入队/入库前在生产侧按序执行
 * (图像 blob 不能过 MQTT 队列 → 全部 blob 处理必须在生产侧完成,消费侧只收元数据);
 * 处理器 = 纯函数式变换(working frame → working frame),内置 5 件,插件经
 * ctx.daq.registerProcessor 追加(同名覆盖并告警)。
 *
 * 内置处理器:
 *  - resample(n)       vector 重采样到 n 点(线性插值)
 *  - derive-metric     vector/image 派生标量指标(op=avg|min|max|range|std)
 *  - zones(n)          vector 分区统计(zone_i_min/max/avg 进 metrics)
 *  - thumbnail(width)  image 生成缩略图(thumbPng,最近邻抽点)
 *  - quality-gate      image 亮度统计(brightness/contrast 进 metrics)
 */
import { createLogger } from '../logger'
import { inflateSync } from 'node:zlib'
import { encodePng, resizeGray } from './png-enc'
import type { DaqSinkStep } from '../../../../shared/daq-protocol'

const log = createLogger('daq.frames')

/** 下沉管线的处理中帧(blob 仅在生产侧管线内存续,入队前被替换为 objectKey) */
export interface DaqFrameWorking {
  kind: 'vector' | 'image'
  /** vector:工程量点列 */
  points?: number[]
  /** image:原始 PNG blob(生产侧管线内;入队前剥离) */
  blob?: Buffer
  thumbBlob?: Buffer
  mime?: string
  width?: number
  height?: number
  metrics?: Record<string, number>
}

export interface DaqFrameProcessor {
  name: string
  /** 适用形态(any = 两种都吃) */
  applies: 'vector' | 'image' | 'any'
  process(frame: DaqFrameWorking, args: Record<string, unknown>): DaqFrameWorking
}

// ---------- 内置处理器 ----------

const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback)

function vectorStats(points: number[]): { min: number, max: number, avg: number } {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (const p of points) {
    if (p < min) min = p
    if (p > max) max = p
    sum += p
  }
  return { min, max, avg: points.length > 0 ? sum / points.length : 0 }
}

const resample: DaqFrameProcessor = {
  name: 'resample',
  applies: 'vector',
  process(frame, args) {
    const n = Math.max(2, Math.min(4096, Math.round(num(args.n, frame.points?.length ?? 64))))
    const src = frame.points ?? []
    if (src.length === n || src.length === 0) return { ...frame, points: src }
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const pos = (i * (src.length - 1)) / (n - 1)
      const lo = Math.floor(pos)
      const hi = Math.min(src.length - 1, lo + 1)
      const f = pos - lo
      out.push(src[lo]! * (1 - f) + src[hi]! * f)
    }
    return { ...frame, points: out }
  },
}

const deriveMetric: DaqFrameProcessor = {
  name: 'derive-metric',
  applies: 'any',
  process(frame, args) {
    const name = String(args.name ?? '').trim()
    if (!name) return frame
    const op = String(args.op ?? 'avg')
    let value: number
    if (frame.points && frame.points.length > 0) {
      const st = vectorStats(frame.points)
      value = op === 'min' ? st.min : op === 'max' ? st.max : op === 'range' ? st.max - st.min : op === 'std' ? stdOf(frame.points) : st.avg
    }
    else {
      value = num(frame.metrics?.[op], Number.NaN)
      if (!Number.isFinite(value)) return frame
    }
    return { ...frame, metrics: { ...frame.metrics, [name]: Math.round(value * 1e6) / 1e6 } }
  },
}

function stdOf(points: number[]): number {
  if (points.length === 0) return 0
  const avg = points.reduce((s, p) => s + p, 0) / points.length
  const v = points.reduce((s, p) => s + (p - avg) ** 2, 0) / points.length
  return Math.sqrt(v)
}

const zones: DaqFrameProcessor = {
  name: 'zones',
  applies: 'vector',
  process(frame, args) {
    const src = frame.points ?? []
    const n = Math.max(2, Math.min(64, Math.round(num(args.n, 8))))
    const size = Math.max(1, Math.floor(src.length / n))
    const metrics = { ...frame.metrics }
    for (let z = 0; z < n; z++) {
      const seg = src.slice(z * size, z === n - 1 ? src.length : (z + 1) * size)
      if (seg.length === 0) continue
      const st = vectorStats(seg)
      metrics[`zone${z + 1}_min`] = Math.round(st.min * 1e6) / 1e6
      metrics[`zone${z + 1}_max`] = Math.round(st.max * 1e6) / 1e6
      metrics[`zone${z + 1}_avg`] = Math.round(st.avg * 1e6) / 1e6
    }
    return { ...frame, metrics }
  },
}

const thumbnail: DaqFrameProcessor = {
  name: 'thumbnail',
  applies: 'image',
  process(frame, args) {
    const w = frame.width ?? 0
    const h = frame.height ?? 0
    if (!frame.blob || w <= 0 || h <= 0) return frame
    const tw = Math.max(16, Math.min(1024, Math.round(num(args.width, 256))))
    const th = Math.max(1, Math.round((h * tw) / w))
    // blob 为本仓 png-enc 的灰度 PNG:解不出像素时跳过(缩略图缺省,主图可达)
    const gray = decodeGrayPng(frame.blob, w, h)
    if (!gray) return frame
    const small = resizeGray(gray, w, h, tw, th)
    return { ...frame, thumbBlob: encodePng(tw, th, small), metrics: frame.metrics }
  },
}

/** 最小灰度 PNG 解码(仅支持本仓 encodePng 产出的 filter-0/8bit 灰度;其余返回 null) */
function decodeGrayPng(blob: Buffer, w: number, h: number): Uint8Array | null {
  try {
    // 定位 IDAT(跳签名+IHDR;本仓编码器结构固定,宽容解析)
    let off = 8
    const idat: Buffer[] = []
    while (off + 8 <= blob.length) {
      const len = blob.readUInt32BE(off)
      const type = blob.subarray(off + 4, off + 8).toString('ascii')
      if (type === 'IDAT') idat.push(blob.subarray(off + 8, off + 8 + len))
      off += 12 + len
    }
    if (idat.length === 0) return null
    const raw = inflateSync(Buffer.concat(idat))
    const stride = w + 1
    if (raw.length < stride * h) return null
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) out.set(raw.subarray(y * stride + 1, y * stride + 1 + w), y * w)
    return out
  }
  catch {
    return null
  }
}

const qualityGate: DaqFrameProcessor = {
  name: 'quality-gate',
  applies: 'image',
  process(frame) {
    const w = frame.width ?? 0
    const h = frame.height ?? 0
    if (!frame.blob || w <= 0 || h <= 0) return frame
    const gray = decodeGrayPng(frame.blob, w, h)
    if (!gray) return frame
    let sum = 0
    for (const v of gray) sum += v
    const brightness = sum / gray.length
    let varSum = 0
    for (const v of gray) varSum += (v - brightness) ** 2
    const contrast = Math.sqrt(varSum / gray.length)
    const r = (x: number): number => Math.round(x * 10) / 10
    return { ...frame, metrics: { ...frame.metrics, brightness: r(brightness), contrast: r(contrast) } }
  },
}

// ---------- 注册表 ----------

const builtin = new Map<string, DaqFrameProcessor>([resample, deriveMetric, zones, thumbnail, qualityGate].map(p => [p.name, p]))

const g = globalThis as typeof globalThis & { __daqFrameProcessors?: Map<string, DaqFrameProcessor> }
function registry(): Map<string, DaqFrameProcessor> {
  return g.__daqFrameProcessors ??= new Map()
}

/** 插件处理器注册(同名覆盖内置并告警;热重载时重复注册幂等) */
export function registerFrameProcessor(p: DaqFrameProcessor): void {
  if (builtin.has(p.name)) log.warn(`[daq-frames] 插件处理器覆盖内置:「${p.name}」`)
  registry().set(p.name, p)
}

/** 已注册处理器名清单(诊断/manifest 用) */
export function listFrameProcessors(): string[] {
  return [...builtin.keys(), ...registry().keys()]
}

/** 执行模板 sink 管线(生产侧;单步失败保留原帧并告警,永不抛出) */
export function runSinkPipeline(frame: DaqFrameWorking, steps: DaqSinkStep[] | undefined, nodeId: string): DaqFrameWorking {
  if (!steps || steps.length === 0) return frame
  let cur = frame
  for (const step of steps) {
    try {
      const p = registry().get(step.name) ?? builtin.get(step.name)
      if (!p) {
        log.warn(`[daq-frames] ${nodeId} 未知处理器「${step.name}」,跳过`)
        continue
      }
      if (p.applies !== 'any' && p.applies !== cur.kind) continue
      cur = p.process(cur, step.args ?? {})
    }
    catch (err) {
      log.error(`[daq-frames] ${nodeId} 处理器「${step.name}」失败(保留原帧):`, err instanceof Error ? err.message : err)
    }
  }
  return cur
}
