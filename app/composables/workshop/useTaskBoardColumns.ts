/**
 * useTaskBoardColumns —— 看板/列表共用的列模型与卡片展示助手:
 *  - BASE_COLUMNS 是列的唯一事实来源(key/标题/状态集/色调点/可移入动作);
 *    moveAction=null 表示系统流转列(执行中/等待汇总/已完成不接受手动移入);
 *  - columns:按列 states 过滤 mergedTasks(含乐观覆盖层);
 *  - agentName/childCount/stateOf:卡片与列表行的展示助手(成员名缺失时回落 id 前 6 位)。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { useEntitiesStore, type TaskView } from '@/app/stores/workshop/entities'

export interface TaskBoardColumn {
  key: string
  title: string
  states: string[]
  dot: string
  /** 允许用户手动移入该列的动作(null = 系统流转列) */
  moveAction: 'cancel' | 'retry' | null
  items: TaskView[]
}

export function useTaskBoardColumns(channelId: Ref<string>, mergedTasks: ComputedRef<TaskView[]>) {
  const { t } = useI18n()

  const entities = useEntitiesStore()

  const BASE_COLUMNS: Array<Omit<TaskBoardColumn, 'items'>> = [
    { key: 'todo', title: t('taskBoardView.k3nf71d008'), states: ['SUBMITTED', 'ASSIGNED'], dot: 'var(--tone-neutral-dot)', moveAction: 'retry' },
    { key: 'doing', title: t('taskBoardView.k3o5tz9009'), states: ['WORKING'], dot: 'var(--tone-info-dot)', moveAction: null },
    { key: 'waiting', title: t('taskBoardView.k1hpx9p1010'), states: ['WAITING'], dot: 'var(--tone-warning-dot)', moveAction: null },
    { key: 'done', title: t('taskBoardView.k3n77g3011'), states: ['COMPLETED'], dot: 'var(--tone-success-dot)', moveAction: null },
    { key: 'bad', title: t('taskBoardView.k1veotws012'), states: ['FAILED', 'CANCELED'], dot: 'var(--tone-danger-dot)', moveAction: 'cancel' },
  ]

  const columns = computed<TaskBoardColumn[]>(() => BASE_COLUMNS.map(col => ({
    ...col,
    items: mergedTasks.value.filter(t => col.states.includes(t.state)),
  })))

  const agentName = (id: string): string =>
    entities.agentById(channelId.value, id)?.name ?? id.slice(0, 6)
  const childCount = (id: string): number =>
    mergedTasks.value.filter(t => t.parentId === id).length

  const stateOf = (t: TaskView): string => t.state

  return { columns, agentName, childCount, stateOf }
}
