import { computed, onBeforeUnmount, watch } from 'vue'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'

/**
 * 控制台的路由作用域 + 实时订阅层(页面唯一持有 WS 订阅的地方,只注册一次)。
 *  - wsId:路由参数,作用域的唯一事实源;
 *  - workspace / channelId:聚焦 channel 的取值与回退规则;
 *  - 订阅生命周期:workspace 挂载清单变化 → 增量 sub/unsub,卸载时全部退订;
 *  - conn / stateColor / lastSeq:连接态与 seq 游标的只读投影。
 * 全部是对 store 的派生,不复制任何响应式源;订阅语义与拆分前逐字一致。
 */
export function useWorkspaceChannels() {
  const route = useRoute()
  const wsStore = useWorkspacesStore()
  const { subscribe, unsubscribe, conn } = useWorkshopWs()

  const wsId = computed(() => String(route.params.wsId))

  const workspace = computed(() => wsStore.workspaces.find(w => w.id === wsId.value))
  // 聚焦 channel:activeChannelId 须在挂载清单内(陈旧持久化/竞态下回退首频道),
  // 避免订阅死频道 → 快照永不到达 → 右栏/时间线长时间"空数据"假象
  const channelId = computed(() => {
    const ws = workspace.value
    if (!ws) return undefined
    const ids = ws.channelIds
    const active = ws.activeChannelId
    return active && ids.includes(active) ? active : ids[0]
  })

  // 订阅生命周期:workspace 挂载的 channel 变化 → 增量 sub/unsub
  watch(
    () => [wsId.value, workspace.value?.channelIds.join(',') ?? ''],
    () => {
      const mounted = new Set(workspace.value?.channelIds ?? [])
      for (const id of mounted) subscribe(id)
    },
    { immediate: true },
  )
  watch(
    () => workspace.value?.channelIds.join(',') ?? '',
    (_next, prev) => {
      if (prev === undefined) return
      const mounted = new Set(workspace.value?.channelIds ?? [])
      for (const prevId of prev.split(',').filter(Boolean)) {
        if (!mounted.has(prevId)) unsubscribe(prevId)
      }
    },
  )
  onBeforeUnmount(() => {
    for (const id of workspace.value?.channelIds ?? []) unsubscribe(id)
  })

  const stateColor = computed(() =>
    conn.state === 'open' ? 'var(--tone-success-dot)' : conn.state === 'connecting' ? 'var(--tone-warning-dot)' : 'var(--tone-danger-dot)',
  )
  const lastSeq = computed(() => (channelId.value ? conn.cursors[channelId.value] ?? 0 : 0))
  /** workspace 列表是否已从服务端返回("未加载" ≠ "空",右栏据此出诚实降级态) */
  const loaded = computed(() => wsStore.loaded)

  return { wsId, workspace, channelId, loaded, conn, stateColor, lastSeq }
}
