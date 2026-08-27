/**
 * useDaqStream —— 服务端数据采集流的前端单一消费口。
 *
 * 数据权威在 server:节点列表 REST 快照(GET /api/workshop/daq)+ WS 实时帧增量收敛
 * (daq.reading 采样 / daq.node.changed 变更 / daq.controller 总控,均经 townBus 旁路)。
 * 进入数字孪生空间 load() 建立基线后,渲染完全由 server 数据驱动:
 * 有多少 Node,界面就有多少数采节点;历史环形缓冲(hist)由读数流逐帧填充。
 */
import { reactive } from 'vue'
import { useTownBus } from './useTownBus'
import type { AepEnvelope } from '#shared/workshop-protocol'
import type { AepDaqControllerState, AepDaqReading, AepDaqNodeChange, DaqNodeView } from '#shared/daq-protocol'

/** 历史缓冲长度(1s 默认周期 ≈ 最近 5 分钟趋势) */
const HIST_CAP = 60

/** 展示态:本地追加"实时性"字段(view 同构 + 趋势缓冲) */
export interface DaqNodeLive extends DaqNodeView {
  hist: number[]
}

interface DaqControllerState {
  running: boolean
  defaultIntervalMs: number
  nodesTotal: number
  nodesOnline: number
  produced?: number
  consumed?: number
  dropped?: number
  samplesStored?: number
}

/** 后端能力自描述(REST meta;采集管线不可见的部分在这里诚实可见) */
interface DaqBackendMeta {
  tsdb: string
  queue: string
  drivers: Array<{ kind: string, label: string, status: 'builtin' | 'planned' | 'real' }>
  produced: number
  consumed: number
  dropped: number
  samplesStored: number
  /** 协议栈可用性(包缺失 false) */
  driverAvailable?: Record<string, boolean>
  infra?: DaqInfraState
}

export interface DaqDriverTestResult { ok: boolean, message: string, sampleValue?: number, latencyMs?: number }

/** 基础设施状态(MQTT/Timescale 在线;降级 → 横幅 + 重连) */
export interface DaqInfraState {
  mqttOnline: boolean
  tsdbOnline: boolean
  degraded: boolean
  warning: string
  startedBy: 'docker' | 'direct' | 'none'
  lastCheckAt: string
  lastError?: string
}

export interface DaqTsdbPoint { at: number, value?: number, avg?: number, min?: number, max?: number, cnt?: number, state?: string }

