/**
 * useChannelList —— 左栏 Channel 会话列表的数据口:
 * workspace 内挂载的 channel 清单、channel 模板清单、实时状态徽标
 * (忙碌成员数/活跃任务数)与行级操作(选中/复制工作目录/路径展示)。
 * 每个 ChannelSessionList 实例调用一次(wsId 为响应式引用),状态即单例于此。
 */
import { computed, ref, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useWorkshopApi, type ChannelDto, type ChannelTemplateDto } from '@/app/composables/workshop/useWorkshopApi'

export function useChannelList(wsId: Ref<string>) {
  const { t } = useI18n()

  const wsStore = useWorkspacesStore()
  const entities = useEntitiesStore()
  const api = useWorkshopApi()

  const workspace = computed(() => wsStore.workspaces.find(w => w.id === wsId.value))

  const channels = ref<ChannelDto[]>([])
  const channelTemplates = ref<ChannelTemplateDto[]>([])
  const refreshChannels = async (): Promise<void> => {
    // SSR 守卫:axios 相对 baseURL 仅客户端有效(服务端拉取会 Invalid URL)
    if (typeof window === 'undefined') return
    const [ch, tpl] = await Promise.all([
      api.listChannels(),
      api.listChannelTemplates().catch(() => null),
    ])
    channels.value = (ch as unknown as { data?: ChannelDto[] })?.data ?? []
    channelTemplates.value = (tpl as unknown as { data?: ChannelTemplateDto[] } | null)?.data ?? []
  }
  void refreshChannels()

  const mountedChannels = computed(() =>
    (workspace.value?.channelIds ?? [])
      .map(id => ({ id, meta: channels.value.find(c => c.id === id), entity: entities.channels[id] }))
      .map(({ id, meta, entity }) => ({
        id,
        name: entity?.name ?? meta?.name ?? id.slice(0, 8),
        /** 实体基线(WS 快照)是否已到达:未到时计数不可信,展示"同步中"而非误导性的 0 */
        synced: entity !== undefined,
        busy: entities.busyCount(id),
        agents: entities.agents[id]?.length ?? 0,
        activeTasks: (entities.tasks[id] ?? []).filter(t => !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state)).length,
        workspace: meta?.workspace ?? '',
        /** v16 定时标志:该 channel 启用的定时计划数(>0 显示「定时」标签) */
        scheduled: meta?.scheduledCount ?? 0,
      })),
  )

  const select = (channelId: string): void => {
    wsStore.setActiveChannel(wsId.value, channelId)
  }

  /** 点击工作目录行:复制完整路径到剪贴板(有真实作用;title 提示全路径) */
  const copyWorkspace = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      message.success(t('channelSessionList.kud74vg040', { p0: path }))
    }
    catch {
      message.error(t('channelSessionList.krij3gg026'))
    }
  }
  /** 路径显示 basename(E:\codes\AgentWorkShop → AgentWorkShop),全路径在 title/复制 */
  const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
  /** 默认目录(data/workspaces/<uuid>)的 basename 是 36 位裸 UUID,对用户零信息量 → 不展示该行 */
  const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
  const displayWorkspace = (path: string): string => {
    const base = baseName(path)
    return UUID_RE.test(base) ? '' : base
  }

  return {
    workspace,
    channels,
    channelTemplates,
    refreshChannels,
    mountedChannels,
    select,
    copyWorkspace,
    baseName,
    UUID_RE,
    displayWorkspace,
  }
}
