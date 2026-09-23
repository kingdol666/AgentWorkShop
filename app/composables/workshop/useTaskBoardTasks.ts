/**
 * useTaskBoardTasks —— 任务板的实体读取与动作面(每个 TaskBoardView 实例一份,非模块级单例):
 *  - tasks/synced 取自 entities store(channelId 作用域);快照未到达时 synced=false,
 *    空态据此显示「同步中」而不是误判「没有任务」;
 *  - optimistic:taskId → 预期 state 的乐观覆盖层(REST 进行中;WS 事件确认后由实体覆盖);
 *  - applyMove:cancel/retry 的唯一出口(拖拽落列与状态胶囊菜单共用同一动作面):
 *    先乐观预移,REST 失败回滚并弹错,完成后短暂清理乐观层交给 WS/实体收敛。
 */
import { computed, ref, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { useEntitiesStore, type TaskView } from '@/app/stores/workshop/entities'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'

export function useTaskBoardTasks(channelId: Ref<string>) {
  const { t } = useI18n()

  const entities = useEntitiesStore()
  const api = useWorkshopApi()

  const tasks = computed(() => entities.tasks[channelId.value] ?? [])
  /** 实体快照是否已到达(未到时空态显示同步中,不误判"没有任务") */
  const synced = computed(() => entities.channels[channelId.value] !== undefined
    || entities.tasks[channelId.value] !== undefined)

  /** 乐观覆盖:taskId → 预期 state(REST 进行中;WS 确认后由实体覆盖) */
  const optimistic = ref(new Map<string, string>())
  const mergedTasks = computed<TaskView[]>(() =>
    tasks.value.map(t => (optimistic.value.has(t.id) ? { ...t, state: optimistic.value.get(t.id)! } : t)),
  )

  const taskById = (id: string): TaskView | undefined => mergedTasks.value.find(t => t.id === id)

  // ===== 动作面(拖拽与胶囊菜单共用) =====
  const acting = ref(new Set<string>())
  const applyMove = async (taskId: string, action: 'cancel' | 'retry'): Promise<void> => {
    if (acting.value.has(taskId)) return
    const task = taskById(taskId)
    if (!task) return
    acting.value.add(taskId)
    const prev = task.state
    // 乐观预移:cancel → CANCELED;retry → ASSIGNED
    const next = action === 'cancel' ? 'CANCELED' : 'ASSIGNED'
    const opt = new Map(optimistic.value)
    opt.set(taskId, next)
    optimistic.value = opt
    try {
      await (action === 'cancel' ? api.cancelTask(taskId) : api.retryTask(taskId))
      message.success(action === 'cancel' ? t('taskBoardView.k189y4q013') : t('taskBoardView.kv1l1j3014'))
    }
    catch (e) {
      // 回滚乐观预移,弹错(WS 事件为准)
      const revert = new Map(optimistic.value)
      revert.set(taskId, prev)
      optimistic.value = revert
      const err = e as { data?: { message?: string }, message?: string }
      message.error(apiErrorMessage(err, t('taskBoardView.k1e7zwuc015')))
    }
    finally {
      acting.value.delete(taskId)
      // REST 完成后短暂清理乐观层,交给 WS/实体收敛
      setTimeout(() => {
        const clean = new Map(optimistic.value)
        clean.delete(taskId)
        optimistic.value = clean
      }, 4000)
    }
  }

  return { synced, mergedTasks, taskById, applyMove }
}
