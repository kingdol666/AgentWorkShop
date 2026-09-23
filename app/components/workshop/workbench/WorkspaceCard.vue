<script setup lang="ts">
/**
 * workspace 卡片:名称 + channel 实时摘要行 + 进入/删除操作。
 * 无状态展示件:摘要行(channelSummary 的产物)与 workspace 均由页面算好传入,
 * 卡片只发事件 —— 导航与删除都留在页面编排层,与拆分前同一实现。
 */
import type { WorkspaceChannelSummary } from '@/app/pages/workshop/composables/useWorkbenchWorkspaces'
import type { WorkspaceMeta } from '@/app/stores/workshop/workspaces'

defineProps<{
  workspace: WorkspaceMeta
  /** channelSummary(workspace.channelIds):行内计数与"同步中"判据 */
  channels: WorkspaceChannelSummary[]
}>()

/** 注意:必须把 defineEmits 的返回值赋给 emit —— 模板里的 `emit(...)` 才解析得到(setup 绑定) */
const emit = defineEmits<{
  open: [id: string]
  remove: [id: string]
}>()
</script>

<template>
  <div class="card">
    <div class="card-head">
      <span class="card-mark"><span class="i-tabler-box" /></span>
      <span class="name">{{ workspace.name }}</span>
    </div>
    <div class="card-body">
      <div
        v-for="ch in channels"
        :key="ch.id"
        class="ch-row"
        @click="emit('open', workspace.id)"
      >
        <span
          class="dot"
          :class="{ live: ch.activeTasks > 0 }"
        />
        <span class="ch-name">{{ ch.name }}</span>
        <span class="ch-meta">
          <template v-if="ch.synced">{{ ch.agents }} {{ $t('wsHome.k1ggoa45028') }} {{ ch.busy }} / {{ $t('wsHome.k3wcox029') }} {{ ch.activeTasks }}</template>
          <template v-else>{{ $t('wsHome.k1bst7s9016') }}</template>
        </span>
      </div>
      <div
        v-if="workspace.channelIds.length === 0"
        class="empty"
      >
        {{ $t('wsHome.k1ylgrbc017') }}
      </div>
    </div>
    <div class="card-foot">
      <button
        class="aw-pill outline im"
        @click="emit('open', workspace.id)"
      >
        <span class="i-tabler-arrow-right im-pop" />
        {{ $t('wsHome.kr1uwwi018') }}
      </button>
      <button
        class="aw-ghost im"
        :title="$t('wsHome.delWs')"
        @click.stop="emit('remove', workspace.id)"
      >
        <span class="i-tabler-trash im-shake" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 卡片的规则从 app/pages/workshop/index.vue 逐字搬来(卡片标记现在归本组件所有,
   scoped 编译成 .x[data-v-<scopeId>],样式必须与标记同址)。
   .card / .grid 的网格外壳留在页面(.grid 是页面自己的元素);
   .card.placeholder / .big / .op 拆分前就已无标记引用,按"逐条在场"原样携带,不新增也不删除。 */

/* 卡片头:软方块 mark + serif 名称 */
.card-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  font-size: 15px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border-radius: var(--radius-panel-sm);
}

.card-head .name {
  font-family: var(--font-display);
  font-size: 17px;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.card-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
}

/* 工作台卡片:图纸面板 + 硬边投影,悬停时"浮起" */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-card);
  transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
}

.card:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.card.placeholder {
  align-items: center;
  justify-content: center;
  min-height: 160px;
  font-size: 13px;
  opacity: 0.55;
  cursor: pointer;
  border-style: dashed;
}

.big { font-size: 28px; }

.card-head {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 15px;
}

.card-head > :first-child { color: var(--accent-cobalt); }

.name {
  flex: 1 1 auto;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
}

.op { cursor: pointer; opacity: 0.4; }
.op:hover { opacity: 1; }

.card-body { flex: 1 1 auto; min-height: 40px; }

.ch-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 7px;
  margin: 2px 0;
  font-size: 12px;
  cursor: pointer;
  border-radius: var(--radius-panel);
  transition: background 0.15s ease, transform 0.15s ease;
}

.ch-row:hover {
  background: color-mix(in srgb, var(--accent-cobalt) 7%, transparent);
  transform: translateX(2px);
}

.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: var(--line-strong);
  border-radius: 50%;
}

.dot.live { background: var(--accent-moss); box-shadow: 0 0 6px var(--accent-moss); }

.ch-name { flex: 0 0 auto; font-weight: 600; }
.ch-meta {
  flex: 1 1 auto;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  opacity: 0.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty { padding: 12px 6px; font-size: 12px; opacity: 0.4; }
</style>
