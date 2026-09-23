import { computed, reactive, ref, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi, type WorkshopPluginDto } from '@/app/composables/workshop/useWorkshopApi'

/** 创建弹窗依赖:开关(与组件 v-model:open 是同一个 ref)+ 创建成功后的刷新回调 */
export interface TeamCreateDialogOptions {
  open: Ref<boolean>
  onCreated: () => void | Promise<void>
}

/**
 * 「新建 AgentTeam」弹窗状态:名称/描述/可见性 + 创建时勾选的插件开关。
 * 表单不随打开重置 —— 拆分前只有创建成功才清空(失败留着让用户改),这里保持一致。
 */
export function useTeamCreateDialog(options: TeamCreateDialogOptions) {
  const api = useWorkshopApi()
  const { t } = useI18n()

  const createForm = reactive({ name: '', description: '', visibility: 'private' as 'private' | 'public' })

  // ===== 插件(创建时勾选启用哪些;平台清单中 enabled 的插件,默认全选) =====
  const platformPlugins = ref<WorkshopPluginDto[]>([])
  const createPluginSel = ref<Record<string, boolean>>({})
  const loadPlatformPlugins = async (): Promise<void> => {
    try {
      const res = await api.listPlugins()
      // 顶层 plugins key(非信封);兼容 {code,data} 信封;只取平台已启用的插件
      const list = res?.plugins ?? (res as { data?: { plugins?: WorkshopPluginDto[] } })?.data?.plugins ?? []
      const enabled = (Array.isArray(list) ? list : []).filter(p => p.enabled !== false)
      platformPlugins.value = enabled
      const sel: Record<string, boolean> = {}
      for (const p of enabled) sel[p.name] = true
      createPluginSel.value = sel
    }
    catch { /* 清单不可得时隐藏插件多选(创建仍可走默认) */ }
  }
  if (import.meta.client) void loadPlatformPlugins()

  /** checkbox-group 双向绑定(勾选集 ↔ plugins 开关视图) */
  const pluginChecked = computed({
    get: () => Object.entries(createPluginSel.value).filter(([, v]) => v).map(([k]) => k),
    set: (vals: Array<string>) => {
      const next: Record<string, boolean> = {}
      for (const p of platformPlugins.value) next[p.name] = vals.includes(p.name)
      createPluginSel.value = next
    },
  })

  const submit = async (): Promise<void> => {
    if (!createForm.name.trim()) {
      message.warning(t('teams.k1bvcdo2021'))
      return
    }
    // 勾选结果作为 plugins:[{name,enabled}] 附加(后端创建时写入该团队的插件开关)
    const plugins = Object.entries(createPluginSel.value).map(([name, enabled]) => ({ name, enabled }))
    await api.createTeam({ name: createForm.name.trim(), description: createForm.description || undefined, visibility: createForm.visibility, plugins })
    message.success(t('teams.k3n5hak022'))
    options.open.value = false
    createForm.name = ''
    createForm.description = ''
    createForm.visibility = 'private'
    createPluginSel.value = Object.fromEntries(Object.entries(createPluginSel.value).map(([k]) => [k, true]))
    void options.onCreated()
  }

  return { createForm, platformPlugins, pluginChecked, submit }
}