function headers(json = true): Record<string, string> {
  const cookieToken = typeof document !== 'undefined'
    ? (document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? '')
    : ''
  const h: Record<string, string> = {}
  if (cookieToken) h.authorization = `Bearer ${decodeURIComponent(cookieToken)}`
  if (json) h['content-type'] = 'application/json'
  return h
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/workshop/daq${path}`, { headers: headers(), ...init })
  const json = await res.json().catch(() => ({}))
  if (json?.code !== 0) throw new Error(json?.message ?? `daq api 失败: ${res.status}`)
  return json.data as T
}

function createStore() {
  const nodes = reactive<DaqNodeLive[]>([])
  const controller = reactive<DaqControllerState>({ running: true, defaultIntervalMs: 1000, nodesTotal: 0, nodesOnline: 0 })
  const meta = reactive<DaqBackendMeta>({
    tsdb: '…', queue: '…', drivers: [], driverAvailable: {},
    infra: undefined,
    produced: 0, consumed: 0, dropped: 0, samplesStored: 0,
  })
  const state = reactive({ loaded: false, error: '' })

  function upsert(node: DaqNodeView): void {
    const i = nodes.findIndex(x => x.id === node.id)
    if (i >= 0) {
      // 就地合并:保留客户端 hist(WS 读数连续性优于服务端重建)
      nodes[i] = Object.assign(nodes[i]!, node)
    }
    else {
      nodes.push({ ...node, hist: [] })
    }
  }

  function applyChange(p: AepDaqNodeChange): void {
    if (p.node) {
      if (p.op === 'removed') {
        const i = nodes.findIndex(x => x.id === p.node!.id)
        if (i >= 0) nodes.splice(i, 1)
        return
      }
      upsert(p.node)
    }
  }

  function applyReading(p: AepDaqReading): void {
    const n = nodes.find(x => x.id === p.nodeId)
    if (!n) return
    n.value = p.value
    n.state = p.state
    n.lastAt = p.at
    n.hist.push(p.value)
    if (n.hist.length > HIST_CAP) n.hist.splice(0, n.hist.length - HIST_CAP)
  }

  /** 挂 WS 帧(townBus);幂等(globalThis 防重复订阅)。返回退订函数。 */
  function ensureWsFeed(): () => void {
    const g = globalThis as typeof globalThis & { __daqBusFed?: boolean }
    if (g.__daqBusFed) return () => {}
    g.__daqBusFed = true
    return useTownBus().subscribe((e: AepEnvelope) => {
      if (e.type === 'daq.reading') applyReading(e.payload as AepDaqReading)
      else if (e.type === 'daq.node.changed') applyChange(e.payload as AepDaqNodeChange)
      else if (e.type === 'daq.controller') Object.assign(controller, e.payload as AepDaqControllerState)
    })
  }

  async function load(): Promise<void> {
    try {
      const data = await api<{ controller: DaqControllerState, nodes: DaqNodeView[], meta: DaqBackendMeta, driverAvailable?: Record<string, boolean> }>('')
      // 快照合并:hist 是客户端读数流资产,轮询重载不得清零(按 id 迁移旧缓冲)
      const prevHist = new Map(nodes.map(n => [n.id, n.hist]))
      nodes.splice(0, nodes.length, ...data.nodes.map(n => ({ ...n, hist: prevHist.get(n.id) ?? [] })))
      Object.assign(controller, data.controller)
      Object.assign(meta, data.meta ?? {})
      meta.driverAvailable = data.driverAvailable ?? {}
      meta.infra = data.infra
      state.loaded = true
      state.error = ''
    }
    catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
    }
  }

  async function createFromTemplate(templateRef: string, opts?: { name?: string, posX?: number, posZ?: number }): Promise<DaqNodeView> {
    const data = await api<{ node: DaqNodeView }>('', {
      method: 'POST',
      body: JSON.stringify({ templateRef, ...opts }),
    })
    upsert(data.node)
    return data.node
  }

  async function patchNode(id: string, patch: Record<string, unknown>): Promise<void> {
    await api(`/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }

  async function saveTransform(id: string, posX?: number, posZ?: number): Promise<void> {
    await api(`/${id}`, { method: 'PATCH', body: JSON.stringify({ posX, posZ }) })
  }

  async function removeNode(id: string): Promise<void> {
    await api(`/${id}`, { method: 'DELETE' })
    const i = nodes.findIndex(x => x.id === id)
    if (i >= 0) nodes.splice(i, 1)
  }

  async function bindNode(id: string, deviceId: string | null): Promise<void> {
    const data = await api<{ node: DaqNodeView }>(`/${id}/bind`, {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    })
    upsert(data.node)
  }

  async function testDriver(driver: string, driverConfig: Record<string, string | number | boolean>): Promise<DaqDriverTestResult> {
    const data = await api<{ test: DaqDriverTestResult }>('/test-driver', {
      method: 'POST',
      body: JSON.stringify({ driver, driverConfig }),
    })
    return data.test
  }

  async function testNode(id: string): Promise<DaqDriverTestResult> {
    const data = await api<{ test: DaqDriverTestResult }>(`/${id}/test`, { method: 'POST' })
    return data.test
  }

  /** 手动重连基础设施(探测→Docker 拉起→重建后端→恢复采集);随后刷新基线 */
  async function reconnectInfra(): Promise<DaqInfraState | null> {
    const data = await api<{ infra: DaqInfraState }>('/infra/reconnect', { method: 'POST' })
    meta.infra = data.infra
    await load()
    return data.infra
  }

  async function controllerAction(action: 'start' | 'stop' | 'config', defaultIntervalMs?: number): Promise<void> {
    const data = await api<{ controller: DaqControllerState }>('/controller', {
      method: 'POST',
      body: JSON.stringify({ action, defaultIntervalMs }),
    })
    Object.assign(controller, data.controller)
  }

  /** 节点历史(时序库查询;bucketMs 给出则返回桶聚合) */
  async function samplesOf(id: string, opts: { fromMs?: number, toMs?: number, bucketMs?: number, limit?: number } = {}): Promise<DaqTsdbPoint[]> {
    const qs = new URLSearchParams()
    if (opts.fromMs != null) qs.set('from', String(opts.fromMs))
    if (opts.toMs != null) qs.set('to', String(opts.toMs))
    if (opts.bucketMs != null) qs.set('bucketMs', String(opts.bucketMs))
    if (opts.limit != null) qs.set('limit', String(opts.limit))
    const data = await api<{ points: DaqTsdbPoint[] }>(`/${id}/samples?${qs.toString()}`)
    return data.points ?? []
  }

  return reactive({
    nodes,
    controller,
    meta,
    ...state,
    ensureWsFeed,
    load,
    createFromTemplate,
    testDriver,
    testNode,
    reconnectInfra,
    patchNode,
    saveTransform,
    removeNode,
    bindNode,
    controllerAction,
    nodeById: (id: string): DaqNodeLive | undefined => nodes.find(n => n.id === id),
    samplesOf,
    ofDevice: (deviceId: string | null): DaqNodeLive[] =>
      deviceId ? nodes.filter(n => n.deviceBindingId === deviceId) : [],
  })
}

type DaqStreamStore = ReturnType<typeof createStore>

const GLOBAL_KEY = '__daqStream'

/** 单例(globalThis 挂载;跨组件/跨页面安全) */
export function useDaqStream(): DaqStreamStore {
  const g = globalThis as typeof globalThis & Record<string, unknown>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  return g[GLOBAL_KEY] as DaqStreamStore
}
