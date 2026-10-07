/**
 * 内存水位监控(P0-4)—— 5 小时级慢泄漏 OOM(exit 134)的止血观测面。
 *
 * 30s 采样 heapUsed/rss/external;>75% warn(带较上次增量)、>90% error;
 * 采样环形序列周期落盘 <configRoot>/.runtime/last-mem.json —— 重启自愈后
 * 泄漏差分分析直接读该文件(0h vs Nh 增长对比),无需再挂探针压测。
 *
 * 限额取 v8.getHeapStatistics().heap_size_limit(实际生效的 --max-old-space-size,
 * 含 NODE_OPTIONS 传入);globalThis 守卫防 HMR 重复挂表,unref 不阻退出。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import v8 from 'node:v8'
import { ensureDataDir } from '@/shared/config/home.mjs'

interface MemSample { at: string, heapUsedMb: number, rssMb: number, externalMb: number, ratio: number }

const SAMPLE_MS = 30_000
const RING_CAP = 120 // 1h 窗口
const PERSIST_EVERY = 10 // 每 10 拍(5min)落盘一次
const WARN_RATIO = 0.75
const ERROR_RATIO = 0.9

const g = globalThis as typeof globalThis & {
  __awMemWatchTimer?: NodeJS.Timeout
  __awMemRing?: MemSample[]
}

function limitBytes(): number {
  try {
    return v8.getHeapStatistics().heap_size_limit
  }
  catch {
    return 0
  }
}

export function memorySnapshot(): { heapUsedMb: number, heapLimitMb: number, rssMb: number, externalMb: number, ratio: number } {
  const mu = process.memoryUsage()
  const limit = limitBytes()
  const heapLimitMb = Math.round(limit / 1048576)
  const heapUsedMb = Math.round(mu.heapUsed / 1048576)
  return {
    heapUsedMb,
    heapLimitMb,
    rssMb: Math.round(mu.rss / 1048576),
    externalMb: Math.round(mu.external / 1048576),
    ratio: limit > 0 ? Number((mu.heapUsed / limit).toFixed(4)) : 0,
  }
}

function persist(ring: MemSample[]): void {
  try {
    const dir = join(ensureDataDir(), '..', '.runtime')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'last-mem.json'), JSON.stringify({ limitMb: Math.round(limitBytes() / 1048576), samples: ring.slice(-RING_CAP) }, null, 2))
  }
  catch { /* 落盘失败不影响观测 */ }
}

export default function memoryWatchPlugin() {
  if (g.__awMemWatchTimer) return
  const ring: MemSample[] = g.__awMemRing ??= []
  let lastHeapUsedMb = 0
  let ticks = 0

  const sample = (): void => {
    const snap = memorySnapshot()
    const rec: MemSample = {
      at: new Date().toISOString(),
      heapUsedMb: snap.heapUsedMb,
      rssMb: snap.rssMb,
      externalMb: snap.externalMb,
      ratio: snap.ratio,
    }
    ring.push(rec)
    if (ring.length > RING_CAP) ring.shift()
    const deltaMb = rec.heapUsedMb - lastHeapUsedMb
    lastHeapUsedMb = rec.heapUsedMb
    if (rec.ratio >= ERROR_RATIO) {
      console.error(`[memory-watch] 堆水位 ${Math.round(rec.ratio * 100)}%(heap ${rec.heapUsedMb}/${Math.round(limitBytes() / 1048576)}MB,rss ${rec.rssMb}MB,${deltaMb >= 0 ? '+' : ''}${deltaMb}MB/30s)—— 逼近 OOM,观察自动重启`)
    }
    else if (rec.ratio >= WARN_RATIO) {
      console.warn(`[memory-watch] 堆水位 ${Math.round(rec.ratio * 100)}%(heap ${rec.heapUsedMb}MB,${deltaMb >= 0 ? '+' : ''}${deltaMb}MB/30s)`)
    }
    if (++ticks % PERSIST_EVERY === 0) persist(ring)
  }

  sample()
  g.__awMemWatchTimer = setInterval(sample, SAMPLE_MS)
  g.__awMemWatchTimer.unref?.()
}
