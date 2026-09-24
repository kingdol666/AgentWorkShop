/**
 * useTaskBoardDrag —— 看板拖拽(HTML5 DnD;整列作为放置目标)。
 *
 * 状态单例于调用方(TaskBoardView 的 setup),子组件经 props/emits 共享同一份 ——
 * 刻意不做成模块级全局,否则多通道同屏里的多个看板会互相串台。
 *
 *  - canDrop = 该卡能否移入该列:列有 moveAction 且目标态 ≠ 当前态;
 *    retry 列只收 FAILED,cancel 列收未终结态;
 *  - 拖拽只裁决「可不可以放」,真正执行仍走 applyMove(与状态胶囊菜单同一动作面);
 *  - colClasses 给出列样式态:可放 = 蓝调高亮;不可放 = 压暗;拖出来源列 = 微降透明。
 */
import { ref } from 'vue'
import type { TaskView } from '@/app/stores/workshop/entities'
import type { TaskBoardColumn } from '@/app/composables/workshop/useTaskBoardColumns'

export function useTaskBoardDrag(options: {
  taskById: (id: string) => TaskView | undefined
  applyMove: (taskId: string, action: 'cancel' | 'retry') => Promise<void>
}) {
  const { taskById, applyMove } = options

  const dragId = ref<string | null>(null)
  const dragFrom = ref<string | null>(null)
  const dropOver = ref<string | null>(null)

  /** 该卡是否允许移入该列(动作存在且目标态 ≠ 当前态) */
  const canDrop = (taskId: string, col: TaskBoardColumn): boolean => {
    if (!col.moveAction) return false
    const t = taskById(taskId)
    if (!t) return false
    if (col.states.includes(t.state)) return false
    if (col.moveAction === 'retry') return t.state === 'FAILED'
    return ['SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING', 'FAILED'].includes(t.state)
  }

  const onDragStart = (ev: DragEvent, t: TaskView, colKey: string) => {
    dragId.value = t.id
    dragFrom.value = colKey
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move'
      ev.dataTransfer.setData('text/plain', t.id)
    }
  }
  const onDragOver = (ev: DragEvent, col: TaskBoardColumn) => {
    if (!dragId.value || !canDrop(dragId.value, col)) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  }
  const onDragLeave = (colKey: string) => {
    if (dropOver.value === colKey) dropOver.value = null
  }
  const onDragOverCol = (ev: DragEvent, col: TaskBoardColumn) => {
    dropOver.value = col.key
    onDragOver(ev, col)
  }
  const onDragEnd = () => {
    dragId.value = null
    dragFrom.value = null
    dropOver.value = null
  }
  /** 列样式态:可放 = 蓝调高亮;不可放 = 压暗;拖出来源列 = 微降透明 */
  const colClasses = (col: TaskBoardColumn): Record<string, boolean> => ({
    'drop-over': dropOver.value === col.key && !!dragId.value && canDrop(dragId.value, col),
    'no-drop': !!dragId.value && dropOver.value === col.key && !canDrop(dragId.value, col),
    'drag-origin': dragFrom.value === col.key,
  })
  const onDrop = async (ev: DragEvent, col: TaskBoardColumn) => {
    ev.preventDefault()
    const id = dragId.value
    dropOver.value = null
    dragId.value = null
    dragFrom.value = null
    if (!id || !canDrop(id, col)) return
    await applyMove(id, col.moveAction!)
  }

  return { dragId, onDragStart, onDragLeave, onDragOverCol, onDragEnd, colClasses, onDrop }
}
