/**
 * TsdbPort 工厂 —— 配置驱动(daqInfraUrls 提供真实 Timescale URL),降级 SQLite 仿真。
 * 单例挂 globalThis;rebuildTsdb() 支持重连时从降级实例切回真实实例。
 *
 * 历史数据治理旁路(TimescaleRollupStore):
 *  - 与适配器共用同一 DAQ_TSDB_URL,负责逐产线保留期、1m/1h 聚合、跨保留期历史查询;
 *  - 适配器保持"热路径只读写原始表"的职责,两者故障域隔离;
 *  - 对外统一由本模块的 tsdbQueryHistory / tsdbLayoutInfo / tsdbRunRollup 等门面暴露,
 *    调用方不需要知道后端是否支持 rollup。
 */
import { createLogger } from '../../logger'
import { SqliteTimeSeriesAdapter } from './sqlite.adapter'
import { TimescaleAdapter } from './timescale.adapter'
import { TimescaleRollupStore } from './timescale-rollup'
import type {
  TsdbHistoryQuery,
  TsdbHistoryResult,
  TsdbLayoutInfo,
  TsdbPort,
  TsdbRetentionInfo,
  TsdbRetentionPatch,
  TsdbRollupResult,
} from './tsdb-port'
import { daqRuntimeSettings } from '../../settings'
import { rawCutoffMs } from './retention'

const log = createLogger('daq.tsdb')

interface DaqTsdbState { current?: TsdbPort, initError?: unknown }
const g = globalThis as typeof globalThis & {
  __daqTsdbState?: DaqTsdbState
  __daqRollupStore?: TimescaleRollupStore | null
}

function makeFallback(reason: string): TsdbPort {
  void detachRollupStore()
  const dev = new SqliteTimeSeriesAdapter()
  // init 失败不再静默:读路径有 ensureDb 惰性自愈兜底,但这里必须留下证据
  dev.init().catch(err => log.error(`[daq-tsdb] SQLite 降级实例初始化失败(读路径将自愈重试):`, err instanceof Error ? err.message : err))
  log.warn(`[daq-tsdb] ${reason} → 已降级 SQLite 时序仿真`)
  return dev
}

/** 就绪门:消费者可 await 后再批量写(真实 Timescale 异步建表完成前由门挡住) */
export const tsdbReady: Promise<void> = (() => {
  const st: DaqTsdbState = g.__daqTsdbState ??= {}
  if (!st.current) {
    const url = process.env.DAQ_TSDB_URL
    if (!url) {
      // 无配置(启动插件尚未装配):先占位仿真库;插件随后按 infra 状态 rebuild
      const dev = new SqliteTimeSeriesAdapter()
      dev.init().catch(err => log.error('[daq-tsdb] SQLite 占位实例初始化失败(读路径将自愈重试):', err instanceof Error ? err.message : err))
      st.current = dev
    }
    else {
      const adapter = new TimescaleAdapter(url)
      st.current = adapter
      void adapter.init().then(
        () => {
          log.info('[daq-tsdb] TimescaleDB 就绪:', url.replace(/\/\/[^@]*@/, '//***@'))
          return attachRollupStore(url)
        },
        (err) => {
          if (g.__daqTsdbState?.current === adapter) {
            g.__daqTsdbState.current = makeFallback(err instanceof Error ? err.message : String(err))
          }
        },
      ).catch(err => log.error('[daq-tsdb] 历史治理旁路装配失败(采集不受影响):', err instanceof Error ? err.message : err))
    }
  }
  return Promise.resolve()
})()

export function getTsdb(): TsdbPort {
  const st: DaqTsdbState = g.__daqTsdbState ??= {}
  let cur = st.current
  if (!cur) {
    cur = new SqliteTimeSeriesAdapter()
    void cur.init()
    log.info('[daq-tsdb] SQLite 时序仿真就绪(data/daq-timeseries.sqlite)')
    st.current = cur
  }
  return cur
}

/** 重连/初始装配:按 infra 判定结果(重新)构建真实或降级实例;旧实例显式释放连接 */
export async function rebuildTsdb(online: boolean, url?: string | null): Promise<void> {
  const st: DaqTsdbState = g.__daqTsdbState ??= {}
  const swap = (next: TsdbPort): void => {
    const old = st.current
    st.current = next
    // 旧池延后释放(在飞写自然失败一次即被消费侧重试收口)
    void Promise.resolve(old?.close?.()).catch(() => {})
  }
  if (!online || !url) {
    await detachRollupStore()
    if (st.current?.backend !== 'sqlite-emulated') {
      swap(makeFallback('infra 判定离线'))
    }
    return
  }
  const adapter = new TimescaleAdapter(url)
  // PG/Timescale 初始化窗口:接受 TCP 但建连即断(Connection terminated)→ 有限重试
  let lastErr: unknown
  for (let i = 0; i < 5; i++) {
    try {
      await adapter.init()
      lastErr = null
      break
    }
    catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 2500))
    }
  }
  if (lastErr) {
    await adapter.close?.().catch(() => {})
    throw lastErr
  }
  swap(adapter)
  await attachRollupStore(url)
  log.info('[daq-tsdb] TimescaleDB 就绪:', url.replace(/\/\/[^@]*@/, '//***@'))
}

