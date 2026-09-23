/**
 * useRuntimeConfigDraft —— 设置页「运行配置」的草稿态:
 * 服务端 effective 快照 → 本地草稿/脏键 → PATCH 保存 / 单键重置 / 整表重置。
 *
 * 单一实例约束:草稿是页面级共享状态。RuntimePane 在 setup 里调用一次
 * provideRuntimeConfigDraft(),子树用 useRuntimeConfigDraftContext() 取回同一份
 * (refs 是同一个对象,不会各自复制成互不相干的第二份状态)。
 */
import { inject, provide, ref, watch, type InjectionKey } from 'vue'
import { useRuntimeConfigStore } from '@/app/stores/runtime-config'

export function useRuntimeConfigDraft() {
  const { t } = useI18n()
  const rcStore = useRuntimeConfigStore()
  const draft = ref<Record<string, unknown>>({})
  const dirtyKeys = ref<Set<string>>(new Set())
  const savingRuntime = ref(false)
  const runtimeNotice = ref<{ type: 'success' | 'warning' | 'error', text: string } | null>(null)

  function syncRuntimeDraft() {
    draft.value = { ...rcStore.effective }
    dirtyKeys.value = new Set()
  }
  // immediate:store 由启动插件在应用初始化时拉取,进入本页时通常已 loaded=true,
  // 非 immediate 的 watch 永不触发 → 草稿恒空、所有值输入框显示为空(表单不可用)。
  watch(() => rcStore.loaded, (v) => {
    if (v) syncRuntimeDraft()
  }, { immediate: true })
  watch(() => rcStore.effective, () => {
    // 外部写入(CLI/其他窗口/文件监听)推来的变化,未编辑时才回填草稿
    if (dirtyKeys.value.size === 0) syncRuntimeDraft()
  }, { deep: true })

  function markDirty(key: string) {
    dirtyKeys.value.add(key)
    runtimeNotice.value = null
  }

  async function saveRuntime() {
    if (!dirtyKeys.value.size) return
    savingRuntime.value = true
    runtimeNotice.value = null
    try {
      const patchMap: Record<string, unknown> = {}
      for (const k of dirtyKeys.value) patchMap[k] = draft.value[k]
      const res = await rcStore.patch(patchMap)
      syncRuntimeDraft()
      const restart = res.restartRequired ?? []
      runtimeNotice.value = restart.length
        ? { type: 'warning', text: t('settings.runtime.restartNotice', { keys: restart.join(', ') }) }
        : { type: 'success', text: t('settings.runtime.savedLive') }
    }
    catch (e) {
      const err = e as { response?: { data?: { message?: string } }, message?: string }
      runtimeNotice.value = { type: 'error', text: err?.response?.data?.message || err?.message || String(e) }
    }
    finally {
      savingRuntime.value = false
    }
  }

  async function resetRuntimeKey(key: string) {
    try {
      await rcStore.patch({ [key]: null })
      // 只收敛被重置的键:整表 sync 会静默丢弃用户其他未保存编辑
      dirtyKeys.value.delete(key)
      draft.value[key] = rcStore.effective[key]
      runtimeNotice.value = { type: 'success', text: t('settings.runtime.keyReset', { key }) }
    }
    catch (e) {
      const err = e as { response?: { data?: { message?: string } }, message?: string }
      runtimeNotice.value = { type: 'error', text: err?.response?.data?.message || err?.message || String(e) }
    }
  }

  async function resetAllRuntime() {
    try {
      await rcStore.resetAll()
      syncRuntimeDraft()
      runtimeNotice.value = { type: 'success', text: t('settings.runtime.resetAllDone') }
    }
    catch (e) {
      const err = e as { response?: { data?: { message?: string } }, message?: string }
      runtimeNotice.value = { type: 'error', text: err?.response?.data?.message || err?.message || String(e) }
    }
  }

  return {
    draft,
    dirtyKeys,
    savingRuntime,
    runtimeNotice,
    syncRuntimeDraft,
    markDirty,
    saveRuntime,
    resetRuntimeKey,
    resetAllRuntime,
  }
}

export type RuntimeConfigDraftApi = ReturnType<typeof useRuntimeConfigDraft>

/** 注入键:整页共享同一份草稿态 */
export const runtimeConfigDraftKey: InjectionKey<RuntimeConfigDraftApi> = Symbol('aw.settings.runtimeConfigDraft')

/** 拥有方(RuntimePane)侧:创建草稿态并提供给子树 */
export function provideRuntimeConfigDraft(): RuntimeConfigDraftApi {
  const api = useRuntimeConfigDraft()
  provide(runtimeConfigDraftKey, api)
  return api
}

/** 消费方(RuntimeGroupSection / RuntimeFieldRow)侧:取祖先提供的同一份草稿态 */
export function useRuntimeConfigDraftContext(): RuntimeConfigDraftApi {
  const api = inject(runtimeConfigDraftKey)
  if (!api) throw new Error('[settings] useRuntimeConfigDraftContext: 缺少 provideRuntimeConfigDraft()')
  return api
}
