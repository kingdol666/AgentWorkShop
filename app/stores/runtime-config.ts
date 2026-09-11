/**
 * 运行时配置 Store —— 前端设置持久化 + 热重载的枢纽。
 *
 * - fetchAll(): GET /api/system/settings（描述符驱动的表单数据源）
 * - patch()   : PATCH /api/system/settings（持久化 + 服务端热应用 + SSE 广播）
 * - reset()   : POST /api/system/settings/reset
 * - startEvents(): fetch + ReadableStream 订阅 SSE，服务端任意写入（UI/CLI/文件监听）都实时同步
 *
 * 与服务端 SystemConfigService 同源（shared/config/schema.json 描述符），
 * 前端看到的值永远等于服务端内存视图。
 */
import { useCookie, useRuntimeConfig } from '#imports'
import { useHttp } from '~/composables/useHttp'

export interface SettingsDescriptor {
  key: string
  type: 'string' | 'number' | 'boolean' | 'color' | 'select'
  group: string
  label: string
  labelKey?: string
  description?: string
  applies: 'live' | 'restart'
  default?: unknown
  min?: number
  max?: number
  options?: string[]
}

/** 配置分组(服务端权威;前端只按序渲染分区,不自行猜分组) */
export interface ConfigGroup {
  id: string
  label: string
  labelKey?: string
  description: string
  order: number
  /** 服务端默认折叠态(用户本地展开偏好优先,见设置页 aw.settings.groups) */
  collapsed: boolean
  collapsible: boolean
  icon: string
  source: 'builtin' | 'user' | 'plugin'
  plugin?: string
  /** 组内字段数(服务端实时统计) */
  fieldCount?: number
}

interface Snapshot {
  descriptors: SettingsDescriptor[]
  groups?: ConfigGroup[]
  effective: Record<string, unknown>
  overrides: Record<string, unknown>
  sources: Record<string, string>
  settingsPath: string
}

interface SettingsEvent {
  type: 'config:changed' | 'config:reset' | 'config:reloaded'
  changed: string[]
  restartRequired: string[]
  effective: Record<string, unknown>
  sources: Record<string, string>
  overrides: Record<string, unknown>
}

