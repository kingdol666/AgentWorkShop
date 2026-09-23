<script setup lang="ts">
/**
 * 任务板(open-tag TaskBoard 交互移植,按 AgentWorkShop 权限模型收敛):
 *  - 看板/列表双视图(localStorage 持久化);看板 = 全高等宽泳道(surface-strong),
 *    列表 = 按状态分组的行式列表;
 *  - 卡片拖拽:拖到「异常/取消」列 = cancelTask(HITL 中断);FAILED/CANCELED 卡拖回
 *    「待启动」列 = retryTask(重试派发);执行中/等待汇总/已完成由系统流转,不可手动移入;
 *  - 状态胶囊点击菜单:取消 / 重试 / 打开详情(与拖拽同一动作面);
 *  - 乐观更新:本地先改 state(FLIP 视觉即时),REST 失败回滚并以 WS 事件对齐。
 *
 * 本文件只做编排(状态 + 选路 + 把事件接到动作面):
 *  - 状态与动作面 → app/composables/workshop/useTaskBoard{Tasks,Columns,Drag,Menu}.ts;
 *  - 标记与其 scoped 规则 → app/components/workshop/task-board/{Column,Card,List,StatusMenu}.vue
 *    (父组件的 scoped 样式不会作用于子组件内部标记,样式必须与拥有它的标记同址);
 *  - 对外接口不变:props { channelId } + emit openTask(被 console/CenterPane.vue 使用)。
 */
import { useTaskBoardTasks } from '@/app/composables/workshop/useTaskBoardTasks'
import { useTaskBoardColumns } from '@/app/composables/workshop/useTaskBoardColumns'
import { useTaskBoardDrag } from '@/app/composables/workshop/useTaskBoardDrag'
import { useTaskBoardMenu } from '@/app/composables/workshop/useTaskBoardMenu'
import TaskBoardColumn from '@/app/components/workshop/task-board/Column.vue'
import TaskBoardList from '@/app/components/workshop/task-board/List.vue'
import TaskBoardStatusMenu from '@/app/components/workshop/task-board/StatusMenu.vue'

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'openTask', taskId: string): void }>()

const channelId = toRef(props, 'channelId')

const { synced, mergedTasks, taskById, applyMove } = useTaskBoardTasks(channelId)
const { columns, agentName, childCount, stateOf } = useTaskBoardColumns(channelId, mergedTasks)
const { dragId, onDragStart, onDragLeave, onDragOverCol, onDragEnd, colClasses, onDrop }
  = useTaskBoardDrag({ taskById, applyMove })
const { menu, openMenu, closeMenu, menuActions, onMenuAction } = useTaskBoardMenu({
  applyMove,
  openTask: (taskId: string): void => { emit('openTask', taskId) },
})

// ===== 视图切换(看板/列表,持久化) =====
const layout = ref<'board' | 'list'>(
  (import.meta.client && localStorage.getItem('aw.tasks.boardLayout') === 'list') ? 'list' : 'board',
)
const setLayout = (l: 'board' | 'list') => {
  layout.value = l
  if (import.meta.client) localStorage.setItem('aw.tasks.boardLayout', l)
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
          {{ $t('taskBoardView.k43pyn001') }}
        </button>
        <button
          type="button"
          :class="{ on: layout === 'list' }"
          @click="setLayout('list')"
        >
          {{ $t('taskBoardView.k3x7l0002') }}
        </button>
      </div>
      <span class="count">{{ mergedTasks.length }} {{ $t('taskBoardView.k168w1ze004') }}</span>
    </div>

    <!-- 空态(快照未到 → 同步中,不误判为空) -->
    <div
      v-if="mergedTasks.length === 0"
      class="pane-empty"
    >
      <span :class="synced ? 'pe-icon i-tabler-list-check' : 'pe-icon i-tabler-refresh'" />
      <div class="pe-title">
        {{ synced ? $t('taskBoardView.k3vkhhj006') : $t('taskBoardView.k1f9c17l019') }} <span class="aw-serif-accent-italic">{{ $t('taskBoardView.k3wcox003') }}</span>
      </div>
      <div class="pe-sub">
        {{ synced ? $t('taskBoardView.emptySubNew') : $t('taskBoardView.emptySubSync') }}
      </div>
    </div>

    <!-- 看板:全高等宽泳道(列 = 泳道子组件;拖拽裁决在容器) -->
    <div
      v-else-if="layout === 'board'"
      class="board"
    >
      <TaskBoardColumn
        v-for="col in columns"
        :key="col.key"
        :col="col"
        :drag-id="dragId"
        :classes="colClasses(col)"
        :agent-name="agentName"
        :child-count="childCount"
        @drag-start="onDragStart"
        @drag-end="onDragEnd"
        @drag-over="onDragOverCol"
        @drag-leave="onDragLeave"
        @drop="onDrop"
        @open="emit('openTask', $event.id)"
        @open-menu="openMenu"
      />
    </div>

    <!-- 列表:按状态分组 -->
    <TaskBoardList
      v-else
      :columns="columns"
      :agent-name="agentName"
      :state-of="stateOf"
      @open="emit('openTask', $event.id)"
    />

    <!-- 状态菜单(fixed 定位,随点击点) -->
    <TaskBoardStatusMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :actions="menuActions"
      @close="closeMenu"
      @action="onMenuAction"
    />
  </div>
</template>

<style scoped>
/* 本块的规则只作用于本组件自己的标记(外壳/工具条/看板滚动容器与空态);
   列/卡片/列表/菜单的规则随标记搬进 app/components/workshop/task-board/ 各子组件的
   scoped 块 —— scoped 不能外移成公共 css。 */
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
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 看板:全高等宽泳道(surface-strong 软底,白卡浮于其上);泳道本体样式在 task-board/Column.vue */
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

/* ── 窄屏(≤1023):看板列从"全高等宽四列"改为"一次一列"的横向卷轴 ──
   300px 定宽列在 390px 下只能露出半列 + 半列,状态语义读不出来;
   改为 86% 宽 + scroll-snap:一屏一个状态列。列表视图行允许折行,不竖排。
   本块只留外壳/工具条/看板滚动容器;列/卡片/列表/菜单的窄屏规则在各自子组件里。 */
@media (max-width: 1023.98px) {
  .toolbar {
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px;
  }

  /* 有意重复:原 `.count, .sec-cnt, .tk-route, .meta, .st-pill` 是一条分组选择器,
     标记分散到子组件后按各自 scoped 块逐字复制同一条「窄屏字号地板」——
     不要合并成公共 css。 */
  .count {
    font-size: 11.5px;
  }

  .board {
    padding: 10px;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
  }
}
</style>
