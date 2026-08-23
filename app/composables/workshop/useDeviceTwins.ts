/**
 * useDeviceTwins —— 数字孪生设备(前端注册表 + REST 拉取/创建/控制/遥测)。
 *
 * 职责:
 *  - 拉取设备列表(GET /api/workshop/device-twins);
 *  - 拖模型进 3D 场景时创建设备(POST)+ 绑定实体模型 modelRef;
 *  - 下发指令(POST /:id/control)、推送遥测(POST /:id/telemetry);
 *  - 轮询刷新 telemetry/state(驱动 3D 设备节点颜色/偏移)。
 * 单例挂 globalThis,跨组件安全。
 */

export interface DeviceTwinView {
  id: string
  workspaceId: string
  name: string
  modelRef: string
  boundAgentId: string | null
  kind: string
  telemetry: Record<string, number | string | boolean>
  desired: Record<string, number | string | boolean>
  state: 'idle' | 'running' | 'offline' | 'alarm'
  controls: string[]
  updatedAt: string
}

const GLOBAL_KEY = '__deviceTwins'

interface DeviceTwinStore {
  twins: DeviceTwinView[]
  loaded: boolean
  error: string
  load(): Promise<void>
  byId(id: string): DeviceTwinView | undefined
  create(input: { name: string, modelRef?: string, workspaceId?: string, kind?: string, controls?: string[] }): Promise<DeviceTwinView>
  control(id: string, command: string, args?: Record<string, unknown>): Promise<DeviceTwinView>
  pushTelemetry(id: string, telemetry: Record<string, number | string | boolean>): Promise<DeviceTwinView>
  remove(id: string): Promise<void>
}

function headers(json = true): Record<string, string> {
  const cookieToken = typeof document !== 'undefined'
    ? (document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? '')
    : ''
  const h: Record<string, string> = {}
  if (cookieToken) h.authorization = `Bearer ${decodeURIComponent(cookieToken)}`
  if (json) h['content-type'] = 'application/json'
  return h
}

function createStore(): DeviceTwinStore {
  const twins: DeviceTwinView[] = []
  const store: DeviceTwinStore = {
    twins,
    loaded: false,
    error: '',
    async load() {
      try {
        const res = await fetch('/api/workshop/device-twins', { headers: headers() })
        const json = await res.json().catch(() => ({}))
        twins.length = 0
        twins.push(...(json?.data?.twins ?? []))
        store.loaded = true
        store.error = ''
      }
      catch (err) {
        store.loaded = false
        store.error = err instanceof Error ? err.message : String(err)
      }
    },
    byId(id) {
      return twins.find(t => t.id === id)
    },
    async create(input) {
      const res = await fetch('/api/workshop/device-twins', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(input),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.data?.twin) throw new Error(json?.message ?? '创建设备失败')
      store.loaded = false
      await store.load()
      return json.data.twin
    },
    async control(id, command, args) {
      const res = await fetch(`/api/workshop/device-twins/${id}/control`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ command, args: args ?? {} }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.data?.twin) throw new Error(json?.message ?? '指令下发失败')
      store.loaded = false
      await store.load()
      return json.data.twin
    },
    async pushTelemetry(id, telemetry) {
      const res = await fetch(`/api/workshop/device-twins/${id}/telemetry`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ telemetry }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.data?.twin) throw new Error(json?.message ?? '遥测推送失败')
      store.loaded = false
      await store.load()
      return json.data.twin
    },
    async remove(id) {
      await fetch(`/api/workshop/device-twins/${id}`, { method: 'DELETE', headers: headers() })
      store.loaded = false
      await store.load()
    },
  }
  return store
}

export function useDeviceTwins(): DeviceTwinStore {
  const g = globalThis as unknown as Record<string, DeviceTwinStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  const store = g[GLOBAL_KEY]!
  void store.load()
  return store
}
