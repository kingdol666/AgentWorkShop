/**
 * TsdbPort 工厂 —— 配置驱动(daqInfraUrls 提供真实 Timescale URL),降级 SQLite 仿真。
 * 单例挂 globalThis;rebuildTsdb() 支持重连时从降级实例切回真实实例。
 */
import { createLogger } from '../../logger'
import { SqliteTimeSeriesAdapter } from './sqlite.adapter'
import { TimescaleAdapter } from './timescale.adapter'
import type { TsdbPort } from './tsdb-port'

const log = createLogger('daq.tsdb')

interface DaqTsdbState { current?: TsdbPort, initError?: unknown }
const g = globalThis as typeof globalThis & { __daqTsdbState?: DaqTsdbState }

function makeFallback(reason: string): TsdbPort {
  const dev = new SqliteTimeSeriesAdapter()
  dev.init()
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
      dev.init()
      st.current = dev
    }
    else {
      const adapter = new TimescaleAdapter(url)
      st.current = adapter
      void adapter.init().then(
        () => log.info('[daq-tsdb] TimescaleDB 就绪:', url.replace(/\/\/[^@]*@/, '//***@')),
        (err) => {
          if (g.__daqTsdbState?.current === adapter) {
            g.__daqTsdbState.current = makeFallback(err instanceof Error ? err.message : String(err))
          }
        },
      )
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
  log.info('[daq-tsdb] TimescaleDB 就绪:', url.replace(/\/\/[^@]*@/, '//***@'))
}
