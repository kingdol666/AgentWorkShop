/**
 * useSettingsGroups —— 设置页「运行配置」的分组态:
 * 分组标题/来源徽标/字段标签的展示解析、本地展开偏好(localStorage)、
 * 以及 admin 的分组 CRUD(内联建档 / 行内改名 / 排序 / 默认折叠 / 删除)。
 *
 * 单一实例约束:与 useRuntimeConfigDraft 同策略 —— RuntimePane 在 setup 里
 * 调用一次并提供,子树用 useSettingsGroupsContext() 取回同一份。
 */
import { computed, onMounted, provide, inject, reactive, ref, type InjectionKey } from 'vue'
import { message } from 'ant-design-vue'
import { useRuntimeConfigStore } from '@/app/stores/runtime-config'
import { useUserStore } from '@/app/stores/workshop/user'
import { apiErrorMessage } from '@/app/utils/api-error'

export function useSettingsGroups() {
  const { t } = useI18n()
  const userStore = useUserStore()
  const rcStore = useRuntimeConfigStore()

  /** 内置分组的 i18n 标签(id → i18n key);插件/自建分组走自己的 label */
  const KNOWN_GROUP_LABELS: Record<string, string> = { server: 'settings.runtime.groupServer', app: 'settings.runtime.groupApp', api: 'settings.runtime.groupApi', theme: 'settings.runtime.groupTheme', i18n: 'settings.runtime.groupI18n', security: 'settings.runtime.groupSecurity', daq: 'settings.runtime.groupDaq', memory: 'settings.runtime.groupMemory', omp: 'settings.runtime.groupOmp', harness: 'settings.runtime.groupHarness', dcw: 'settings.runtime.groupDcw', workshop: 'settings.runtime.groupWorkshop', backup: 'settings.runtime.groupBackup', retention: 'settings.runtime.groupRetention', log: 'settings.runtime.groupLog', plugins: 'settings.runtime.groupPlugins' }

  /**
   * 分组标题解析优先级:
   *  1) 分组自带 labelKey(插件可本地化自己分区的标题)
   *  2) 服务端下发的 label 与 id 不同 —— 管理员改过名 / 插件声明的展示名
   *  3) 内置分组的 i18n 映射(注册表里内置组 label 就是 id,需要前端补语言)
   *  4) 兜底用 id
   */
  function groupLabel(g: { id: string, label?: string, labelKey?: string }): string {
    if (g.labelKey && t(g.labelKey) !== g.labelKey) return t(g.labelKey)
    if (g.label && g.label !== g.id) return g.label
    const known = KNOWN_GROUP_LABELS[g.id]
    if (known) return t(known)
    return g.label || g.id
  }
  function groupSourceBadge(g: { source: string, plugin?: string }): string {
    if (g.source === 'plugin') return g.plugin ? `${t('settings.groups.srcPlugin')}: ${g.plugin}` : t('settings.groups.srcPlugin')
    if (g.source === 'user') return t('settings.groups.srcUser')
    return t('settings.groups.srcBuiltin')
  }
  function sourceClass(s: string): string {
    return s === 'runtime' ? 'src-runtime' : s === 'env' ? 'src-env' : 'src-yaml'
  }
  function itemLabel(item: { label: string, labelKey?: string }): string {
    const k = item.labelKey
    return (k && t(k) !== k) ? t(k) : item.label
  }

  /* ---------------- 分组折叠 + 分组管理(后端为权威,本地只管展开偏好) ---------------- */
  const GROUP_COLLAPSE_KEY = 'aw.settings.groups.collapsed'
  /** 本地展开/收起偏好:{ [groupId]: collapsed } */
  const groupCollapsed = ref<Record<string, boolean>>({})
  function loadCollapsePref(): void {
    try {
      groupCollapsed.value = JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY) ?? '{}') ?? {}
    }
    catch {
      groupCollapsed.value = {}
    }
  }
  function saveCollapsePref(): void {
    try {
      localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify(groupCollapsed.value))
    }
    catch { /* 隐私模式等场景忽略 */ }
  }
  function isCollapsed(g: { id: string, collapsed: boolean }): boolean {
    const local = groupCollapsed.value[g.id]
    return local === undefined ? g.collapsed : local
  }
  function toggleGroup(g: { id: string, collapsed: boolean, collapsible: boolean }): void {
    if (!g.collapsible) return
    groupCollapsed.value = { ...groupCollapsed.value, [g.id]: !isCollapsed(g) }
    saveCollapsePref()
  }
  /** 全部展开/收起(一键;按当前是否已全展开决定方向) */
  function toggleAllGroups(): void {
    const list = rcStore.groups.filter(g => g.collapsible)
    const anyExpanded = list.some(g => !isCollapsed(g))
    const next = { ...groupCollapsed.value }
    for (const g of list) next[g.id] = anyExpanded
    groupCollapsed.value = next
    saveCollapsePref()
  }
  const allExpanded = computed(() => rcStore.groups.filter(g => g.collapsible).some(g => !isCollapsed(g)))

  /* 分组 CRUD(admin):内联表单 + 行内改名,避免引入全局弹窗依赖 */
  const isAdmin = computed(() => userStore.isAdmin)
  const groupFormOpen = ref(false)
  const groupForm = reactive({ label: '', description: '', collapsed: false })
  const groupBusy = ref('')
  const renamingId = ref('')
  const renameDraft = ref('')

  async function submitGroupForm(): Promise<void> {
    if (!groupForm.label.trim()) return
    groupBusy.value = 'create'
    try {
      await rcStore.createGroup({ label: groupForm.label.trim(), description: groupForm.description.trim(), collapsed: groupForm.collapsed })
      groupFormOpen.value = false
      groupForm.label = ''
      groupForm.description = ''
      groupForm.collapsed = false
      message.success(t('settings.groups.created'))
    }
    catch (e) {
      message.error(apiErrorMessage(e, t('settings.groups.createFail')))
    }
    finally {
      groupBusy.value = ''
    }
  }

  function startRename(g: { id: string, label: string }): void {
    renamingId.value = g.id
    renameDraft.value = g.label
  }
  async function commitRename(id: string): Promise<void> {
    const label = renameDraft.value.trim()
    renamingId.value = ''
    if (!label) return
    groupBusy.value = id
    try {
      await rcStore.updateGroup(id, { label })
      message.success(t('settings.groups.renamed'))
    }
    catch (e) {
      message.error(apiErrorMessage(e, t('settings.groups.updateFail')))
    }
    finally {
      groupBusy.value = ''
    }
  }

  /** 排序:与相邻同源分组交换 order(通过各自的 order 值互换实现稳定重排) */
  async function moveGroup(id: string, dir: -1 | 1): Promise<void> {
    const list = [...rcStore.groups]
    const i = list.findIndex(g => g.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    const a = list[i]!
    const b = list[j]!
    groupBusy.value = id
    try {
      // 顺序值可能相等(插件组同 order)→ 用「重排后的显式序号」写回,保证结果确定
      const ordered = [...list]
      ordered.splice(i, 1)
      ordered.splice(j, 0, a)
      const patchA = (j + 1) * 10
      const patchB = (i + 1) * 10
      await rcStore.updateGroup(a.id, { order: patchA })
      await rcStore.updateGroup(b.id, { order: patchB })
      void b
    }
    catch (e) {
      message.error(apiErrorMessage(e, t('settings.groups.updateFail')))
    }
    finally {
      groupBusy.value = ''
    }
  }

  async function setGroupDefaultCollapsed(g: { id: string, collapsed: boolean }): Promise<void> {
    groupBusy.value = g.id
    try {
      await rcStore.updateGroup(g.id, { collapsed: !g.collapsed })
    }
    catch (e) {
      message.error(apiErrorMessage(e, t('settings.groups.updateFail')))
    }
    finally {
      groupBusy.value = ''
    }
  }

  async function removeGroup(g: { id: string, label: string, fieldCount?: number }): Promise<void> {
    const count = g.fieldCount ?? 0
    if (count > 0) {
      message.warning(t('settings.groups.deleteHasFields', { p0: groupLabel(g), p1: count }))
      return
    }
    groupBusy.value = g.id
    try {
      await rcStore.deleteGroup(g.id)
      message.success(t('settings.groups.deleted'))
    }
    catch (e) {
      message.error(apiErrorMessage(e, t('settings.groups.deleteFail')))
    }
    finally {
      groupBusy.value = ''
    }
  }

  // 折叠偏好只在浏览器侧读写(localStorage);SSR 首帧用服务端默认折叠态,水合后无缝接管
  onMounted(loadCollapsePref)

  return {
    groupLabel,
    groupSourceBadge,
    sourceClass,
    itemLabel,
    groupCollapsed,
    loadCollapsePref,
    saveCollapsePref,
    isCollapsed,
    toggleGroup,
    toggleAllGroups,
    allExpanded,
    isAdmin,
    groupFormOpen,
    groupForm,
    groupBusy,
    renamingId,
    renameDraft,
    submitGroupForm,
    startRename,
    commitRename,
    moveGroup,
    setGroupDefaultCollapsed,
    removeGroup,
  }
}

export type SettingsGroupsApi = ReturnType<typeof useSettingsGroups>

/** 注入键:整页共享同一份分组态 */
export const settingsGroupsKey: InjectionKey<SettingsGroupsApi> = Symbol('aw.settings.groups')

/** 拥有方(RuntimePane)侧:创建分组态并提供给子树 */
export function provideSettingsGroups(): SettingsGroupsApi {
  const api = useSettingsGroups()
  provide(settingsGroupsKey, api)
  return api
}

/** 消费方(RuntimeGroupSection / RuntimeFieldRow)侧:取祖先提供的同一份分组态 */
export function useSettingsGroupsContext(): SettingsGroupsApi {
  const api = inject(settingsGroupsKey)
  if (!api) throw new Error('[settings] useSettingsGroupsContext: 缺少 provideSettingsGroups()')
  return api
}
