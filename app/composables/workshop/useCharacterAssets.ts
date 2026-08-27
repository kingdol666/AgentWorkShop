/**
 * useCharacterAssets —— 角色模型库(前端注册表 + REST 拉取/上传/绑定)。
 *
 * 职责:
 *  - 拉取服务端资产清单(GET /api/workshop/assets/character)并 merge 内置约定模型;
 *  - 上传新模型(POST /api/workshop/assets/character,multipart);
 *  - 删除模型(引删保护 DELETE):仍被绑定 → 提示 used>0;
 *  - 绑定模型到某 Agent(PATCH /api/workshop/channels/:cid/agents/:agentId/model)。
 * 单例挂 globalThis,跨组件安全;store 为 reactive(异步加载完成后驱动组件重渲染)。
 */
import { reactive } from 'vue'

export interface CharacterModel {
  id: string
  name: string
  file: string
  frames: number
  frameWidth: number
  frameHeight: number
  /** 模型类型:sheet(精灵表) / glb(3D 角色) / dev(3D 设备/数字孪生实体) */
  kind: 'sheet' | 'glb' | 'dev'
  builtin: boolean
  /** 是否被任一 agent 绑定(引删保护用) */
  applied: boolean
  hint?: string
  /** 设备模型相对高度系数(1 = 基准;薄膜产线设备按设计稿比例错落) */
  hFactor?: number
}

interface ApiAsset {
  id: string
  workspaceId: string
  name: string
  file: string
  kind: string
  sheet?: { frameWidth?: number, frameHeight?: number, frames?: number }
  appliedTo?: string[]
  author: string
}

const GLOBAL_KEY = '__characterAssets'

interface CharacterAssetStore {
  models: CharacterModel[]
  loaded: boolean
  loading: boolean
  error: string
  load(): Promise<void>
  byId(id: string): CharacterModel | undefined
  upload(file: File, opts: { name?: string, workspaceId?: string, frameWidth?: number, frameHeight?: number, frames?: number, kind?: string }): Promise<CharacterModel>
  remove(id: string): Promise<{ used: number }>
  /** 上传设备/实体 3D 模型(.glb/.gltf...)到 devices 目录(模型库即时可见) */
  uploadDevice(file: File, name?: string): Promise<CharacterModel>
  /** 删除设备模型文件(id = dev-folder-<base> 或 base) */
  removeDevice(id: string): Promise<void>
  bind(channelId: string, agentId: string, modelRef: string): Promise<void>
}

function fromApi(a: ApiAsset): CharacterModel {
  return {
    id: a.id,
    name: a.name,
    file: a.file,
    frames: a.sheet?.frames ?? 4,
    frameWidth: a.sheet?.frameWidth ?? 48,
    frameHeight: a.sheet?.frameHeight ?? 88,
    kind: a.kind === 'glb' ? 'glb' : a.kind === 'dev' ? 'dev' : 'sheet',
    builtin: a.author === 'system',
    applied: (a.appliedTo?.length ?? 0) > 0,
  }
}

