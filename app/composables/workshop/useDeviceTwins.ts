/**
 * useDeviceTwins —— 数字孪生设备(前端注册表 + REST 拉取/创建/控制/遥测)。
 *
 * 职责:
 *  - 拉取设备列表(GET /api/workshop/device-twins);
 *  - 拖模型进 3D 场景时创建设备(POST)+ 绑定实体模型 modelRef;
 *  - 下发指令(POST /:id/control)、推送遥测(POST /:id/telemetry);
 *  - 轮询刷新 telemetry/state(驱动 3D 设备节点颜色/偏移)。
 * 单例挂 globalThis,跨组件安全;store 为 reactive(异步刷新后驱动组件重渲染)。
 */
import { reactive } from 'vue'
import { apiFetch } from './apiClient'

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
  /** 3D 场景落点 / 朝向 / 缩放(undefined = 未放入场景) */
  posX?: number
  posZ?: number
  rotationY?: number
  scale?: number
  /** 所属产线(数采/智控节点;场景光晕分色) */
  lineId?: string
  /** 产线光晕色(Hex) */
  lineColor?: string
  updatedAt: string
}

const GLOBAL_KEY = '__deviceTwins'

/** 设备孪生 scene transform 补丁(供拖拽/滑杆结束防抖保存) */
export interface DeviceTransformPatch {
  name?: string
  modelRef?: string
  posX?: number
  posZ?: number
  rotationY?: number
  scale?: number
}

interface DeviceTwinStore {
  twins: DeviceTwinView[]
  loaded: boolean
  error: string
  /** in-flight 请求 promise(去重用) */
  __loading?: Promise<void> | null
  load(): Promise<void>
  applyRemote(twin: DeviceTwinView): void
  removeRemote(id: string): void
  byId(id: string): DeviceTwinView | undefined
  create(input: { name: string, modelRef?: string, workspaceId?: string, kind?: string, controls?: string[], telemetry?: Record<string, number | string | boolean>, posX?: number, posZ?: number, rotationY?: number, scale?: number }): Promise<DeviceTwinView>
  update(id: string, patch: DeviceTransformPatch): Promise<DeviceTwinView>
  control(id: string, command: string, args?: Record<string, unknown>): Promise<DeviceTwinView>
  pushTelemetry(id: string, telemetry: Record<string, number | string | boolean>): Promise<DeviceTwinView>
  remove(id: string): Promise<void>
}

function createStore(): DeviceTwinStore {
  const twins: DeviceTwinView[] = []
  const store: DeviceTwinStore = reactive({
    twins,
    loaded: false,
    error: '',
    async load() {
      // in-flight 去重:多消费方同帧触发只发一次请求(轮询 + 事件回灌叠加期防请求风暴)
      if (store.__loading) return store.__loading
      store.__loading = (async () => {
        try {
          const data = await apiFetch<{ twins: DeviceTwinView[] }>({ base: '/api/workshop/device-twins', retries: 2 })
          // 经 reactive 代理变更,驱动 DeviceTwinPanel 等组件重渲染
          store.twins.splice(0, store.twins.length, ...(data?.twins ?? []))
          store.loaded = true
          store.error = ''
        }
        catch (err) {
          // 失败不再静默清空:保留旧数据 + 置错误态(apiFetch 归一化网络/HTTP/业务错误)
          store.loaded = false
          store.error = err instanceof Error ? err.message : String(err)
        }
        finally {
          store.__loading = null
        }
      })()
      return store.__loading
    },
    /** WS 增量合并(device.updated 事件直推;免全量重拉) */
    applyRemote(twin: DeviceTwinView) {
      const i = store.twins.findIndex(t => t.id === twin.id)
      if (i >= 0) Object.assign(store.twins[i]!, twin)
      else store.twins.push({ ...twin })
    },
    /** WS 删除收敛 */
    removeRemote(id: string) {
      const i = store.twins.findIndex(t => t.id === id)
      if (i >= 0) store.twins.splice(i, 1)
    },
    byId(id) {
      return twins.find(t => t.id === id)
    },
    async create(input) {
      const data = await apiFetch<{ twin: DeviceTwinView }>({ base: '/api/workshop/device-twins', init: { method: 'POST', body: JSON.stringify(input) } })
      store.loaded = false
      await store.load()
      return data.twin
    },
    async update(id, patch) {
      const data = await apiFetch<{ twin: DeviceTwinView }>({ base: `/api/workshop/device-twins/${id}`, init: { method: 'PATCH', body: JSON.stringify(patch) } })
      store.loaded = false
      await store.load()
      return data.twin
    },
    async control(id, command, args) {
      const data = await apiFetch<{ twin: DeviceTwinView }>({ base: `/api/workshop/device-twins/${id}/control`, init: { method: 'POST', body: JSON.stringify({ command, args: args ?? {} }) } })
      store.loaded = false
      await store.load()
      return data.twin
    },
    async pushTelemetry(id, telemetry) {
      const data = await apiFetch<{ twin: DeviceTwinView }>({ base: `/api/workshop/device-twins/${id}/telemetry`, init: { method: 'POST', body: JSON.stringify({ telemetry }) } })
      store.loaded = false
      await store.load()
      return data.twin
    },
    async remove(id) {
      await apiFetch({ base: `/api/workshop/device-twins/${id}`, init: { method: 'DELETE' } })
      store.loaded = false
      await store.load()
    },
  })
  return store
}

export function useDeviceTwins(): DeviceTwinStore {
  const g = globalThis as unknown as Record<string, DeviceTwinStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  const store = g[GLOBAL_KEY]!
  void store.load()
  return store
}
