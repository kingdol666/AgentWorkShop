/**
 * usePluginAdmin —— 设置页「插件管理」态:清单懒加载、启停、健康检测判定。
 *
 * 单一实例约束:RuntimePane 在 setup 里调用一次 providePluginAdmin(activeTab)
 * 并提供给子树(标题/说明/注入槽要用 plugins.length,清单区由 PluginsSection 渲染),
 * 两侧读的是同一份 refs,不会各自复制成互不相干的第二份状态。
 * activeTab 以 ref 传入,保持「进入运行配置 Tab 才拉清单」的懒加载时机。
 */
import { inject, provide, ref, watch, type InjectionKey, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi, type WorkshopPluginDto } from '@/app/composables/workshop/useWorkshopApi'
import { useUserStore } from '@/app/stores/workshop/user'
import { apiErrorMessage } from '@/app/utils/api-error'

/* ================= 插件管理(清单/启停/健康检测) ================= */
export interface PluginHealth {
  ok: boolean
  reason?: string
}

export function usePluginAdmin(activeTab: Ref<string>) {
  const { t } = useI18n()
  const userStore = useUserStore()
  const api = useWorkshopApi()

  const plugins = ref<WorkshopPluginDto[]>([])
  const pluginsLoading = ref(false)
  const pluginsLoaded = ref(false)
  const togglingPlugins = ref<Set<string>>(new Set())
  const healthMap = ref<Record<string, PluginHealth | 'checking'>>({})

  const hasHealthRoute = (p: WorkshopPluginDto): boolean =>
    (p.routes ?? []).some(r => String(r.path || '').endsWith('/health'))

  async function loadPlugins() {
    pluginsLoading.value = true
    try {
      const res = await api.listPlugins()
      // 顶层 plugins key(非信封);兼容 {code,data} 信封
      const list = res?.plugins ?? (res as { data?: { plugins?: WorkshopPluginDto[] } })?.data?.plugins ?? []
      plugins.value = Array.isArray(list) ? list : []
      pluginsLoaded.value = true
    }
    catch (e) {
      message.error(apiErrorMessage(e, t('plugins.loadFail')))
    }
    finally {
      pluginsLoading.value = false
    }
  }

  async function togglePlugin(p: WorkshopPluginDto, next: boolean) {
    if (togglingPlugins.value.has(p.name)) return
    togglingPlugins.value.add(p.name)
    try {
      if (next) await api.enablePlugin(p.name)
      else await api.disablePlugin(p.name)
      p.enabled = next
      message.success(next ? t('plugins.enabled') : t('plugins.disabled'))
    }
    catch (e) {
      // 普通用户 403 → 需要管理员权限
      message.error(apiErrorMessage(e, t('plugins.adminRequired')))
    }
    finally {
      togglingPlugins.value.delete(p.name)
    }
  }

  async function checkPluginHealth(p: WorkshopPluginDto) {
    if (!hasHealthRoute(p)) return
    healthMap.value = { ...healthMap.value, [p.name]: 'checking' }
    try {
      const res = await api.pluginHealth(p.name)
      healthMap.value = { ...healthMap.value, [p.name]: judgePluginHealth(p.name, res) }
    }
    catch (e) {
      healthMap.value = { ...healthMap.value, [p.name]: { ok: false, reason: apiErrorMessage(e, t('plugins.loadFail')) } }
    }
  }

  /** 健康判定:rag-bridge 看 backend.ok && web.ok;diag-bridge 看 remote.status==='ok';未知形状回退无报错即视为正常 */
  function judgePluginHealth(name: string, res: Record<string, unknown>): PluginHealth {
    if (name === 'rag-bridge') {
      const backend = res.backend as { ok?: boolean, error?: string, status?: string } | undefined
      const web = res.web as { ok?: boolean, error?: string, status?: string } | undefined
      const ok = Boolean(backend?.ok) && Boolean(web?.ok)
      const reason = !backend?.ok
        ? (backend?.error || backend?.status || 'backend')
        : (web?.error || web?.status || 'web')
      return ok ? { ok: true } : { ok: false, reason }
    }
    if (name === 'diag-bridge') {
      const remote = res.remote as { status?: string } | undefined
      const ok = remote?.status === 'ok'
      return ok ? { ok: true } : { ok: false, reason: remote?.status || 'remote' }
    }
    return { ok: true }
  }

  /** 模板辅助:检测中 / 检测结果(避免模板内窄化) */
  function isCheckingHealth(name: string): boolean {
    return healthMap.value[name] === 'checking'
  }
  function healthOf(name: string): PluginHealth | null {
    const h = healthMap.value[name]
    return (h && h !== 'checking') ? h : null
  }
  function isToggling(name: string): boolean {
    return togglingPlugins.value.has(name)
  }

  // 进入运行配置 Tab 时懒加载插件清单(端点需登录)
  watch(activeTab, (v) => {
    if (v === 'runtime' && !pluginsLoaded.value && !pluginsLoading.value && userStore.isLoggedIn) void loadPlugins()
  }, { immediate: true })

  return {
    plugins,
    pluginsLoading,
    pluginsLoaded,
    togglingPlugins,
    healthMap,
    hasHealthRoute,
    loadPlugins,
    togglePlugin,
    checkPluginHealth,
    judgePluginHealth,
    isCheckingHealth,
    healthOf,
    isToggling,
  }
}

export type PluginAdminApi = ReturnType<typeof usePluginAdmin>

/** 注入键:整页共享同一份插件管理态 */
export const pluginAdminKey: InjectionKey<PluginAdminApi> = Symbol('aw.settings.pluginAdmin')

/** 拥有方(RuntimePane)侧:创建插件管理态并提供给子树 */
export function providePluginAdmin(activeTab: Ref<string>): PluginAdminApi {
  const api = usePluginAdmin(activeTab)
  provide(pluginAdminKey, api)
  return api
}

/** 消费方(PluginsSection)侧:取祖先提供的同一份插件管理态 */
export function usePluginAdminContext(): PluginAdminApi {
  const api = inject(pluginAdminKey)
  if (!api) throw new Error('[settings] usePluginAdminContext: 缺少 providePluginAdmin()')
  return api
}
