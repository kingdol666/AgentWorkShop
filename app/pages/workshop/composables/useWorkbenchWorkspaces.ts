import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useUserStore } from '@/app/stores/workshop/user'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { apiErrorMessage } from '@/app/utils/api-error'

/** 卡片上一行 channel 的实时摘要(channelSummary 的产物,纯展示数据) */
export interface WorkspaceChannelSummary {
  id: string
  name: string
  /** 实体基线(WS 快照)是否已到达:未到时计数不可信,展示"同步中"而非误导性的 0 */
  synced: boolean
  agents: number
  busy: number
  activeTasks: number
}

/**
 * 工作台总览页的 workspace 层:服务端加载 / channel 订阅 / 新建 / 删除 / 卡片摘要。
 *
 * ⚠️ `useWorkshopWs()` 必须在本 composable(即**页面 setup 期**)调用,且只调用一次:
 * 它内部注册心跳 onMounted 与 token watch,并靠页面持有的订阅让事件流在总览页常驻
 * (状态徽标实时)。挪进子组件会让副作用跟随子组件的挂载时机注册 —— 既会多注册一份,
 * 又可能晚于首帧事件,订阅引用计数也不再由页面持有。
 *
 * 订阅侧与拆分前逐字一致:**只订阅、不退订**(见 useWorkshopWs.unsubscribe 注释:
 * 仍有页面持有订阅时,控制台卸载不得清掉事件缓冲,否则实时流静默死亡)。
 */
export function useWorkbenchWorkspaces() {
  const { t } = useI18n()
  const userStore = useUserStore()
  const wsStore = useWorkspacesStore()
  const entities = useEntitiesStore()
  const { subscribe } = useWorkshopWs()

  // ===== 登录后加载 workspace(服务端持久化)=====
  const ready = ref(false)
  watch(() => userStore.isLoggedIn, async (ok) => {
    if (!ok) {
      ready.value = false
      return
    }
    await userStore.refresh()
    if (!userStore.isLoggedIn) return
    try {
      await wsStore.load()
      ready.value = true
    }
    catch (e) {
      // SSR 安全:ant-design-vue message 依赖 DOM,服务端静默(客户端进入页面后可重试)
      if (import.meta.client) message.error(e instanceof Error ? e.message : t('wsHome.k1br33vc023'))
    }
  }, { immediate: true })

  // 已有 workspace 的 channel 订阅(总览页也保持事件流活跃,状态徽标实时)
  watch(
    () => ready.value && wsStore.workspaces.map(w => w.channelIds.join(',')).join('|'),
    () => {
      if (!ready.value) return
      for (const ws of wsStore.workspaces) {
        for (const id of ws.channelIds) subscribe(id)
      }
    },
    { immediate: true },
  )

  const createOpen = ref(false)
  const createName = ref('')
  const createLoading = ref(false)
  const create = async (): Promise<void> => {
    const name = createName.value.trim()
    if (!name) {
      message.warning(t('wsHome.nameRequired'))
      return
    }
    createLoading.value = true
    try {
      const ws = await wsStore.create(name)
      createOpen.value = false
      createName.value = ''
      wsStore.setActiveWorkspaceId(ws.id)
      navigateTo(`/workshop/w/${ws.id}`)
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      createLoading.value = false
    }
  }

  const remove = async (id: string): Promise<void> => {
    await wsStore.remove(id)
    message.success(t('wsHome.k3n5sd7024'))
  }

  const channelSummary = (channelIds: string[]): WorkspaceChannelSummary[] => channelIds.map((id) => {
    const meta = entities.channels[id]
    const agents = entities.agents[id] ?? []
    return {
      id,
      name: meta?.name ?? id.slice(0, 8),
      /** 实体基线(WS 快照)是否已到达:未到时计数不可信,展示"同步中"而非误导性的 0 */
      synced: meta !== undefined,
      agents: agents.length,
      busy: agents.filter(a => a.state === 'busy').length,
      activeTasks: (entities.tasks[id] ?? []).filter(t => !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state)).length,
    }
  })

  return {
    wsStore,
    ready,
    createOpen,
    createName,
    createLoading,
    create,
    remove,
    channelSummary,
  }
}
