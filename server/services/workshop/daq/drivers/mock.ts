/**
 * mock 内置模拟源
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriver, DaqSampleCtx } from './shared'
import { encodePng } from '../png-enc'

// ============================================================
// mock 内置模拟源
// ============================================================

export const hashPhase = (id: string): number => {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 628
  return h
}

export interface MockState {
  phase: number
  value: number | null
  excursionLeft: number
  excursionDir: number
  excursionDepth: number
  lastAt: number
}

export const g = globalThis as typeof globalThis & { __daqMockStates?: Map<string, MockState> }
export function mockStates(): Map<string, MockState> {
  return g.__daqMockStates ??= new Map()
}

export const mockDaqDriver: DaqDriver = {
  kind: 'mock',
  async available() {
    return true
  },
  sample({ ctx, config, signalKind, vector }) {
    // 多形态分支(v2 帧管线):vector=多点波形轮廓;image=程序化灰度 PNG;scalar=既有单点波形
    if (signalKind === 'vector') return mockVectorSample(ctx, config, vector)
    if (signalKind === 'image') return mockImageSample(ctx, config)
    return mockScalarSample(ctx, config)
  },
  async test() {
    return { ok: true, message: 'Mock 驱动无需连接,采样即模拟波形' }
  },
}

/** 既有单点波形(原 sample() 主体,零行为变化) */
export function mockScalarSample(ctx: DaqSampleCtx, config: { base: number, amp: number, min: number, max: number }): number {
  const states = mockStates()
  let st = states.get(ctx.nodeId)
  if (!st) {
    st = { phase: hashPhase(ctx.nodeId), value: null, excursionLeft: 0, excursionDir: 0, excursionDepth: 0, lastAt: ctx.now }
    states.set(ctx.nodeId, st)
  }
  const dt = Math.max(0, Math.min(ctx.now - st.lastAt, 60_000))
  st.lastAt = ctx.now
  if (st.excursionLeft <= 0 && Math.random() < 0.008 * Math.max(1, dt / 1000)) {
    st.excursionLeft = 6 + Math.floor(Math.random() * 9)
    st.excursionDir = Math.random() < 0.5 ? -1 : 1
    st.excursionDepth = (config.max - config.min) * (0.08 + Math.random() * 0.1)
  }
  const t = (ctx.ageMs + st.phase * 100) / 1000
  const sine = Math.sin(t * 0.35) * config.amp * 0.55 + Math.sin(t * 0.11 + 1.3) * config.amp * 0.3
  let v = config.base + sine
  if (st.value != null) v += (config.base - st.value) * 0.06 + (Math.random() - 0.5) * config.amp * 0.5
  if (st.excursionLeft > 0) {
    st.excursionLeft -= 1
    const ramp = Math.min(1, (10 - st.excursionLeft) / 4)
    v += st.excursionDir * st.excursionDepth * (0.4 + 0.6 * ramp)
    if (st.excursionLeft === 0) st.excursionDir = 0
  }
  v = Math.min(config.max + config.amp * 2.2, Math.max(config.min - config.amp * 2.2, v))
  st.value = v
  return v
}

/** 多点波形轮廓(测厚仪/扫描仪语义:横向 n 点,带漂移与偶发局部尖峰) */
export function mockVectorSample(
  ctx: DaqSampleCtx,
  config: { base: number, amp: number, min: number, max: number },
  vector?: { points: number, min: number, max: number },
): { frame: { kind: 'vector', points: number[], metrics: Record<string, number> } } {
  const n = Math.max(2, Math.min(4096, vector?.points ?? 64))
  const vMin = vector?.min ?? config.min
  const vMax = vector?.max ?? config.max
  const span = vMax - vMin
  const t = (ctx.ageMs + hashPhase(ctx.nodeId) * 100) / 1000
  const points: number[] = []
  // 横向轮廓:慢波(工艺整体偏移)+ 位置抛物面(边缘偏厚)+ 噪声 + 偶发局部尖峰(缺陷)
  const drift = Math.sin(t * 0.21) * config.amp
  const spikePos = Math.floor((Math.sin(t * 0.07) * 0.5 + 0.5) * n)
  for (let i = 0; i < n; i++) {
    const rel = i / (n - 1)
    const crown = -4 * (rel - 0.5) ** 2 * span * 0.03 // 边缘略薄(负抛物面)
    let v = config.base + drift + crown + (Math.random() - 0.5) * config.amp * 0.4
    if (Math.abs(i - spikePos) <= 1) v += span * 0.06 // 偶发局部尖峰
    points.push(Math.round(Math.min(vMax, Math.max(vMin, v)) * 1e6) / 1e6)
  }
  return { frame: { kind: 'vector', points, metrics: {} } }
}

/** 程序化灰度图像(CCD 语义:纹理背景 + 移动暗斑;零外部依赖 zlib PNG) */
export function mockImageSample(
  ctx: DaqSampleCtx,
  config: { base: number, amp: number, min: number, max: number },
): { frame: { kind: 'image', blob: Buffer, mime: string, width: number, height: number, metrics: Record<string, number> } } {
  // 偶发"曝光异常"帧(低亮度)驱动 quality-gate 告警链路可观测
  const dark = Math.random() < 0.03
  const baseGray = dark ? 22 : Math.round(Math.min(230, Math.max(60, config.base)))
  const w = 320
  const h = 240
  const px = new Uint8Array(w * h)
  const t = (ctx.ageMs + hashPhase(ctx.nodeId) * 100) / 1000
  const spotX = Math.floor(((Math.sin(t * 0.4) + 1) / 2) * (w - 60)) + 30
  const spotY = Math.floor(((Math.cos(t * 0.3) + 1) / 2) * (h - 60)) + 30
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 编织纹理 + 随机噪声 + 移动暗斑(表面缺陷模拟)
      let v = baseGray + Math.sin(x * 0.35) * 8 + Math.sin(y * 0.22 + 1.7) * 6 + (Math.random() - 0.5) * 10
      const dx = x - spotX
      const dy = y - spotY
      const d2 = dx * dx + dy * dy
      if (d2 < 400) v -= (1 - d2 / 400) * 90
      px[y * w + x] = Math.max(0, Math.min(255, Math.round(v)))
    }
  }
  const blob = encodePng(w, h, px)
  return { frame: { kind: 'image', blob, mime: 'image/png', width: w, height: h, metrics: {} } }
}
