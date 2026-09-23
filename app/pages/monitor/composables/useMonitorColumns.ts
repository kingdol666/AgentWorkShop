/**
 * 监控页三张表的列定义(每列只被一张表消费,故与各自表组件同源)。
 *
 * 归属列(ownerName)只在 admin 口径存在:user 范围下服务端已按本人过滤,列无意义。
 * 三处都从 useOwnerColumn() 取值 —— 它只读全局 userStore,不持有状态,不存在多份副本。
 */
import { useUserStore } from '../../../stores/workshop/user'

/** 归属列:仅 admin 视图追加到各自列表尾(actions 列之前) */
function useOwnerColumn() {
  const { t } = useI18n()
  const userStore = useUserStore()
  const isAdmin = computed(() => userStore.isAdmin)

  return computed(() =>
    isAdmin.value ? [{ title: t('monitor.k1dg9sr8001'), dataIndex: 'ownerName', key: 'ownerName', width: 110 }] : [])
}

/** ChannelRuntime 表列 */
export function useChannelColumns() {
  const { t } = useI18n()
  const ownerColumn = useOwnerColumn()

  return computed(() => [
    { title: t('monitor.chChannel'), dataIndex: 'channelId', key: 'channelId' },
    { title: t('monitor.members'), dataIndex: 'memberCount', key: 'memberCount', width: 100 },
    { title: t('monitor.wired'), dataIndex: 'wiredAgentCount', key: 'wiredAgentCount', width: 90 },
    { title: t('monitor.scheduler'), dataIndex: 'hasScheduler', key: 'hasScheduler', width: 110 },
    { title: t('monitor.lead'), dataIndex: 'leadAgentId', key: 'leadAgentId' },
    ...ownerColumn.value,
  ])
}

/** AgentRuntime 表列 */
export function useAgentColumns() {
  const { t } = useI18n()
  const ownerColumn = useOwnerColumn()

  return computed(() => [
    { title: t('monitor.name'), dataIndex: 'name', key: 'name' },
    { title: t('monitor.role'), dataIndex: 'role', key: 'role', width: 90 },
    { title: t('monitor.harness'), dataIndex: 'harness', key: 'harness', width: 90 },
    { title: t('monitor.state'), dataIndex: 'state', key: 'state', width: 110 },
    { title: t('monitor.currentTask'), dataIndex: 'currentTaskId', key: 'currentTaskId' },
    { title: t('monitor.queue'), dataIndex: 'queuedCount', key: 'queuedCount', width: 90 },
    { title: 'PID', dataIndex: 'process', key: 'pid', width: 130 },
    { title: t('monitor.channel'), dataIndex: 'channelId', key: 'channelId', width: 130 },
    ...ownerColumn.value,
    { title: t('monitor.actions'), key: 'actions', width: 190, fixed: 'right' as const },
  ])
}

/** harness 进程表列 */
export function useProcessColumns() {
  const { t } = useI18n()
  const ownerColumn = useOwnerColumn()

  return computed(() => [
    { title: 'PID', dataIndex: 'pid', key: 'pid', width: 100 },
    { title: t('monitor.binding'), dataIndex: 'bound', key: 'bound', width: 100 },
    { title: t('monitor.agent'), dataIndex: 'name', key: 'name' },
    { title: t('monitor.role'), dataIndex: 'role', key: 'role', width: 90 },
    { title: t('monitor.command'), dataIndex: 'command', key: 'command' },
    { title: t('monitor.startedAt'), dataIndex: 'startedAt', key: 'startedAt', width: 110 },
    { title: t('monitor.state'), dataIndex: 'alive', key: 'alive', width: 100 },
    ...ownerColumn.value,
    { title: t('monitor.actions'), key: 'actions', width: 170, fixed: 'right' as const },
  ])
}