function createStore(): CharacterAssetStore {
  const models: CharacterModel[] = []
  // 内置约定模型(与 server 全局库同源;空白兜底,主以 REST 为准)
  const builtins: CharacterModel[] = [
    { id: 'knight', name: '灰羽骑士', file: '/assets/game/character/knight.png', frames: 4, frameWidth: 48, frameHeight: 88, kind: 'sheet', builtin: true, applied: false },
    { id: 'mage', name: '紫晶法师', file: '/assets/game/character/mage.png', frames: 4, frameWidth: 48, frameHeight: 88, kind: 'sheet', builtin: true, applied: false },
    { id: 'bot', name: '青枢机械', file: '/assets/game/character/bot.png', frames: 4, frameWidth: 48, frameHeight: 88, kind: 'sheet', builtin: true, applied: false },
    { id: 'hero-3d', name: '标准员工模型', file: '/assets/game/character/hero-3d.glb', frames: 1, frameWidth: 0, frameHeight: 0, kind: 'glb', builtin: true, applied: false, hint: '默认员工 3D 模型' },
    { id: 'device-3d', name: '工业泵设备', file: '/assets/game/character/device-3d.glb', frames: 1, frameWidth: 0, frameHeight: 0, kind: 'dev', builtin: true, applied: false, hint: '数字孪生实体模型(拖入场景生成设备)' },
  ]

  // 设备固定目录自动识别:把 public/assets/game/devices/ 下的所有 .glb 注册为 kind=dev 设备。
  // 用户把设备/实体模型丢进该目录即自动出现在模型库,无需改代码。
  // 主来源:服务端扫描 API(GET /api/workshop/assets/devices,运行期即时可见);
  // 此处 Vite import.meta.glob 仅为服务端不可用时的本地兜底。
  // 注意:Vite 的 import.meta.glob 参数必须是「直接字符串字面量」(不能是变量),且需用绝对根
  // 路径 /public/... 才能命中 public/ 资产;返回 "/public/assets/game/devices/<name>.glb",
  // 运行时实际服务路径去 "/public" 前缀 → /assets/game/devices/<name>.glb。
  const deviceFallbacks: CharacterModel[] = []
  try {
    const deviceModules = import.meta.glob<string>('/public/assets/game/devices/*.glb', { eager: true, query: '?url', import: 'default' })
    for (const [key, url] of Object.entries(deviceModules)) {
      const base = key.split('/').pop() ?? ''
      const id = 'dev-folder-' + base.replace(/\.glb$/i, '')
      const servedFile = url.replace(/^\/public\//, '/')
      deviceFallbacks.push({
        id,
        name: base.replace(/\.glb$/i, '').replace(/[-_]/g, ' '),
        file: servedFile,
        frames: 1,
        frameWidth: 0,
        frameHeight: 0,
        kind: 'dev',
        builtin: true,
        applied: false,
        hint: '设备实体(拖入场景生成数字孪生)',
      })
    }
  }
  catch {
    // glob 不识别该相对路径时静默;不影响其余模型。
  }
  const headers = (json = true): Record<string, string> => {
    // token 存在 cookie 'token'(user store 写入);读不到则从 user store 兜底
    const cookieToken = typeof document !== 'undefined'
      ? (document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? '')
      : ''
    const h: Record<string, string> = {}
    const t = cookieToken || ''
    if (t) h.authorization = `Bearer ${decodeURIComponent(t)}`
    if (json) h['content-type'] = 'application/json'
    return h
  }

  const store: CharacterAssetStore = reactive({
    models,
    loaded: false,
    loading: false,
    error: '',
    async load() {
      if (store.loading || store.loaded) return
      store.loading = true
      try {
        // 角色资产(上传/全局库)+ 设备/角色 3D 模型资源扫描(真实目录,运行期即时)并行拉取
        const [charRes, scanRes] = await Promise.allSettled([
          fetch('/api/workshop/assets/character', { headers: headers() }),
          fetch('/api/workshop/assets/devices', { headers: headers() }),
        ])
        const charJson = charRes.status === 'fulfilled' ? await charRes.value.json().catch(() => ({})) : {}
        const scanJson = scanRes.status === 'fulfilled' ? await scanRes.value.json().catch(() => ({})) : {}
        const apiAssets: ApiAsset[] = charJson?.data?.assets ?? []
        // 服务端扫描的设备模型(运行期新增立即可见;失败则静默,由本地兜底补)
        const scannedDevices: CharacterModel[] = (scanJson?.data?.devices ?? []).map((d: { id: string, name: string, file: string, defaultScale?: number }) => ({
          id: d.id,
          name: d.name,
          file: d.file,
          frames: 1,
          frameWidth: 0,
          frameHeight: 0,
          kind: 'dev' as const,
          builtin: true,
          applied: false,
          hint: '设备实体(拖入场景生成数字孪生)',
          hFactor: typeof d.defaultScale === 'number' && d.defaultScale > 0 ? d.defaultScale : 1,
        }))
        // 服务端扫描的角色 3D 模型(character 目录 .glb;供 Channel 成员换装,不进侧边模型库;
        // 过滤掉与内置 hero-3d/device-3d 同文件的重复项,成员下拉只保留语义唯一的选项)
        const builtinFiles = new Set(builtins.map(b => b.file))
        const scannedCharacters: CharacterModel[] = (scanJson?.data?.characters ?? [])
          .filter((d: { file: string }) => !builtinFiles.has(d.file))
          .map((d: { id: string, name: string, file: string }) => ({
            id: d.id,
            name: d.name,
            file: d.file,
            frames: 1,
            frameWidth: 0,
            frameHeight: 0,
            kind: 'glb' as const,
            builtin: true,
            applied: false,
            hint: '角色 3D 模型(在频道成员管理中设置)',
          }))
        // REST 为准;内置约定补足(若有同名则用 API 版);扫描设备优先于本地 glob 兜底
        const merged: CharacterModel[] = []
        const seen = new Set<string>()
        for (const a of apiAssets) {
          merged.push(fromApi(a))
          seen.add(a.id)
        }
        for (const d of scannedDevices) {
          if (seen.has(d.id)) continue
          merged.push(d)
          seen.add(d.id)
        }
        for (const c of scannedCharacters) {
          if (seen.has(c.id)) continue
          merged.push(c)
          seen.add(c.id)
        }
        for (const b of builtins) {
          if (!seen.has(b.id)) merged.push(b)
        }
        for (const d of deviceFallbacks) {
          if (!seen.has(d.id)) merged.push(d)
        }
        // 变更经 reactive 代理,驱动 AssetLibrary 等组件重渲染
        store.models.splice(0, store.models.length, ...merged)
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
    byId(id) {
      return models.find(m => m.id === id)
    },
    async upload(file, opts) {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('name', opts.name ?? file.name.replace(/\.[^.]+$/, ''))
      fd.append('workspaceId', opts.workspaceId ?? '')
      fd.append('kind', opts.kind ?? 'sheet')
      fd.append('frameWidth', String(opts.frameWidth ?? 48))
      fd.append('frameHeight', String(opts.frameHeight ?? 88))
      fd.append('frames', String(opts.frames ?? 4))
      const res = await fetch('/api/workshop/assets/character', { method: 'POST', headers: headers(false), body: fd })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.data?.asset) {
        throw new Error(json?.message ?? '上传失败')
      }
      // 从服务端同步最新清单(含新模型 + appliedTo)
      store.loaded = false
      await store.load()
      return fromApi(json.data.asset)
    },
    async remove(id) {
      const res = await fetch(`/api/workshop/assets/character/${id}`, { method: 'DELETE', headers: headers() })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? '删除失败')
      // 重新拉取(仅当真正删除时 appliedTo 才会变)
      store.loaded = false
      await store.load()
      return { used: json?.data?.used ?? 0 }
    },
    async uploadDevice(file, name) {
      const fd = new FormData()
      fd.append('file', file)
      if (name) fd.append('name', name)
      const res = await fetch('/api/workshop/assets/devices', { method: 'POST', headers: headers(false), body: fd })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.data?.asset) throw new Error(json?.message ?? '设备模型上传失败')
      store.loaded = false
      await store.load()
      const a = json.data.asset
      return {
        id: a.id,
        name: a.name,
        file: a.file,
        frames: 1,
        frameWidth: 0,
        frameHeight: 0,
        kind: 'dev' as const,
        builtin: false,
        applied: false,
        hint: '设备实体(拖入场景生成数字孪生)',
      }
    },
    async removeDevice(id) {
      const key = id.replace(/^dev-folder-/, '')
      const res = await fetch(`/api/workshop/assets/devices/${encodeURIComponent(key)}`, { method: 'DELETE', headers: headers() })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? '设备模型删除失败')
      store.loaded = false
      await store.load()
    },
    async bind(channelId, agentId, modelRef) {
      const res = await fetch(`/api/workshop/channels/${channelId}/agents/${agentId}/model`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ modelRef }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? '绑定失败')
    },
  })
  return store
}

export function useCharacterAssets(): CharacterAssetStore {
  const g = globalThis as unknown as Record<string, CharacterAssetStore | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  const store = g[GLOBAL_KEY]!
  void store.load()
  return store
}
