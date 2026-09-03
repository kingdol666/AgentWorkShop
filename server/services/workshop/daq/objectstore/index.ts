/**
 * DaqObjectStore 工厂 —— 配置驱动,MinIO 不可达自动降级本地磁盘。
 * 单例挂 globalThis;rebuildObjectStore() 支持重连时切回真实实例(与 tsdb 工厂同构)。
 */
import { createLogger } from '../../logger'
import { DiskObjectAdapter } from './disk.adapter'
import { MinioObjectAdapter } from './minio.adapter'
import type { DaqObjectStore } from './objectstore-port'

const log = createLogger('daq.objectstore')

interface DaqOsState { current?: DaqObjectStore }
const g = globalThis as typeof globalThis & { __daqObjectStoreState?: DaqOsState }

/**
 * 解析对象存储连接(DAQ_OS_URL 显式覆盖优先):
 *   http://accessKey:secretKey@host:port/bucket
 */
export function parseObjectStoreUrl(url: string): { endPoint: string, port: number, accessKey: string, secretKey: string, bucket: string } | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return {
      endPoint: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
      accessKey: decodeURIComponent(u.username || 'awshop'),
      secretKey: decodeURIComponent(u.password || 'awshop'),
      bucket: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'daq',
    }
  }
  catch {
    return null
  }
}

function makeFallback(reason: string): DaqObjectStore {
  const dev = new DiskObjectAdapter()
  void dev.init()
  log.warn(`[daq-objectstore] ${reason} → 已降级本地磁盘(data/daq-objects/)`)
  return dev
}

export function getObjectStore(): DaqObjectStore {
  const st: DaqOsState = g.__daqObjectStoreState ??= {}
  let cur = st.current
  if (!cur) {
    cur = new DiskObjectAdapter()
    void cur.init()
    log.info('[daq-objectstore] 本地磁盘对象存储就绪(data/daq-objects/)')
    st.current = cur
  }
  return cur
}

/** 重连/初始装配:online 且 url 可解析 → MinIO(5×2.5s 重试扛容器初始化窗口);否则磁盘降级 */
export async function rebuildObjectStore(online: boolean, url?: string | null): Promise<void> {
  const st: DaqOsState = g.__daqObjectStoreState ??= {}
  const swap = (next: DaqObjectStore): void => {
    const old = st.current
    st.current = next
    void Promise.resolve(old?.close?.()).catch(() => {})
  }
  const parsed = url ? parseObjectStoreUrl(url) : null
  if (!online || !parsed) {
    if (st.current?.backend !== 'disk') swap(makeFallback('infra 判定离线或未配置'))
    return
  }
  const adapter = new MinioObjectAdapter(parsed)
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
    swap(makeFallback(lastErr instanceof Error ? lastErr.message : String(lastErr)))
    return
  }
  swap(adapter)
  log.info(`[daq-objectstore] MinIO 就绪(${parsed.endPoint}:${parsed.port}/${parsed.bucket})`)
}
