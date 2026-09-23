<script setup lang="ts">
/**
 * 任务卡:频道(负责人)/子任务数/交付物 + 标题 + 路由理由 + 进度条 + 状态胶囊。
 *
 * 纯展示 + 事件上抛:点卡 = 打开详情;点胶囊 = 打开状态菜单(stopPropagation,
 * 与卡片点击区分);拖拽的开始/结束原样上抛,由容器(useTaskBoardDrag)接管。
 */
import type { TaskView } from '@/app/stores/workshop/entities'

defineProps<{
  task: TaskView
  /** 所属列标题(状态胶囊文案) */
  columnTitle: string
  /** 所属列色调(状态胶囊文字/边框;随列而非随任务态) */
  columnDot: string
  /** 是否正在被拖起(源卡半透明) */
  dragging: boolean
  /** 负责人显示名(容器解析:已知成员取名字,否则 id 前 6 位) */
  agentName: string
  /** 子任务数(0 不显示) */
  childCount: number
}>()

const emit = defineEmits<{
  (e: 'dragStart', ev: DragEvent): void
  (e: 'dragEnd'): void
  (e: 'open', task: TaskView): void
  (e: 'openMenu', ev: MouseEvent): void
}>()
</script>

<template>
  <div
    class="card task"
    :class="{ dragging }"
    draggable="true"
    @dragstart="emit('dragStart', $event)"
    @dragend="emit('dragEnd')"
    @click="emit('open', task)"
  >
    <div class="tk-chan">
      <span>#{{ agentName }}</span>
      <span
        v-if="childCount"
        class="tk-num"
      >{{ $t('taskBoardView.k4b1x005') }} {{ childCount }}</span>
      <span
        v-if="task.artifacts"
        class="tk-num"
      ><span class="i-tabler-package" /> {{ task.artifacts }}</span>
    </div>
    <div class="tk-title">
      {{ task.title }}
    </div>
    <div
      v-if="task.routeReason"
      class="tk-route"
      :title="$t('taskBoardView.k8m7hm6020', { p0: task.routeReason })"
    >
      ↳ {{ task.routeReason }}
    </div>
    <a-progress
      v-if="task.state === 'WORKING' && task.progress > 0"
      :percent="task.progress"
      size="small"
      :show-info="false"
    />
    <div class="tk-foot">
      <button
        type="button"
        class="st-pill-btn"
        @click.stop="emit('openMenu', $event)"
      >
        <span
          class="st-pill"
          :style="{ color: columnDot, borderColor: columnDot }"
        >{{ columnTitle }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 任务卡与状态胶囊的规则从 TaskBoardView.vue 逐字搬来(标记现在归本组件所有,scoped 必须同址)。 */

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
  color: var(--ink-faint);
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

/* 状态胶囊:hairline pill,色调随列。
   ⚠️ .st-pill 与 task-board/List.vue 的 scoped 块有意重复(列表行也用它显示状态),
   改这里必须同步改 List.vue。 */
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

/* 窄屏(≤1023.98):完整说明见 TaskBoardView.vue 的同名媒体查询;此处只保留属于本组件标记的规则 */
@media (max-width: 1023.98px) {
  /* 有意重复:与 Column.vue / List.vue 的窄屏「字号地板」是同一条声明 */
  .tk-route,
  .st-pill {
    font-size: 11.5px;
  }

  .st-pill-btn {
    min-height: 40px;
  }
}
</style>
