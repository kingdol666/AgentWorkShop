<script setup lang="ts">
/**
 * 看板泳道(列):列头(色调点/标题/计数)+ 卡片栈 + 空列提示。
 *
 * 自身不持状态:dragId 与列样式态由容器算好后传入;拖拽一律上抛事件,由容器统一裁决
 * (可放判定与落列动作全仓只有一份,见 useTaskBoardDrag)—— 子组件只负责标记。
 */
import type { TaskView } from '@/app/stores/workshop/entities'
import type { TaskBoardColumn } from '@/app/composables/workshop/useTaskBoardColumns'
import TaskBoardCard from '@/app/components/workshop/task-board/Card.vue'

defineProps<{
  col: TaskBoardColumn
  /** 当前被拖起的卡 id(未拖拽 = null) */
  dragId: string | null
  /** 列样式态(drop-over / no-drop / drag-origin;由容器的 colClasses 计算) */
  classes: Record<string, boolean>
  /** 负责人显示名解析(容器注入) */
  agentName: (id: string) => string
  /** 子任务数解析(容器注入;乐观覆盖层也算在内) */
  childCount: (id: string) => number
}>()

const emit = defineEmits<{
  (e: 'dragStart', ev: DragEvent, task: TaskView, colKey: string): void
  (e: 'dragEnd'): void
  (e: 'dragOver' | 'drop', ev: DragEvent, col: TaskBoardColumn): void
  (e: 'dragLeave', colKey: string): void
  (e: 'open', task: TaskView): void
  (e: 'openMenu', ev: MouseEvent, task: TaskView): void
}>()
</script>

<template>
  <div
    class="task-col"
    :class="classes"
    @dragover="emit('dragOver', $event, col)"
    @dragleave="emit('dragLeave', col.key)"
    @drop="emit('drop', $event, col)"
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
      <TaskBoardCard
        v-for="task in col.items"
        :key="task.id"
        :task="task"
        :column-title="col.title"
        :column-dot="col.dot"
        :dragging="dragId === task.id"
        :agent-name="agentName(task.assigneeId)"
        :child-count="childCount(task.id)"
        @drag-start="emit('dragStart', $event, task, col.key)"
        @drag-end="emit('dragEnd')"
        @open="emit('open', $event)"
        @open-menu="emit('openMenu', $event, task)"
      />
      <div
        v-if="col.items.length === 0"
        class="col-empty"
      >
        {{ col.moveAction ? $t('taskBoardView.k13pad50007') : '-' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 泳道与列头的规则从 TaskBoardView.vue 逐字搬来(标记现在归本组件所有,scoped 必须同址)。 */
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

/* ⚠️ .sec / .sec-title / .sec-cnt / .st-dot 与 task-board/List.vue 的 scoped 块有意重复:
   看板列头与列表分组头共用同一套类名,scoped 样式不能外移成公共 css —— 逐字复制,
   改这里必须同步改 List.vue。 */
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
  color: var(--ink-faint);
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
.col-empty {
  padding: 14px 8px;
  font-size: 11.5px;
  color: var(--ink-faint);
  text-align: center;
  border: 1.5px dashed var(--line-strong);
  border-radius: var(--radius-panel);
}

/* ── 窄屏(≤1023):看板列从"全高等宽四列"改为"一次一列"的横向卷轴 ──
   完整说明见 TaskBoardView.vue 的同名媒体查询;此处只保留属于本组件标记的规则。 */
@media (max-width: 1023.98px) {
  /* 有意重复:与 Card.vue / List.vue 的窄屏「字号地板」是同一条声明 */
  .sec-cnt {
    font-size: 11.5px;
  }

  .task-col {
    flex: 0 0 86%;
    min-width: 0;
    scroll-snap-align: center;
  }
}
</style>
