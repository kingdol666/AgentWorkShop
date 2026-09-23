<script setup lang="ts">
/**
 * 列表视图:按状态分组(分组头 + 行式任务),与看板共用同一份列模型(columns)。
 * 行内保持四项(标题/成员/ID/状态)不竖排;点击行 = 打开详情(上抛给容器)。
 */
import type { TaskView } from '@/app/stores/workshop/entities'
import type { TaskBoardColumn } from '@/app/composables/workshop/useTaskBoardColumns'

defineProps<{
  columns: TaskBoardColumn[]
  /** 负责人显示名解析(容器注入) */
  agentName: (id: string) => string
  /** 状态文案(容器注入,与看板同源) */
  stateOf: (t: TaskView) => string
}>()

const emit = defineEmits<{ (e: 'open', task: TaskView): void }>()
</script>

<template>
  <div class="task-list">
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
        v-for="task in col.items"
        :key="task.id"
        class="list-row"
        @click="emit('open', task)"
      >
        <span class="grow">{{ task.title }}</span>
        <span class="lnum">#{{ agentName(task.assigneeId) }}</span>
        <span class="meta">{{ task.id.slice(0, 8) }}</span>
        <span
          class="st-pill"
          :style="{ color: col.dot, borderColor: col.dot }"
        >
          {{ stateOf(task) }}
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 列表视图的规则从 TaskBoardView.vue 逐字搬来(标记现在归本组件所有,scoped 必须同址)。 */
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
  color: var(--ink-faint);
}

/* ⚠️ .sec / .sec-title / .sec-cnt / .st-dot / .st-pill 与 task-board/Column.vue、Card.vue
   的 scoped 块有意重复(列表分组头沿用看板列头类名,列表行沿用状态胶囊类名):
   scoped 样式不能外移成公共 css —— 逐字复制,改这里必须同步改那两个组件。 */
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

/* ── 窄屏(≤1023.98):完整说明见 TaskBoardView.vue 的同名媒体查询;
   此处只保留属于本组件标记的规则。 */
@media (max-width: 1023.98px) {
  /* 有意重复:与 Column.vue / Card.vue 的窄屏「字号地板」是同一条声明 */
  .sec-cnt,
  .meta,
  .st-pill {
    font-size: 11.5px;
  }

  /* 行内四项(标题/成员/ID/状态)在 370px 下必然挤:允许折行,不允许压成竖排 */
  .list-row {
    flex-wrap: wrap;
    row-gap: 4px;
    min-height: 44px;
  }

  .list-row .grow {
    flex: 1 1 60%;
  }
}
</style>
