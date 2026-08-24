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
  const store: SceneLayoutStore = reactive({
    layouts: {},
    loaded: false,
    loading: false,
    error: '',
    async load() {
      // 每次真实拉取(不做 loaded 缓存):布局是高频变更的共享场景状态,
      // 缓存会让 WS 广播回调读到旧快照,把刚放置/他人编辑的频道在 rebuild 中清掉。
      if (store.loading) return
      store.loading = true
      try {
        const res = await fetch('/api/workshop/scene/layouts', { headers: headers() })
        const json = await res.json().catch(() => ({}))
        const list: SceneLayoutView[] = json?.data?.layouts ?? []
        const next: Record<string, SceneLayoutView> = {}
        for (const l of list) next[l.channelId] = l
        store.layouts = next
        store.loaded = true
        store.error = ''
      }
      catch (err) {
        store.loaded = false
        store.error = err instanceof Error ? err.message : String(err)
      }
      finally {
        store.loading = false
      }
    },
    byChannel(channelId) {
      return store.layouts[channelId]
    },
    async save(channelId, input) {
      const res = await fetch(`/api/workshop/scene/layouts/${channelId}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(input),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.data?.layout) throw new Error(json?.message ?? '保存频道布局失败')
      store.layouts[channelId] = json.data.layout
      return json.data.layout
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
    },
  })
  return store
}

export function useSceneLayouts(): SceneLayoutStore {
  const g = globalThis as unknown as Record<string, SceneLayoutStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  const store = g[GLOBAL_KEY]!
  void store.load()
  return store
}
