<script setup lang="ts">
/**
 * 任务板(open-tag TaskBoard 交互移植,按 AgentWorkShop 权限模型收敛):
 *  - 看板/列表双视图(localStorage 持久化);看板 = 全高等宽泳道(surface-strong),
 *    列表 = 按状态分组的行式列表;
 *  - 卡片拖拽:拖到「异常/取消」列 = cancelTask(HITL 中断);FAILED/CANCELED 卡拖回
 *    「待启动」列 = retryTask(重试派发);执行中/等待汇总/已完成由系统流转,不可手动移入;
 *  - 状态胶囊点击菜单:取消 / 重试 / 打开详情(与拖拽同一动作面);
 *  - 乐观更新:本地先改 state(FLIP 视觉即时),REST 失败回滚并以 WS 事件对齐。
 */
import { message } from 'ant-design-vue'
import { useEntitiesStore, type TaskView } from '@/app/stores/workshop/entities'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'openTask', taskId: string): void }>()

const entities = useEntitiesStore()
const api = useWorkshopApi()
const tasks = computed(() => entities.tasks[props.channelId] ?? [])
/** 实体快照是否已到达(未到时空态显示同步中,不误判"没有任务") */
const synced = computed(() => entities.channels[props.channelId] !== undefined
  || entities.tasks[props.channelId] !== undefined)

/** 乐观覆盖:taskId → 预期 state(REST 进行中;WS 确认后由实体覆盖) */
const optimistic = ref(new Map<string, string>())
const mergedTasks = computed<TaskView[]>(() =>
  tasks.value.map(t => (optimistic.value.has(t.id) ? { ...t, state: optimistic.value.get(t.id)! } : t)),
)

interface Column {
  key: string
  title: string
  states: string[]
  dot: string
  /** 允许用户手动移入该列的动作(null = 系统流转列) */
  moveAction: 'cancel' | 'retry' | null
  items: TaskView[]
}

const BASE_COLUMNS: Array<Omit<Column, 'items'>> = [
  { key: 'todo', title: '待启动', states: ['SUBMITTED', 'ASSIGNED'], dot: 'var(--tone-neutral-dot)', moveAction: 'retry' },
  { key: 'doing', title: '执行中', states: ['WORKING'], dot: 'var(--tone-info-dot)', moveAction: null },
  { key: 'waiting', title: '等待汇总', states: ['WAITING'], dot: 'var(--tone-warning-dot)', moveAction: null },
  { key: 'done', title: '已完成', states: ['COMPLETED'], dot: 'var(--tone-success-dot)', moveAction: null },
  { key: 'bad', title: '异常/取消', states: ['FAILED', 'CANCELED'], dot: 'var(--tone-danger-dot)', moveAction: 'cancel' },
]

const columns = computed<Column[]>(() => BASE_COLUMNS.map(col => ({
  ...col,
  items: mergedTasks.value.filter(t => col.states.includes(t.state)),
})))

const agentName = (id: string): string =>
  entities.agentById(props.channelId, id)?.name ?? id.slice(0, 6)
const childCount = (id: string): number =>
  mergedTasks.value.filter(t => t.parentId === id).length

const stateOf = (t: TaskView): string => t.state

// ===== 视图切换(看板/列表,持久化) =====
const layout = ref<'board' | 'list'>(
  (import.meta.client && localStorage.getItem('aw.tasks.boardLayout') === 'list') ? 'list' : 'board',
)
const setLayout = (l: 'board' | 'list') => {
  layout.value = l
  if (import.meta.client) localStorage.setItem('aw.tasks.boardLayout', l)
}

// ===== 拖拽(HTML5 DnD;整列作为放置目标) =====
const dragId = ref<string | null>(null)
const dragFrom = ref<string | null>(null)
const dropOver = ref<string | null>(null)

const taskById = (id: string): TaskView | undefined => mergedTasks.value.find(t => t.id === id)