export const useRuntimeConfigStore = defineStore('runtime-config', () => {
  const descriptors = ref<SettingsDescriptor[]>([])
  /** 服务端下发的有序分组(唯一渲染权威);为空时退化为「按描述符出现顺序就地分组」 */
  const groupsRaw = ref<ConfigGroup[]>([])
  const effective = ref<Record<string, unknown>>({})
  const overrides = ref<Record<string, unknown>>({})
  const sources = ref<Record<string, string>>({})
  const settingsPath = ref('')
  const loaded = ref(false)
  const loading = ref(false)
  const lastEvent = ref<SettingsEvent | null>(null)

  /**
   * 渲染用分组(后端驱动):
   *  - 服务端给了 groups → 完全按它的顺序与元数据(标签/说明/折叠态)渲染;
   *  - 没给(旧服务端) → 按描述符首次出现顺序就地分组,保证不丢字段。
   * 两种情况下,描述符引用了分组列表里没有的 id 时自动补一个兜底分组。
   */
  const groups = computed<ConfigGroup[]>(() => {
    const byId = new Map<string, ConfigGroup>()
    for (const g of groupsRaw.value) byId.set(g.id, g)
    const items = new Map<string, SettingsDescriptor[]>()
    for (const d of descriptors.value) {
      const gid = d.group || '__ungrouped__'
      const list = items.get(gid)
      if (list) list.push(d)
      else items.set(gid, [d])
    }
    if (!groupsRaw.value.length) {
      return [...items.entries()].map(([id, list], i) => ({
        id,
        label: id,
        description: '',
        order: i * 10,
        collapsed: false,
        collapsible: true,
        icon: '',
        source: 'builtin' as const,
        fieldCount: list.length,
      }))
    }
    const out = groupsRaw.value.map(g => ({ ...g, fieldCount: g.fieldCount ?? items.get(g.id)?.length ?? 0 }))
    const known = new Set(out.map(g => g.id))
    for (const [id, list] of items) {
      if (known.has(id)) continue
      out.push({
        id,
        label: id === '__ungrouped__' ? '其他' : id,
        description: '',
        order: 9999,
        collapsed: false,
        collapsible: true,
        icon: '',
        source: 'builtin',
        fieldCount: list.length,
      })
    }
    return out.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  })

  /** 某分组内的字段(保持描述符声明顺序) */
  function fieldsOf(groupId: string): SettingsDescriptor[] {
    return descriptors.value.filter(d => (d.group || '__ungrouped__') === groupId)
  }

  function sourceOf(key: string): string {
    return sources.value[key] ?? 'config.yml'
  }

  /** 取某键当前有效值 */
  function valueOf(key: string): unknown {
    return effective.value[key]
  }

  async function fetchAll(): Promise<void> {
    loading.value = true
    try {
      const http = useHttp()
      const env = await http.get<{ data: Snapshot }>('/system/settings')
      applySnapshot((env as { data?: Snapshot }).data ?? (env as unknown as Snapshot))
    }
    catch (err) {
      // 未登录 / 服务未就绪：保持未加载，UI 显示占位
      console.warn('[runtime-config] 读取设置失败:', err)
    }
    finally {
      loading.value = false
    }
  }

  function applySnapshot(snap: Snapshot): void {
    descriptors.value = snap.descriptors ?? []
    groupsRaw.value = snap.groups ?? []
    effective.value = snap.effective ?? {}
    overrides.value = snap.overrides ?? {}
    sources.value = snap.sources ?? {}
    settingsPath.value = snap.settingsPath ?? ''
    loaded.value = true
  }

  /** 重新拉取分组(仅分组,不重拉描述符/值;分组 CRUD 后调用) */
  async function fetchGroups(): Promise<ConfigGroup[]> {
    const http = useHttp()
    const env = await http.get<{ data: { groups: ConfigGroup[] } }>('/system/config-groups')
    const res = ((env as { data?: { groups: ConfigGroup[] } }).data ?? (env as unknown as { groups: ConfigGroup[] }))
    groupsRaw.value = res.groups ?? []
    return groupsRaw.value
  }

  /** 新建分组(admin) */
  async function createGroup(def: Partial<ConfigGroup> & { label: string }): Promise<ConfigGroup> {
    const http = useHttp()
    const env = await http.post<{ data: { group: ConfigGroup } }>('/system/config-groups', def)
    const res = ((env as { data?: { group: ConfigGroup } }).data ?? (env as unknown as { group: ConfigGroup }))
    await fetchGroups()
    return res.group
  }

  /** 更新分组(admin;标题/说明/排序/默认折叠/图标) */
  async function updateGroup(id: string, patchMap: Partial<ConfigGroup>): Promise<void> {
    const http = useHttp()
    await http.request({ method: 'PATCH', url: `/system/config-groups/${encodeURIComponent(id)}`, data: patchMap })
    await fetchGroups()
  }

  /** 删除分组(admin;仅自建组) */
  async function deleteGroup(id: string, reassignTo?: string): Promise<void> {
    const http = useHttp()
    await http.request({ method: 'DELETE', url: `/system/config-groups/${encodeURIComponent(id)}${reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : ''}` })
    await fetchGroups()
  }

  /**
   * 保存一组覆盖（同 PATCH 语义；值为 null 表示清除该键覆盖）。
   * @returns 服务端返回 { changed, restartRequired, effective, sources }
   */
  async function patch(patchMap: Record<string, unknown | null>): Promise<{ changed: string[], restartRequired: string[], effective: Record<string, unknown> }> {
    const http = useHttp()
    const env = await http.request<{ data: { ok: boolean, changed: string[], restartRequired: string[], effective: Record<string, unknown>, sources: Record<string, string> } }>({
      method: 'PATCH',
      url: '/system/settings',
      data: { override: patchMap },
    })
    const res = ((env as { data?: { ok: boolean, changed: string[], restartRequired: string[], effective: Record<string, unknown>, sources: Record<string, string> } }).data != null
      ? (env as { data: { ok: boolean, changed: string[], restartRequired: string[], effective: Record<string, unknown>, sources: Record<string, string> } }).data
      : env as unknown as { ok: boolean, changed: string[], restartRequired: string[], effective: Record<string, unknown>, sources: Record<string, string> })
    if (res.effective) effective.value = res.effective
    if (res.sources) sources.value = res.sources
    return res
  }

  /** 清空全部运行时覆盖（回落 config.yml） */
  async function resetAll(): Promise<{ changed: string[], restartRequired: string[] }> {
    const http = useHttp()
    const env = await http.post<{ data: { changed: string[], restartRequired: string[] } }>('/system/settings/reset')
    const res = ((env as { data?: { changed: string[] } }).data ?? (env as unknown as { changed: string[] })) as { changed: string[], restartRequired: string[] }
    if (res.changed?.length) await fetchAll()
    return res
  }

  /* ---------------- SSE 订阅（fetch-based，携带 Authorization 头） ---------------- */
  let controller: AbortController | null = null

  function startEvents(): void {
    stopEvents()
    if (!import.meta.client) return
    const rt = useRuntimeConfig().public
    const base = (rt.apiBase as string) || '/api'
    const token = useCookie<string | null>('token').value ?? ''
    controller = new AbortController()

    void (async () => {
      try {
        const res = await fetch(`${base}/system/settings/events`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller?.signal,
        })
        if (!res.ok || !res.body) return
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let idx
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const dataLine = chunk.split('\n').find(l => l.startsWith('data:'))
              if (!dataLine) continue
              const raw = dataLine.slice(5).trim()
              if (!raw) continue
              try {
                applyEvent(JSON.parse(raw) as SettingsEvent)
              }
              catch { /* 非法载荷忽略 */ }
            }
          }
        }
        catch (err) {
          if ((err as Error)?.name !== 'AbortError') console.warn('[runtime-config] SSE 读取中断:', err)
        }
      }
      catch (err) {
        if ((err as Error)?.name !== 'AbortError') console.warn('[runtime-config] SSE 连接失败:', err)
      }
    })()
  }

  function applyEvent(ev: SettingsEvent): void {
    lastEvent.value = ev
    if (ev.effective) effective.value = ev.effective
    if (ev.sources) sources.value = ev.sources
    if (ev.overrides) overrides.value = ev.overrides
    // 分组结构变更(管理员 CRUD / 插件装载或卸载声明了分组)→ 重拉分组,
    // 让其它已打开设置页的会话即时看到新分区/分区消失
    if (Array.isArray(ev.changed) && ev.changed.includes('config-groups')) {
      void fetchGroups().catch(() => { /* 拉取失败保持现状 */ })
    }
  }

  function stopEvents(): void {
    if (controller) {
      controller.abort()
      controller = null
    }
  }

  return {
    descriptors,
    groupsRaw,
    effective,
    overrides,
    sources,
    settingsPath,
    loaded,
    loading,
    lastEvent,
    groups,
    fieldsOf,
    sourceOf,
    valueOf,
    fetchAll,
    fetchGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    patch,
    resetAll,
    startEvents,
    stopEvents,
  }
})
