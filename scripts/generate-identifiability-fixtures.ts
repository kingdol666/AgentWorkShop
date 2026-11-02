/**
 * 可辨识性事故回放夹具生成器(P0,docs/plans/2026-11-02-scientific-exploration-plan.md)。
 *
 * 真实帧库随实例清场不可复取时,按事故参数确定性重构(种子固定,输出逐字节可复现):
 *   - 吹压 SP 2.6 → 2.4 bar(单步干预,与作业后半段完全共线的原始形态)
 *   - 目标(壁厚)含 4.71 min 主导振荡 + 高斯噪声
 *   - 预窗 35 min(参照事故 06:19–06:54 写前段),响应窗 47 s(参照探索 settle 45–47s)
 * 验收口径(tests/identifiability.test.ts):引擎对该夹具必须输出 UNDERPOWERED +
 * suggestedWindowMs ≈ 3×周期 ≈ 14.1 min —— 即"这次事故 100% 会被门禁挡住"的可执行断言。
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/generate-identifiability-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tests', 'fixtures', 'identifiability-incident-replay.json')

interface FixtureMeta {
  seed: number
  beatMs: number
  periodMin: number
  amplitude: number
  noiseStd: number
  baseline: number
  preMinutes: number
  settleSeconds: number
  spFrom: number
  spTo: number
  reference: string
}

const meta: FixtureMeta = {
  seed: 20261102,
  beatMs: 1000,
  periodMin: 4.71,
  amplitude: 0.05,
  noiseStd: 0.002,
  baseline: 0.28,
  preMinutes: 35,
  settleSeconds: 47,
  spFrom: 2.6,
  spTo: 2.4,
  reference: '事故参数重构(2026-11-02 会话核验):吹压SP 2.6→2.4 bar 单步干预;壁厚 4.71min 主导振荡;探索响应窗 47s;预窗参照 06:19–06:54(35min)',
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296
  }
}

/** Box-Muller 高斯噪声(确定性) */
function gaussianStream(seed: number): () => number {
  const uni = mulberry32(seed)
  let spare: number | null = null
  return () => {
    if (spare != null) {
      const v = spare
      spare = null
      return v
    }
    const u1 = Math.max(1e-12, uni())
    const u2 = uni()
    const mag = Math.sqrt(-2 * Math.log(u1))
    spare = mag * Math.sin(2 * Math.PI * u2)
    return mag * Math.cos(2 * Math.PI * u2)
  }
}

function build(): { target: { pre: number[], post: number[] }, control: { pre: number[], post: number[] } } {
  const periodBeats = meta.periodMin * 60_000 / meta.beatMs
  const nPre = meta.preMinutes * 60_000 / meta.beatMs
  const nPost = meta.settleSeconds * 1000 / meta.beatMs
  const gauss = gaussianStream(meta.seed)
  const sample = (i: number, phaseOffset: number): number =>
    meta.baseline + meta.amplitude * Math.sin((2 * Math.PI * i) / periodBeats + phaseOffset) + meta.noiseStd * gauss()
  const pre: number[] = []
  for (let i = 0; i < nPre; i++) pre.push(Number(sample(i, 0).toFixed(6)))
  const post: number[] = []
  for (let i = 0; i < nPost; i++) post.push(Number(sample(i, 0.7).toFixed(6)))
  return {
    target: { pre, post },
    control: { pre: new Array<number>(nPre).fill(meta.spFrom), post: new Array<number>(nPost).fill(meta.spTo) },
  }
}

const fixture = { meta, targetNodeId: 'sim-wall-thickness', controlNodeId: 'sim-blow-pressure-sp', ...build() }
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(fixture))
console.log(`fixture written: ${OUT}`)
console.log(`pre=${fixture.target.pre.length} beats, post=${fixture.target.post.length} beats, periodBeats=${meta.periodMin * 60000 / meta.beatMs}`)