/** 该卡是否允许移入该列(动作存在且目标态 ≠ 当前态) */
const canDrop = (taskId: string, col: Column): boolean => {
  if (!col.moveAction) return false
  const t = taskById(taskId)
  if (!t) return false
  if (col.states.includes(t.state)) return false
  if (col.moveAction === 'retry') return ['FAILED', 'CANCELED'].includes(t.state)
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
const onDragOver = (ev: DragEvent, col: Column) => {
  if (!dragId.value || !canDrop(dragId.value, col)) return
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
}
const onDragLeave = (colKey: string) => {
  if (dropOver.value === colKey) dropOver.value = null
}
const onDragOverCol = (ev: DragEvent, col: Column) => {
  dropOver.value = col.key
  onDragOver(ev, col)
}
const onDragEnd = () => {
  dragId.value = null
  dragFrom.value = null
  dropOver.value = null
}
/** 列样式态:可放 = 蓝调高亮;不可放 = 压暗;拖出来源列 = 微降透明 */
const colClasses = (col: Column): Record<string, boolean> => ({
  'drop-over': dropOver.value === col.key && !!dragId.value && canDrop(dragId.value, col),
  'no-drop': !!dragId.value && dropOver.value === col.key && !canDrop(dragId.value, col),
  'drag-origin': dragFrom.value === col.key,
})
const onDrop = async (ev: DragEvent, col: Column) => {
  ev.preventDefault()
  const id = dragId.value
  dropOver.value = null
  dragId.value = null
  dragFrom.value = null
  if (!id || !canDrop(id, col)) return
  await applyMove(id, col.moveAction!)
}

// ===== 动作面(拖拽与胶囊菜单共用) =====
const acting = ref(new Set<string>())
const applyMove = async (taskId: string, action: 'cancel' | 'retry'): Promise<void> => {
  if (acting.value.has(taskId)) return
  const t = taskById(taskId)
  if (!t) return
  acting.value.add(taskId)
  const prev = t.state
  // 乐观预移:cancel → CANCELED;retry → ASSIGNED
  const next = action === 'cancel' ? 'CANCELED' : 'ASSIGNED'
  const opt = new Map(optimistic.value)
  opt.set(taskId, next)
  optimistic.value = opt
  try {
    await (action === 'cancel' ? api.cancelTask(taskId) : api.retryTask(taskId))
    message.success(action === 'cancel' ? '已请求取消任务' : '任务已重新派发')
  }
  catch (e) {
    // 回滚乐观预移,弹错(WS 事件为准)
    const revert = new Map(optimistic.value)
    revert.set(taskId, prev)
    optimistic.value = revert
    const err = e as { data?: { message?: string }, message?: string }
    message.error(err?.data?.message ?? err?.message ?? '操作失败')
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

/** 状态胶囊菜单(动作 + 详情);fixed 定位并按视口收敛 */
const menu = ref<{ task: TaskView, x: number, y: number } | null>(null)
const openMenu = (ev: MouseEvent, t: TaskView) => {
  const x = Math.min(ev.clientX, Math.max(window.innerWidth - 156, 8))
  const y = Math.min(ev.clientY, Math.max(window.innerHeight - 160, 8))
  menu.value = { task: t, x, y }
}
const closeMenu = () => {
  menu.value = null
}
const menuActions = computed(() => {
  const t = menu.value?.task
  if (!t) return []
  const acts: Array<{ key: 'cancel' | 'retry' | 'detail', label: string, danger?: boolean }> = []
  if (['SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING', 'FAILED'].includes(t.state)) {
    acts.push({ key: 'cancel', label: '取消任务', danger: true })
  }
  if (['FAILED', 'CANCELED'].includes(t.state)) {
    acts.push({ key: 'retry', label: '重试派发' })
  }
  acts.push({ key: 'detail', label: '打开详情' })
  return acts
})
const onMenuAction = async (key: 'cancel' | 'retry' | 'detail') => {
  const t = menu.value?.task
  closeMenu()
  if (!t) return
  if (key === 'detail') {
    emit('openTask', t.id)
  }
  else {
    await applyMove(t.id, key)
  }
}
</script>

<template>
  <div class="board-shell">
    <!-- 工具条:视图切换 + 计数 -->
    <div class="toolbar">
      <div class="aw-seg">
        <button
          type="button"
          :class="{ on: layout === 'board' }"
          @click="setLayout('board')"
        >
          看板
        </button>
        <button
          type="button"
          :class="{ on: layout === 'list' }"
          @click="setLayout('list')"
        >
          列表
        </button>
      </div>
      <span class="count">{{ mergedTasks.length }} 任务 · 拖拽卡片到「异常/取消」取消,失败任务拖回「待启动」重试</span>
    </div>

    <!-- 空态(快照未到 → 同步中,不误判为空) -->
    <div
      v-if="mergedTasks.length === 0"
      class="pane-empty"
    >
      <span :class="synced ? 'pe-icon i-tabler-list-check' : 'pe-icon i-tabler-refresh'" />
      <div class="pe-title">
        {{ synced ? '还没有' : '正在同步' }} <span class="aw-serif-accent-italic">任务</span>
      </div>
      <div class="pe-sub">
        {{ synced ? '在下方 Composer 提交首个任务(首行标题,支持 goal / loop / pipeline 模式)' : '任务快照对齐后自动呈现' }}
      </div>
    </div>

    <!-- 看板:全高等宽泳道 -->
    <div
      v-else-if="layout === 'board'"
      class="board"
    >
      <div
        v-for="col in columns"
        :key="col.key"
        class="task-col"
        :class="colClasses(col)"
        @dragover="onDragOverCol($event, col)"
        @dragleave="onDragLeave(col.key)"
        @drop="onDrop($event, col)"
      >
        <div class="sec">
          <span
            class="st-dot"
            :style="{ background: col.dot }"
          />
          <span class="sec-title">{{ col.title }}</span>
          <span class="sec-cnt">{{ col.items.length }}</span>
        </div>
        <div class="task-col-body">
          <div
            v-for="t in col.items"
            :key="t.id"
            class="card task"
            :class="{ dragging: dragId === t.id }"
            draggable="true"
            @dragstart="onDragStart($event, t, col.key)"
            @dragend="onDragEnd"
            @click="emit('openTask', t.id)"
          >
            <div class="tk-chan">
              <span>#{{ agentName(t.assigneeId) }}</span>
              <span
                v-if="childCount(t.id)"
                class="tk-num"
              >子 {{ childCount(t.id) }}</span>
              <span
                v-if="t.artifacts"
                class="tk-num"
              ><span class="i-tabler-package" /> {{ t.artifacts }}</span>
            </div>
            <div class="tk-title">
              {{ t.title }}
            </div>
            <div
              v-if="t.routeReason"
              class="tk-route"
              :title="`路由理由:${t.routeReason}`"
            >
              ↳ {{ t.routeReason }}
            </div>
            <a-progress
              v-if="t.state === 'WORKING' && t.progress > 0"
              :percent="t.progress"
              size="small"
              :show-info="false"
            />
            <div class="tk-foot">
              <button
                type="button"
                class="st-pill-btn"
                @click.stop="openMenu($event, t)"
              >
                <span
                  class="st-pill"
                  :style="{ color: col.dot, borderColor: col.dot }"
                >{{ col.title }}</span>
              </button>
            </div>
          </div>
          <div
            v-if="col.items.length === 0"
            class="col-empty"
          >
            {{ col.moveAction ? '拖入此处执行该动作' : '-' }}
          </div>
        </div>
      </div>
    </div>

    <!-- 列表:按状态分组 -->
    <div
      v-else
      class="task-list"
    >
      <template
        v-for="col in columns"
        :key="col.key"
      >
        <div
          v-if="col.items.length"
          class="list-sec sec"
        >
          <span
            class="st-dot"
            :style="{ background: col.dot }"
          />
          <span class="sec-title">{{ col.title }}</span>
          <span class="sec-cnt">{{ col.items.length }}</span>
        </div>
        <div
          v-for="t in col.items"
          :key="t.id"
          class="list-row"
          @click="emit('openTask', t.id)"
        >
          <span class="grow">{{ t.title }}</span>
          <span class="lnum">#{{ agentName(t.assigneeId) }}</span>
          <span class="meta">{{ t.id.slice(0, 8) }}</span>
          <span
            class="st-pill"
            :style="{ color: col.dot, borderColor: col.dot }"
          >
            {{ stateOf(t) }}
          </span>
        </div>
      </template>
    </div>

    <!-- 状态菜单(fixed 定位,随点击点) -->
    <template v-if="menu">
      <div
        class="menu-backdrop"
        @click="closeMenu"
        @scroll="closeMenu"
      />
      <div
        class="st-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      >
        <button
          v-for="a in menuActions"
          :key="a.key"
          type="button"
          :class="{ danger: a.danger }"
          @click="onMenuAction(a.key)"
        >
          <span
            :class="a.key === 'cancel'
              ? 'i-tabler-circle-off'
              : a.key === 'retry' ? 'i-tabler-rotate' : 'i-tabler-external-link'"
          />
          {{ a.label }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.board-shell {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  animation: view-in 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes view-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .board-shell { animation: none; }
}

.toolbar {
  display: flex;
  flex: 0 0 auto;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
}
.count {
  overflow: hidden;
  font-size: 11.5px;
  color: var(--ink-fainter);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 看板:全高等宽泳道(surface-strong 软底,白卡浮于其上) */
.board {
  overscroll-behavior: contain;
  display: flex;
  flex: 1 1 auto;
  gap: 12px;
  align-items: stretch;
  min-height: 0;
  padding: 12px 14px 14px;
  overflow-x: auto;
}
.task-col {
  display: flex;
  flex: 0 0 300px;
  flex-direction: column;
  min-width: 280px;
  min-height: 0;
  padding: 2px 8px 8px;
  background: var(--paper-deep);
  border-radius: var(--radius-panel);
}
.task-col.drop-over {
  background: var(--tone-info-bg);
  outline: 2px dashed color-mix(in srgb, var(--tone-info-dot) 65%, transparent);
  outline-offset: -2px;
}
.task-col.no-drop { opacity: 0.6; }
.task-col.drag-origin { opacity: 0.85; }
.sec {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 10px 6px 8px;
}
.sec-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ink-soft);
}
.sec-cnt {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-fainter);
}
.st-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.task-col-body {
  overscroll-behavior: contain;
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 2px;
  overflow-y: auto;
}

/* 任务卡:白卡 + 悬停微抬(open-tag card.task) */
.card.task {
  position: relative;
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  transition: transform 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}
.card.task:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.card.task.dragging {
  opacity: 0.45;
  cursor: grabbing;
}
.tk-chan {
  display: flex;
  gap: 8px;
  font-size: 11.5px;
  color: var(--ink-faint);
}
.tk-num {
  font-variant-numeric: tabular-nums;
  color: var(--ink-fainter);
}
.tk-title {
  display: -webkit-box;
  overflow: hidden;
  margin: 3px 0 6px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--ink);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.tk-route {
  overflow: hidden;
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-foot {
  display: flex;
  justify-content: flex-end;
}
.col-empty {
  padding: 14px 8px;
  font-size: 11.5px;
  color: var(--ink-fainter);
  text-align: center;
  border: 1.5px dashed var(--line-strong);
  border-radius: var(--radius-panel);
}

/* 状态胶囊:hairline pill,色调随列 */
.st-pill-btn {
  padding: 0;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.st-pill {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 1px 9px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.st-pill-btn:hover .st-pill { background: var(--hover-tint); }

/* 列表视图 */
.task-list {
  overscroll-behavior: contain;
  flex: 1 1 auto;
  min-height: 0;
  padding: 10px 16px 18px;
  overflow-y: auto;
}
.list-sec { padding: 8px 2px 6px; }
.list-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 9px 12px;
  margin-bottom: 4px;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  transition: border-color 0.12s ease;
}
.list-row:hover { border-color: var(--line-strong); }
.list-row .grow {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13.5px;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lnum {
  font-size: 12px;
  color: var(--ink-faint);
}
.meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-fainter);
}

/* 状态菜单 */
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.st-menu {
  position: fixed;
  z-index: 61;
  min-width: 128px;
  padding: 4px;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel-sm);
  box-shadow: var(--shadow-float);
}
.st-menu button {
  display: flex;
  gap: 7px;
  align-items: center;
  width: 100%;
  padding: 6px 9px;
  font-family: var(--font-body);
  font-size: 12.5px;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
}
.st-menu button:hover { background: var(--paper-deep); color: var(--ink); }
.st-menu button.danger { color: var(--tone-danger-dot); }
</style>