async function attachRollupStore(url: string): Promise<void> {
  let s: ReturnType<typeof daqRuntimeSettings>
  try {
    s = daqRuntimeSettings()
  }
  catch (err) {
    log.error('[daq-tsdb] 读取保留期配置失败,跳过历史治理旁路:', err instanceof Error ? err.message : err)
    return
  }
  const store = new TimescaleRollupStore(url, {
    retentionH: s.tsRetentionH,
    frameRetentionH: s.frameRetentionH,
    minuteRetentionH: s.rollup.minuteRetentionH,
    hourRetentionH: s.rollup.hourRetentionH,
    enabled: s.rollup.enabled,
    lagMs: s.rollup.lagMs,
    windowMs: s.rollup.windowMs,
    maxWindowsPerRun: s.rollup.maxWindowsPerRun,
    poolMax: Math.min(4, s.timescale.poolMax),
  })
  try {
    await store.init()
  }
  catch (err) {
    // 旁路失败不阻断采集(原始样本仍可写/可查);但要留下证据,并由运维面暴露
    log.error('[daq-tsdb] 保留期/rollup 旁路初始化失败(采集不受影响):', err instanceof Error ? err.message : err)
    await store.close().catch(() => {})
    g.__daqRollupStore = null
    return
  }
  const old = g.__daqRollupStore
  g.__daqRollupStore = store
  await Promise.resolve(old?.close?.()).catch(() => {})
}

async function detachRollupStore(): Promise<void> {
  const old = g.__daqRollupStore
  g.__daqRollupStore = null
  await Promise.resolve(old?.close?.()).catch(() => {})
}

export function getRollupStore(): TimescaleRollupStore | null {
  return g.__daqRollupStore ?? null
}

/**
 * 跨保留期历史查询(统一门面):
 *  - 适配器自带 queryHistory → 用它;
 *  - Timescale 旁路已装配 → 1m/1h 聚合 + 原始段拼接;
 *  - SQLite 仿真 → 原始桶查询,并在 coverage 里显式说明"无历史聚合"。
 * 起止时间必填,调用方(Actor/页面)不得依赖隐式默认窗口。
 */
export async function tsdbQueryHistory(nodeId: string, q: TsdbHistoryQuery): Promise<TsdbHistoryResult> {
  const tsdb = getTsdb()
  if (typeof tsdb.queryHistory === 'function') return tsdb.queryHistory(nodeId, q)
  const store = getRollupStore()
  if (store) return store.queryHistory(nodeId, q)
  const limit = Math.max(1, Math.min(q.limit ?? 2000, 1_000_000))
  const points = await tsdb.query(nodeId, { fromMs: q.fromMs, toMs: q.toMs, bucketMs: q.bucketMs, limit })
  const rawRetentionH = daqRuntimeSettings().tsRetentionH
  const cutoff = rawCutoffMs(Date.now(), rawRetentionH)
  return {
    points,
    resolution: 'raw',
    coverage: {
      requestedFromMs: q.fromMs,
      requestedToMs: q.toMs,
      availableFromMs: points[0]?.at ?? null,
      rawFromMs: cutoff,
      truncated: points.length >= limit,
      note: q.fromMs < cutoff
        ? `窗口起点早于原始样本保留期(${rawRetentionH}h);当前后端没有历史聚合,该段不可查`
        : '原始样本窗口',
    },
  }
}

export function tsdbRetentionInfo(): TsdbRetentionInfo {
  const tsdb = getTsdb()
  if (typeof tsdb.retentionInfo === 'function') return tsdb.retentionInfo()
  const store = getRollupStore()
  if (store) return store.retentionInfo()
  return { rawRetentionH: daqRuntimeSettings().tsRetentionH, rollupEnabled: false, rollupResolutions: [] }
}

export async function tsdbLayoutInfo(): Promise<TsdbLayoutInfo> {
  const tsdb = getTsdb()
  if (typeof tsdb.layoutInfo === 'function') return tsdb.layoutInfo()
  const store = getRollupStore()
  if (store) return store.layoutInfo()
  const s = daqRuntimeSettings()
  return {
    backend: tsdb.backend,
    layout: 'single',
    rawRetentionH: s.tsRetentionH,
    frameRetentionH: s.frameRetentionH,
    rollup: { enabled: false, minuteRetentionH: s.rollup.minuteRetentionH, hourRetentionH: s.rollup.hourRetentionH, watermarks: {} },
    lines: [],
    legacy: null,
  }
}

/** 手动触发一轮增量聚合(插件定时器之外的运维入口) */
export async function tsdbRunRollup(): Promise<TsdbRollupResult | null> {
  const store = getRollupStore()
  if (store) return store.runRollup()
  const tsdb = getTsdb()
  if (typeof tsdb.runRollup === 'function') return tsdb.runRollup()
  return null
}

export async function tsdbSetLineRetention(lineId: string, patch: TsdbRetentionPatch): Promise<void> {
  const store = getRollupStore()
  if (store) return store.setLineRetention(lineId, patch)
  const tsdb = getTsdb()
  if (typeof tsdb.setLineRetention === 'function') return tsdb.setLineRetention(lineId, patch)
  throw new Error('当前后端不支持逐产线保留期(仅 Timescale 生产后端可用)')
}

/** 立即执行一轮清理(样本按线 + 聚合按分辨率) */
export async function tsdbSweepAll(): Promise<void> {
  const tsdb = getTsdb()
  if (typeof tsdb.sweepNow === 'function') await tsdb.sweepNow()
  const store = getRollupStore()
  if (store) await store.sweepNow()
}
