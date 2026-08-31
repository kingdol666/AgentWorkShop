/**
 * useSceneLayouts —— 频道领地放置(3D 小镇布局注册表)。
 *
 * 职责:
 *  - 拉取已放置频道清单(GET /api/workshop/scene/layouts);
 *  - 放置/更新领地(PUT /:channelId):拖频道入场景、编辑边界后落库;
 *  - 移除放置(DELETE /:channelId):把频道(及其 Agent)从场景撤出。
 * 场景初始为空场地;未放置的频道只出现在频道坞,不进入 3D。
 * 单例挂 globalThis,跨组件安全;store 为 reactive(驱动频道坞/选中面板重渲染)。
 */
import { reactive } from 'vue'

export interface SceneLayoutView {
  channelId: string
  /** 领地中心(世界坐标) */
  x: number
  z: number
  /** 边界半径(ellipse)/半宽(rect) */
  radiusX: number
  radiusZ: number
  shape: 'ellipse' | 'rect'
  rotationY: number
  updatedAt: string
}

const GLOBAL_KEY = '__sceneLayouts'

interface SceneLayoutStore {
  layouts: Record<string, SceneLayoutView>
  loaded: boolean
  loading: boolean
  error: string
  /** 布局数据版本号(load 成功/save/remove 时自增;供组件监听后幂等收敛重建) */
  rev: number
  load(): Promise<void>
  byChannel(channelId: string): SceneLayoutView | undefined
  save(channelId: string, input: { x: number, z: number, radiusX: number, radiusZ: number, shape?: 'ellipse' | 'rect', rotationY?: number }): Promise<SceneLayoutView>
  remove(channelId: string): Promise<void>
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

function createStore(): SceneLayoutStore {
  /** 在飞请求句柄:并发 load 等同一个真实请求(旧实现直接 return → 调用方拿空 layouts 去 hydrate,频道竞态消失) */
  let inFlight: Promise<void> | null = null
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

  const store: SceneLayoutStore = reactive({
    layouts: {},
    loaded: false,
    loading: false,
    error: '',
    rev: 0,

    async load() {
      if (!inFlight) {
        inFlight = doLoad().finally(() => {
          inFlight = null
        })
      }
      return inFlight
    },

    byChannel(channelId) {
      return store.layouts[channelId]
    },

    async save(channelId, input) {
      // 乐观写入:本地即刻生效(WS snapshot 重建不会清掉刚放置的频道),随后持久化重试
      store.layouts[channelId] = {
        channelId,
        x: input.x,
        z: input.z,
        radiusX: input.radiusX,
        radiusZ: input.radiusZ,
        shape: input.shape ?? 'ellipse',
        rotationY: input.rotationY ?? 0,
        updatedAt: new Date().toISOString(),
      }
      store.rev++
      let lastErr: Error | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`/api/workshop/scene/layouts/${channelId}`, {
            method: 'PUT',
            headers: headers(),
            body: JSON.stringify(input),
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok || !json?.data?.layout) throw new Error(json?.message ?? '保存频道布局失败')
          store.layouts[channelId] = json.data.layout
          // rev 不再自增:乐观写入已触发 hydrate,服务端回显仅对齐 updatedAt(同值),
          // 二次 rev 会让整场 resetAll+GLB 重载执行两遍(一次保存双倍重建)
          return json.data.layout
        }
        catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err))
          if (attempt < 2) await sleep(500 * (attempt + 1))
        }
      }
      throw lastErr ?? new Error('保存频道布局失败')
    },

    async remove(channelId) {
      const res = await fetch(`/api/workshop/scene/layouts/${channelId}`, {
        method: 'DELETE',
        headers: headers(),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? '移除频道放置失败')
      const next = Object.fromEntries(Object.entries(store.layouts).filter(([k]) => k !== channelId))
      store.layouts = next
      store.rev++
    },
  })

  /** 单次真实拉取(3 次退避重试;非 2xx 视为失败 —— 401/500 的空 layouts 曾让整场频道消失) */
  async function doLoad(): Promise<void> {
    store.loading = true
    let lastErr = ''
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch('/api/workshop/scene/layouts', { headers: headers() })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const json = await res.json().catch(() => ({}))
          const list: SceneLayoutView[] = json?.data?.layouts ?? []
          const next: Record<string, SceneLayoutView> = {}
          for (const l of list) next[l.channelId] = l
          store.layouts = next
          store.loaded = true
          store.error = ''
          store.rev++
          return
        }
        catch (err) {
          lastErr = err instanceof Error ? err.message : String(err)
          if (attempt < 2) await sleep(400 * (attempt + 1))
        }
      }
      store.loaded = false
      store.error = lastErr
    }
    finally {
      store.loading = false
    }
  }

  return store
}

export function useSceneLayouts(): SceneLayoutStore {
  const g = globalThis as unknown as Record<string, SceneLayoutStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  const store = g[GLOBAL_KEY]!
  void store.load()
  return store
}
