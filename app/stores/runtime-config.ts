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

interface Snapshot {
  descriptors: SettingsDescriptor[]
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
  const effective = ref<Record<string, unknown>>({})
  const overrides = ref<Record<string, unknown>>({})
  const sources = ref<Record<string, string>>({})
  const settingsPath = ref('')
  const loaded = ref(false)
  const loading = ref(false)
  const lastEvent = ref<SettingsEvent | null>(null)

  // 分组后的设置项（computed：按 schema.json group 保持声明顺序）
  const groups = computed(() => {
    const out: Array<{ group: string, items: SettingsDescriptor[] }> = []
    for (const d of descriptors.value) {
      const g = out.find(x => x.group === d.group)
      if (g) g.items.push(d)
      else out.push({ group: d.group, items: [d] })
    }
    return out
  })

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
    effective.value = snap.effective ?? {}
    overrides.value = snap.overrides ?? {}
    sources.value = snap.sources ?? {}
    settingsPath.value = snap.settingsPath ?? ''
    loaded.value = true
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
  }

  function stopEvents(): void {
    if (controller) {
      controller.abort()
      controller = null
    }
  }

  return {
    descriptors,
    effective,
    overrides,
    sources,
    settingsPath,
    loaded,
    loading,
    lastEvent,
    groups,
    sourceOf,
    valueOf,
    fetchAll,
    patch,
    resetAll,
    startEvents,
    stopEvents,
  }
})
