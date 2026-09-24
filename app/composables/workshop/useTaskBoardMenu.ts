/**
 * useTaskBoardMenu —— 状态胶囊菜单(动作 + 详情):fixed 定位并按视口收敛。
 *
 * 动作清单按当前任务态派生(cancel 收未终结态 / retry 收 FAILED / detail 恒有),
 * 与拖拽落列共用同一个动作面 applyMove —— 两条路径的状态语义必须一致。
 */
import { computed, ref } from 'vue'
import type { TaskView } from '@/app/stores/workshop/entities'

export interface TaskBoardMenuAction {
  key: 'cancel' | 'retry' | 'detail'
  label: string
  danger?: boolean
}

export function useTaskBoardMenu(options: {
  applyMove: (taskId: string, action: 'cancel' | 'retry') => Promise<void>
  openTask: (taskId: string) => void
}) {
  const { t } = useI18n()

  const { applyMove, openTask } = options

  /** 状态胶囊菜单(动作 + 详情);fixed 定位并按视口收敛 */
  const menu = ref<{ task: TaskView, x: number, y: number } | null>(null)
  const openMenu = (ev: MouseEvent, task: TaskView) => {
    const x = Math.min(ev.clientX, Math.max(window.innerWidth - 156, 8))
    const y = Math.min(ev.clientY, Math.max(window.innerHeight - 160, 8))
    menu.value = { task, x, y }
  }
  const closeMenu = () => {
    menu.value = null
  }
  const menuActions = computed<TaskBoardMenuAction[]>(() => {
    const task = menu.value?.task
    if (!task) return []
    const acts: TaskBoardMenuAction[] = []
    if (['SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING', 'FAILED'].includes(task.state)) {
      acts.push({ key: 'cancel', label: t('taskBoardView.k1bs0t9b016'), danger: true })
    }
    if (task.state === 'FAILED') {
      acts.push({ key: 'retry', label: t('taskBoardView.k1lclwk6017') })
    }
    acts.push({ key: 'detail', label: t('taskBoardView.k1dx9ysj018') })
    return acts
  })
  const onMenuAction = async (key: 'cancel' | 'retry' | 'detail') => {
    const t = menu.value?.task
    closeMenu()
    if (!t) return
    if (key === 'detail') {
      openTask(t.id)
    }
    else {
      await applyMove(t.id, key)
    }
  }

  return { menu, openMenu, closeMenu, menuActions, onMenuAction }
}
